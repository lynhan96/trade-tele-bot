import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import { TelegramBotService } from "../telegram/telegram.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { UserTrade, UserTradeDocument } from "../schemas/user-trade.schema";
import { MarketDataService } from "../market-data/market-data.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class HealthMonitorService {
  private readonly logger = new Logger(HealthMonitorService.name);
  private readonly adminIds: number[];

  constructor(
    private readonly telegramService: TelegramBotService,
    private readonly configService: ConfigService,
    private readonly marketDataService: MarketDataService,
    private readonly redisService: RedisService,
    @InjectModel(AiSignal.name)
    private readonly signalModel: Model<AiSignalDocument>,
    @InjectModel(UserTrade.name)
    private readonly tradeModel: Model<UserTradeDocument>,
  ) {
    const adminIdStr = this.configService.get<string>("AI_ADMIN_TELEGRAM_ID", "");
    this.adminIds = adminIdStr
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));
  }

  /**
   * Every 10 minutes: check logs for errors, review signal health, report issues.
   */
  @Cron("0 */10 * * * *")
  async runHealthCheck(): Promise<void> {
    try {
      const issues: string[] = [];
      // 1. Check error logs (last 10 min)
      const logErrors = await this.checkRecentErrors();
      if (logErrors.length > 0) {
        issues.push(`*Errors (last 10m):* ${logErrors.length}`);
        // Group by type, show top 3
        const grouped = this.groupErrors(logErrors);
        const top = grouped.slice(0, 3);
        for (const g of top) {
          issues.push(`  x${g.count} ${g.message.substring(0, 100)}`);
        }
      }

      // 2. Check active signals health
      const signalIssues = await this.checkSignalHealth();
      issues.push(...signalIssues);

      // 3. Check user trades health
      const tradeIssues = await this.checkTradeHealth();
      issues.push(...tradeIssues);

      // 4. Check system status
      const sysIssues = await this.checkSystemHealth();
      issues.push(...sysIssues);

      // Only send if there are issues
      if (issues.length > 0) {
        const now = new Date();
        let text = `*Health Monitor*\n`;
        text += `━━━━━━━━━━━━━━━━━━\n\n`;
        for (const issue of issues) {
          text += `${issue}\n`;
        }

        text += `\n_${now.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;

        await this.notifyAdmin(text);
      }
    } catch (err) {
      this.logger.error(`[HealthMonitor] runHealthCheck error: ${err?.message}`);
    }
  }

  private async checkRecentErrors(): Promise<string[]> {
    try {
      const today = new Date().toISOString().split("T")[0];
      const logDir = path.join(process.cwd(), "logs");
      const errorFile = path.join(logDir, `error-${today}.log`);

      if (!fs.existsSync(errorFile)) return [];

      const content = fs.readFileSync(errorFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const recentErrors: string[] = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const ts = new Date(parsed.timestamp).getTime();
          if (ts >= tenMinAgo) {
            recentErrors.push(parsed.message || line);
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      return recentErrors;
    } catch {
      return [];
    }
  }

  private groupErrors(errors: string[]): { message: string; count: number }[] {
    const map = new Map<string, number>();
    for (const err of errors) {
      // Normalize: remove dynamic parts (numbers, IDs)
      const key = err.replace(/\d+\.\d+/g, "N").replace(/\b[a-f0-9]{24}\b/g, "ID").substring(0, 120);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count);
  }

  private async checkSignalHealth(): Promise<string[]> {
    const issues: string[] = [];

    const actives = await this.signalModel.find({ status: "ACTIVE" }).lean();

    // Check for signals close to SL (within 0.5%)
    for (const s of actives) {
      const price = this.marketDataService.getLatestPrice(s.symbol);
      if (!price) continue;
      const distToSl =
        s.direction === "LONG"
          ? ((price - s.stopLossPrice) / price) * 100
          : ((s.stopLossPrice - price) / price) * 100;
      if (distToSl < 0.5 && distToSl > 0) {
        issues.push(`*Near SL:* ${s.symbol} ${s.direction} — ${distToSl.toFixed(2)}% to SL`);
      }
    }

    return issues;
  }

  private async checkTradeHealth(): Promise<string[]> {
    const issues: string[] = [];

    const openTrades = await this.tradeModel.find({ status: "OPEN" }).lean();

    // Check for trades without SL on Binance
    const noSl = openTrades.filter((t) => !t.binanceSlAlgoId);
    if (noSl.length > 0) {
      issues.push(`*Trades missing SL order:* ${noSl.length}`);
      for (const t of noSl.slice(0, 3)) {
        issues.push(`  ${t.symbol} user:${t.telegramId}`);
      }
    }

    // Check for orphan trades (signal no longer ACTIVE)
    for (const t of openTrades) {
      if (!t.aiSignalId) continue;
      const signal = await this.signalModel.findById(t.aiSignalId).lean();
      if (signal && signal.status !== "ACTIVE") {
        issues.push(`*Orphan trade:* ${t.symbol} user:${t.telegramId} — signal is ${signal.status}`);
      }
    }

    return issues;
  }

  private async checkSystemHealth(): Promise<string[]> {
    const issues: string[] = [];

    // Check if system is paused
    const paused = await this.redisService.get<boolean>("cache:ai:paused");
    if (paused) issues.push("*System paused*");

    // Check market cooldown
    const cooldown = await this.redisService.get<boolean>("cache:ai:market-cooldown");
    if (cooldown) issues.push("*Market cooldown active*");

    return issues;
  }

  private async notifyAdmin(text: string): Promise<void> {
    for (const adminId of this.adminIds) {
      await this.telegramService.sendTelegramMessage(adminId, text).catch(() => {});
    }
  }
}
