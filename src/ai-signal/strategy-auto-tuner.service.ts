import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron } from "@nestjs/schedule";
import { RedisService } from "../redis/redis.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { TelegramBotService } from "../telegram/telegram.service";

/**
 * StrategyAutoTuner — evaluates strategy performance every 4h and auto-disables
 * strategies with poor PnL/R:R. Results stored in Redis, checked by RuleEngine
 * before firing any strategy.
 *
 * Redis key: cache:strategy-gates → JSON { [strategyName]: { enabled, wr, pnlUsdt, reason, updatedAt } }
 *
 * Criteria to DISABLE a strategy:
 * - 10+ completed trades AND PnL USDT < -$20
 * - OR 10+ trades AND WR < 40%
 * - OR avg loss > 2× avg win (R:R < 0.5)
 *
 * Criteria to RE-ENABLE:
 * - Strategy was disabled but last 5 trades show positive PnL → re-enable (market changed)
 *
 * Admin can override via Redis: cache:strategy-override:{name} = "enable" | "disable"
 */

const STRATEGY_GATES_KEY = "cache:strategy-gates";
const STRATEGY_GATES_TTL = 5 * 60 * 60; // 5h (re-evaluated every 4h)
const MIN_TRADES_TO_EVALUATE = 8; // need at least 8 trades to judge
const LOOKBACK_DAYS = 7; // evaluate last 7 days of data

interface StrategyGate {
  enabled: boolean;
  wr: number;
  pnlUsdt: number;
  avgWin: number;
  avgLoss: number;
  trades: number;
  reason: string;
  updatedAt: string;
}

@Injectable()
export class StrategyAutoTunerService {
  private readonly logger = new Logger(StrategyAutoTunerService.name);

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
  ) {
    // Run on startup after 30s delay
    setTimeout(() => this.evaluateStrategies().catch(() => {}), 30_000);
  }

  /**
   * Get current strategy gates from Redis.
   * Returns map of strategy → gate info. Empty map = all enabled (no data yet).
   */
  async getGates(): Promise<Record<string, StrategyGate>> {
    const cached = await this.redisService.get<Record<string, StrategyGate>>(STRATEGY_GATES_KEY);
    return cached || {};
  }

  /**
   * Check if a specific strategy is enabled. Returns true if no gate exists (default enabled).
   */
  async isStrategyEnabled(strategy: string): Promise<boolean> {
    // Check admin override first
    const override = await this.redisService.get<string>(`cache:strategy-override:${strategy}`);
    if (override === "enable") return true;
    if (override === "disable") return false;

    const gates = await this.getGates();
    const gate = gates[strategy];
    if (!gate) return true; // no data = enabled by default
    return gate.enabled;
  }

  /**
   * Cron: evaluate all strategies every 4 hours.
   */
  @Cron("0 0 */4 * * *") // every 4h
  async evaluateStrategies(): Promise<void> {
    try {
      const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      const signals = await this.aiSignalModel.find({
        status: "COMPLETED",
        createdAt: { $gte: lookbackDate },
        strategy: { $not: /^EXTERNAL_/ }, // don't evaluate external signals
      }).lean();

      if (signals.length < 5) {
        this.logger.log(`[AutoTuner] Only ${signals.length} signals in last ${LOOKBACK_DAYS}d — skipping evaluation`);
        return;
      }

      // Group by strategy
      const byStrategy: Record<string, typeof signals> = {};
      for (const s of signals) {
        const st = (s as any).strategy || "?";
        if (!byStrategy[st]) byStrategy[st] = [];
        byStrategy[st].push(s);
      }

      const gates: Record<string, StrategyGate> = {};
      const changes: string[] = [];
      const prevGates = await this.getGates();

      for (const [strategy, trades] of Object.entries(byStrategy)) {
        const n = trades.length;
        let wins = 0, losses = 0, winUsdt = 0, lossUsdt = 0;

        for (const t of trades) {
          const pnl = (t as any).pnlPercent || 0;
          const notional = (t as any).simNotional || 1000;
          const usdt = (t as any).pnlUsdt || (pnl / 100 * notional);
          if (pnl > 0) { wins++; winUsdt += usdt; }
          else { losses++; lossUsdt += usdt; }
        }

        const wr = n > 0 ? (wins / n) * 100 : 0;
        const totalUsdt = winUsdt + lossUsdt;
        const avgWin = wins > 0 ? winUsdt / wins : 0;
        const avgLoss = losses > 0 ? lossUsdt / losses : 0;

        let enabled = true;
        let reason = "OK";

        if (n >= MIN_TRADES_TO_EVALUATE) {
          // Check disable criteria
          if (totalUsdt < -20) {
            enabled = false;
            reason = `PnL ${totalUsdt.toFixed(0)}$ < -$20 (${n} trades)`;
          } else if (wr < 40) {
            enabled = false;
            reason = `WR ${wr.toFixed(0)}% < 40% (${n} trades)`;
          } else if (avgWin > 0 && Math.abs(avgLoss) > avgWin * 2.5) {
            enabled = false;
            reason = `R:R ${(avgWin / Math.abs(avgLoss)).toFixed(2)}:1 < 0.4 (loss too big)`;
          }

          // Re-enable check: if was disabled but last 5 trades are positive
          if (!enabled) {
            const recent5 = trades.slice(-5);
            if (recent5.length >= 5) {
              const recent5Pnl = recent5.reduce((sum, t) => {
                const pnl = (t as any).pnlPercent || 0;
                return sum + ((t as any).pnlUsdt || (pnl / 100 * ((t as any).simNotional || 1000)));
              }, 0);
              if (recent5Pnl > 0) {
                enabled = true;
                reason = `Re-enabled: last 5 trades +${recent5Pnl.toFixed(0)}$ (recovery)`;
              }
            }
          }
        } else {
          reason = `Insufficient data (${n}/${MIN_TRADES_TO_EVALUATE} trades)`;
        }

        gates[strategy] = {
          enabled,
          wr: Math.round(wr),
          pnlUsdt: Math.round(totalUsdt * 100) / 100,
          avgWin: Math.round(avgWin * 100) / 100,
          avgLoss: Math.round(avgLoss * 100) / 100,
          trades: n,
          reason,
          updatedAt: new Date().toISOString(),
        };

        // Track changes
        const wasEnabled = prevGates[strategy]?.enabled ?? true;
        if (wasEnabled && !enabled) {
          changes.push(`🔴 ${strategy} DISABLED: ${reason}`);
        } else if (!wasEnabled && enabled) {
          changes.push(`🟢 ${strategy} RE-ENABLED: ${reason}`);
        }
      }

      // Save to Redis
      await this.redisService.set(STRATEGY_GATES_KEY, gates, STRATEGY_GATES_TTL);

      // Log summary
      const enabledCount = Object.values(gates).filter(g => g.enabled).length;
      const disabledCount = Object.values(gates).filter(g => !g.enabled).length;
      this.logger.log(
        `[AutoTuner] Evaluated ${Object.keys(gates).length} strategies: ${enabledCount} enabled, ${disabledCount} disabled`,
      );

      for (const [st, g] of Object.entries(gates)) {
        const icon = g.enabled ? "✅" : "❌";
        this.logger.log(
          `[AutoTuner] ${icon} ${st.padEnd(22)} WR=${g.wr}% PnL=${g.pnlUsdt >= 0 ? "+" : ""}${g.pnlUsdt}$ avgW=${g.avgWin.toFixed(1)}$ avgL=${g.avgLoss.toFixed(1)}$ n=${g.trades} — ${g.reason}`,
        );
      }

      // Notify admin on changes
      if (changes.length > 0) {
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `📊 *Strategy Auto-Tuner*\n━━━━━━━━━━━━━━━━━━\n\n` +
          changes.join("\n") +
          `\n\n_Đánh giá ${signals.length} signals / ${LOOKBACK_DAYS} ngày_`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }
    } catch (err) {
      this.logger.error(`[AutoTuner] Error: ${err?.message}`);
    }
  }
}
