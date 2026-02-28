import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { TelegramBotService } from "../telegram/telegram.service";
import { CoinFilterService } from "../coin-filter/coin-filter.service";
import { AiOptimizerService } from "../strategy/ai-optimizer/ai-optimizer.service";
import { RuleEngineService } from "../strategy/rules/rule-engine.service";
import { SignalQueueService } from "./signal-queue.service";
import {
  PositionMonitorService,
  ResolvedSignalInfo,
} from "./position-monitor.service";
import { UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import {
  AiCoinProfile,
  AiCoinProfileDocument,
} from "../schemas/ai-coin-profile.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";

const AI_PAUSED_KEY = "cache:ai:paused";
const AI_TEST_MODE_KEY = "cache:ai:test-mode";

@Injectable()
export class AiSignalService implements OnModuleInit {
  private readonly logger = new Logger(AiSignalService.name);

  // Whether test mode is enabled at startup (can be toggled at runtime)
  private readonly defaultTestMode: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
    private readonly coinFilterService: CoinFilterService,
    private readonly aiOptimizerService: AiOptimizerService,
    private readonly ruleEngineService: RuleEngineService,
    private readonly signalQueueService: SignalQueueService,
    private readonly positionMonitorService: PositionMonitorService,
    private readonly subscriptionService: UserSignalSubscriptionService,
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiCoinProfile.name)
    private readonly aiCoinProfileModel: Model<AiCoinProfileDocument>,
  ) {
    this.defaultTestMode =
      configService.get("AI_TEST_MODE", "false") === "true";
  }

  async onModuleInit() {
    this.logger.log(
      "[AiSignal] Module init — starting initial shortlist scan...",
    );

    // Set initial test mode from env
    if (this.defaultTestMode) {
      await this.redisService.set(AI_TEST_MODE_KEY, true);
      this.logger.log(
        "[AiSignal] Starting in TEST MODE — no real trades will be placed",
      );
    }

    // Register callback so PositionMonitorService can trigger notifications
    // after a real-time TP/SL resolution (avoids circular dependency).
    this.positionMonitorService.setResolveCallback(async (info) => {
      await this.notifyPositionClosed(info).catch(() => {});

      if (info.queuedSignalActivated) {
        const newActive = await this.signalQueueService.getActiveSignal(
          info.symbol,
        );
        if (newActive) {
          await this.broadcastSignal(newActive);
          await this.notifyQueueActivated(newActive, info);
        }
      }

      await this.updateCoinProfile(info).catch(() => {});
    });

    try {
      await this.coinFilterService.scanAndFilter();
      await this.aiOptimizerService.assessGlobalRegime();
    } catch (err) {
      this.logger.error(`[AiSignal] onModuleInit error: ${err?.message}`);
    }
  }

  // ─── Cron: refresh shortlist (every 5 minutes) ────────────────────────────

  @Cron("*/5 * * * *")
  async refreshCoinFilter() {
    try {
      await this.coinFilterService.scanAndFilter();
    } catch (err) {
      this.logger.error(`[AiSignal] refreshCoinFilter error: ${err?.message}`);
    }
  }

  // ─── Cron: assess global regime (every 4 hours) ───────────────────────────

  @Cron("0 */4 * * *")
  async refreshGlobalRegime() {
    try {
      await this.redisService.delete("cache:ai:regime");
      await this.aiOptimizerService.assessGlobalRegime();
    } catch (err) {
      this.logger.error(
        `[AiSignal] refreshGlobalRegime error: ${err?.message}`,
      );
    }
  }

  // ─── Cron: main signal scan (every 30 seconds) ────────────────────────────

  @Cron("*/30 * * * * *")
  async runSignalScan() {
    const paused = await this.redisService.get<boolean>(AI_PAUSED_KEY);
    if (paused) return;

    try {
      const shortlist = await this.coinFilterService.getShortlist();
      if (shortlist.length === 0) return;

      const globalRegime = await this.aiOptimizerService.assessGlobalRegime();

      await Promise.allSettled(
        shortlist.map((entry) =>
          this.processCoin(entry.coin, entry.currency, globalRegime).catch(
            (err) =>
              this.logger.warn(
                `[AiSignal] processCoin ${entry.symbol} failed: ${err?.message}`,
              ),
          ),
        ),
      );
    } catch (err) {
      this.logger.error(`[AiSignal] runSignalScan error: ${err?.message}`);
    }
  }

  // ─── Cron: monitor open positions (every 30 seconds) ─────────────────────

  @Cron("*/30 * * * * *")
  async monitorActiveSignals() {
    // Skip position monitoring in test mode (no real positions exist)
    const isTestMode = await this.isTestModeEnabled();
    if (isTestMode) return;

    try {
      const resolved = await this.positionMonitorService.checkAndResolve();

      for (const info of resolved) {
        await this.notifyPositionClosed(info).catch(() => {});

        if (info.queuedSignalActivated) {
          const newActive = await this.signalQueueService.getActiveSignal(
            info.symbol,
          );
          if (newActive) {
            await this.broadcastSignal(newActive);
            await this.notifyQueueActivated(newActive, info);
          }
        }

        await this.updateCoinProfile(info).catch(() => {});
      }
    } catch (err) {
      this.logger.error(
        `[AiSignal] monitorActiveSignals error: ${err?.message}`,
      );
    }
  }

  // ─── Cron: test-mode simulation check (every 30 seconds) ─────────────────
  // In test mode, simulate TP/SL by checking current price against signal entry

  @Cron("*/30 * * * * *")
  async runTestModeSimulation() {
    const isTestMode = await this.isTestModeEnabled();
    if (!isTestMode) return;

    try {
      const actives = await this.signalQueueService.getAllActiveSignals();
      for (const signal of actives) {
        if (!signal.isTestMode) continue;
        await this.checkTestModeSignal(signal).catch(() => {});
      }
    } catch (err) {
      this.logger.error(`[AiSignal] testModeSimulation error: ${err?.message}`);
    }
  }

  // ─── Cron: cleanup expired QUEUED signals (every 5 minutes) ──────────────

  @Cron("*/5 * * * *")
  async cleanupExpiredQueued() {
    try {
      const count = await this.signalQueueService.cleanupExpiredQueued();
      if (count > 0) {
        this.logger.log(
          `[AiSignal] Cleaned up ${count} expired QUEUED signal(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[AiSignal] cleanupExpiredQueued error: ${err?.message}`,
      );
    }
  }

  // ─── Core: process a single coin ─────────────────────────────────────────

  private async processCoin(
    coin: string,
    currency: string,
    globalRegime: string,
  ): Promise<void> {
    const params = await this.aiOptimizerService.tuneParamsForSymbol(
      coin,
      currency,
      globalRegime,
    );

    const signalResult = await this.ruleEngineService.evaluate(
      coin,
      currency,
      params,
    );
    if (!signalResult) return;

    const isTestMode = await this.isTestModeEnabled();

    this.logger.log(
      `[AiSignal]${isTestMode ? " [TEST]" : ""} Signal: ${coin.toUpperCase()}${currency.toUpperCase()} ${signalResult.isLong ? "LONG" : "SHORT"} (${signalResult.strategy}) — ${signalResult.reason}`,
    );

    const queueResult = await this.signalQueueService.handleNewSignal(
      coin,
      currency,
      signalResult,
      params,
      params.regime,
      isTestMode,
    );

    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;

    if (queueResult.action === "EXECUTED") {
      const activeSignal =
        await this.signalQueueService.getActiveSignal(symbol);
      if (activeSignal) {
        if (isTestMode) {
          // Test mode: send "[TEST]" notification instead of placing real trades
          await this.notifySignalTestMode(activeSignal);
        } else {
          // Live mode: place real trades + send AI-enriched notification
          await this.broadcastSignal(activeSignal);
        }
        await this.notifySignalActive(activeSignal, params, isTestMode);
      }
    } else if (queueResult.action === "QUEUED") {
      const queuedSignal =
        await this.signalQueueService.getQueuedSignal(symbol);
      if (queuedSignal) {
        await this.notifySignalQueued(queuedSignal, isTestMode);
      }
    }
    // SKIPPED — silent
  }

  // ─── Broadcast to execution layer (live mode only) ────────────────────────

  async broadcastSignal(signal: AiSignalDocument): Promise<void> {
    await this.aiSignalModel
      .findByIdAndUpdate(signal._id, { $inc: { sentToUsers: 1 } })
      .catch(() => {});
  }

  // ─── Test mode simulation ─────────────────────────────────────────────────

  private async notifySignalTestMode(signal: AiSignalDocument): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const symbol = signal.symbol;
    const slPct = signal.stopLossPercent.toFixed(1);
    const profileTag = this.getProfileTag(signal);

    // Generate AI risk advice
    const advice = await this.aiOptimizerService
      .generateSignalAdvice({
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        stopLossPrice: signal.stopLossPrice,
        stopLossPercent: signal.stopLossPercent,
        strategy: signal.strategy,
        regime: signal.regime,
        aiConfidence: signal.aiConfidence,
        reason: (signal.indicatorSnapshot as any)?.reason,
      })
      .catch(() => "");

    const text =
      `🧪 *\\[TEST\\] AI Signal — ${symbol}*\n\n` +
      `${dirEmoji} *${signal.direction}* vào $${signal.entryPrice.toLocaleString()}\n` +
      `├ Stop Loss: $${signal.stopLossPrice.toLocaleString()} (-${slPct}%)\n` +
      `├ Profile: *${profileTag}*\n` +
      `├ Strategy: *${signal.strategy}*\n` +
      `├ Regime: *${signal.regime}* (${signal.aiConfidence}%)\n` +
      `└ _Không đặt lệnh thật (chế độ test)_` +
      advice;

    const subscribers = await this.subscriptionService.findAllActive();
    let notified = 0;
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
      notified++;
    }

    await this.aiSignalModel
      .findByIdAndUpdate(signal._id, { sentToUsers: notified })
      .catch(() => {});
  }

  /**
   * In test mode, periodically check if current price would have hit TP or SL.
   * Uses a simple approach: check if SL would have been hit.
   */
  private async checkTestModeSignal(signal: AiSignalDocument): Promise<void> {
    const axios = require("axios");
    let currentPrice: number;
    try {
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${signal.symbol}`,
        { timeout: 5000 },
      );
      currentPrice = parseFloat(res.data.price);
    } catch {
      return;
    }
    if (!currentPrice || currentPrice <= 0) return;

    const isLong = signal.direction === "LONG";
    const slHit = isLong
      ? currentPrice <= signal.stopLossPrice
      : currentPrice >= signal.stopLossPrice;

    if (slHit) {
      this.logger.log(
        `[AiSignal] [TEST] ${signal.symbol} SL hit at $${currentPrice}`,
      );
      await this.signalQueueService.resolveActiveSignal(
        signal.symbol,
        currentPrice,
        "STOP_LOSS",
      );

      // Notify admin about simulated SL
      const pnl = isLong
        ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
        : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

      const text =
        `🧪 *\\[TEST\\] SL Triggered: ${signal.symbol}*\n\n` +
        `${isLong ? "📈" : "📉"} *${signal.direction}* $${signal.entryPrice} → $${currentPrice}\n` +
        `├ PnL: *${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%* (SL hit)\n` +
        `└ Strategy: ${signal.strategy}`;

      await this.notifyAdminOnly(text);

      // Activate queued if any
      const queued = await this.signalQueueService.activateQueuedSignal(
        signal.symbol,
      );
      if (queued) {
        await this.notifySignalTestMode(queued);
      }
    }
  }

  // ─── Telegram notifications ───────────────────────────────────────────────

  /** Returns a display tag like "⚡ Intraday (15m)" or "🌊 Swing (4h)" */
  private getProfileTag(signal: AiSignalDocument): string {
    const profile = (signal as any).timeframeProfile;
    return profile === "SWING" ? "🌊 Swing (4h)" : "⚡ Intraday (15m)";
  }

  /**
   * Notify ALL users with BOT_FUTURE_AI_1 enabled about a new ACTIVE signal.
   * Sent in addition to the "Bot Signal Executed" message from handleIncomingSignal().
   * This provides AI context (strategy, regime, confidence) that the generic message lacks.
   */
  private async notifySignalActive(
    signal: AiSignalDocument,
    params: AiTunedParams,
    isTestMode: boolean,
  ): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const slPct = signal.stopLossPercent.toFixed(1);
    const testTag = isTestMode ? " `[TEST]`" : "";

    // Generate AI risk advice
    const advice = await this.aiOptimizerService
      .generateSignalAdvice({
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        stopLossPrice: signal.stopLossPrice,
        stopLossPercent: signal.stopLossPercent,
        strategy: signal.strategy,
        regime: signal.regime,
        aiConfidence: signal.aiConfidence,
        reason: (signal.indicatorSnapshot as any)?.reason,
      })
      .catch(() => "");

    const profileTag = this.getProfileTag(signal);
    const text =
      `📡 *Bot AI Signal Nhận Được*${testTag}\n\n` +
      `${dirEmoji} *${signal.symbol}* ${signal.direction}\n` +
      `├ Bot: AI1\n` +
      `├ Giá vào: $${signal.entryPrice.toLocaleString()}\n` +
      `├ Stop Loss: $${signal.stopLossPrice.toLocaleString()} (-${slPct}%)\n` +
      `├ Profile: *${profileTag}*\n\n` +
      `🧠 *AI Analysis:*\n` +
      `├ Strategy: *${signal.strategy}*\n` +
      `├ Regime: *${signal.regime}* (${signal.aiConfidence}%)\n` +
      `└ _${(signal.indicatorSnapshot as any)?.reason || ""}_ ` +
      advice;

    if (!isTestMode) {
      // In live mode, send to all subscribed users as an info notification
      const subscribers = await this.subscriptionService.findAllActive();
      for (const sub of subscribers) {
        await this.telegramService
          .sendTelegramMessage(sub.chatId, text)
          .catch(() => {});
      }
    }
    // In test mode, notification was already sent in notifySignalTestMode()
  }

  private async notifySignalQueued(
    signal: AiSignalDocument,
    isTestMode: boolean,
  ): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const hoursLeft = Math.max(
      0,
      (signal.expiresAt.getTime() - Date.now()) / 3600000,
    );
    const testTag = isTestMode ? " `[TEST]`" : "";
    const profileTag = this.getProfileTag(signal);

    const text =
      `📋 *AI Signal — Xếp hàng chờ*${testTag}\n\n` +
      `${dirEmoji} *${signal.symbol}* ${signal.direction} $${signal.entryPrice.toLocaleString()}\n` +
      `├ Profile: *${profileTag}*\n` +
      `├ Đang chờ lệnh hiện tại đóng\n` +
      `├ Strategy: *${signal.strategy}*\n` +
      `└ ⏰ Hết hạn sau: *${hoursLeft.toFixed(1)}h*`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifyQueueActivated(
    signal: AiSignalDocument,
    closedInfo: ResolvedSignalInfo,
  ): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const prevDirEmoji = closedInfo.direction === "LONG" ? "📈" : "📉";
    const pnlSign = closedInfo.pnlPercent >= 0 ? "+" : "";
    const testTag = signal.isTestMode ? " `[TEST]`" : "";

    const profileTag = this.getProfileTag(signal);
    const text =
      `✅ *${closedInfo.symbol} ${closedInfo.direction} đã đóng*\n` +
      `${prevDirEmoji} Entry: $${closedInfo.entryPrice} → Exit: $${closedInfo.exitPrice} (*${pnlSign}${closedInfo.pnlPercent.toFixed(2)}%*)\n\n` +
      `⚡ *Tự động kích hoạt lệnh chờ:*${testTag}\n\n` +
      `${dirEmoji} *${signal.symbol}* ${signal.direction} $${signal.entryPrice.toLocaleString()}\n` +
      `├ Bot: AI1\n` +
      `├ Profile: *${profileTag}*\n` +
      `├ SL: $${signal.stopLossPrice.toLocaleString()} (-${signal.stopLossPercent.toFixed(1)}%)\n` +
      `└ Strategy: *${signal.strategy}*`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifyPositionClosed(info: ResolvedSignalInfo): Promise<void> {
    const pnlSign = info.pnlPercent >= 0 ? "+" : "";
    const pnlEmoji = info.pnlPercent >= 0 ? "🟢" : "🔴";

    // Header line differs by close reason
    let headerLine: string;
    if (info.closeReason === "TAKE_PROFIT") {
      headerLine = `🎯 *${info.symbol} ${info.direction} Take Profit!*`;
    } else if (info.closeReason === "STOP_LOSS") {
      headerLine = `🛑 *${info.symbol} ${info.direction} Stop Loss*`;
    } else {
      headerLine = `${pnlEmoji} *${info.symbol} ${info.direction} Đã đóng*`;
    }

    const text =
      `${headerLine}\n\n` +
      `├ Vào: $${info.entryPrice.toLocaleString()}\n` +
      `├ Ra: $${info.exitPrice.toLocaleString()}\n` +
      `└ PnL: *${pnlSign}${info.pnlPercent.toFixed(2)}%*`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }

    this.logger.log(
      `[AiSignal] ${info.symbol} ${info.direction} ${info.closeReason}: ${pnlSign}${info.pnlPercent.toFixed(2)}%`,
    );
  }

  private async notifyAdminOnly(text: string): Promise<void> {
    const adminIdStr = this.configService.get<string>(
      "AI_ADMIN_TELEGRAM_ID",
      "",
    );
    const adminIds = adminIdStr
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));

    for (const adminId of adminIds) {
      // Admin chatId is usually same as telegramId for private bots
      await this.telegramService
        .sendTelegramMessage(adminId, text)
        .catch(() => {});
    }
  }

  // ─── Coin profile update ──────────────────────────────────────────────────

  private async updateCoinProfile(info: ResolvedSignalInfo): Promise<void> {
    const recentSignal = await this.aiSignalModel.findOne({
      symbol: info.symbol,
      status: "COMPLETED",
      positionClosedAt: { $gte: new Date(Date.now() - 15000) },
    });
    if (!recentSignal) return;

    const isWin = info.pnlPercent > 0;
    const strategy = recentSignal.strategy;

    await this.aiCoinProfileModel.findOneAndUpdate(
      { symbol: info.symbol },
      {
        $inc: {
          [`strategyStats.${strategy}.totalSignals`]: 1,
          [`strategyStats.${strategy}.wins`]: isWin ? 1 : 0,
        },
        $set: {
          [`strategyStats.${strategy}.lastUsedAt`]: new Date(),
          lastRegime: recentSignal.regime,
          lastStrategy: strategy,
        },
        $setOnInsert: {
          coin: info.symbol.replace("USDT", "").toLowerCase(),
          currency: "usdt",
        },
      },
      { upsert: true },
    );
  }

  // ─── Admin API ────────────────────────────────────────────────────────────

  async pause(): Promise<void> {
    await this.redisService.set(AI_PAUSED_KEY, true, 24 * 60 * 60);
    this.logger.log("[AiSignal] Signal generation PAUSED");
  }

  async resume(): Promise<void> {
    await this.redisService.delete(AI_PAUSED_KEY);
    this.logger.log("[AiSignal] Signal generation RESUMED");
  }

  async enableTestMode(): Promise<void> {
    await this.redisService.set(AI_TEST_MODE_KEY, true);
    this.logger.log("[AiSignal] TEST MODE enabled");
  }

  async disableTestMode(): Promise<void> {
    await this.redisService.delete(AI_TEST_MODE_KEY);
    this.logger.log("[AiSignal] TEST MODE disabled — LIVE mode");
  }

  async isTestModeEnabled(): Promise<boolean> {
    const val = await this.redisService.get<boolean>(AI_TEST_MODE_KEY);
    return !!val;
  }

  async getStatus(): Promise<{
    paused: boolean;
    testMode: boolean;
    globalRegime: string;
    activeCount: number;
    queuedCount: number;
    shortlist: string[];
  }> {
    const [paused, testMode, regime, actives, queued, shortlist] =
      await Promise.all([
        this.redisService.get<boolean>(AI_PAUSED_KEY),
        this.redisService.get<boolean>(AI_TEST_MODE_KEY),
        this.redisService.get<string>("cache:ai:regime"),
        this.signalQueueService.getAllActiveSignals(),
        this.signalQueueService.getAllQueuedSignals(),
        this.coinFilterService.getShortlist(),
      ]);

    return {
      paused: !!paused,
      testMode: !!testMode,
      globalRegime: regime || "UNKNOWN",
      activeCount: actives.length,
      queuedCount: queued.length,
      shortlist: shortlist.map((s) => s.symbol),
    };
  }

  async getParamsForSymbol(coin: string, currency: string): Promise<any> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    return this.redisService.get(`cache:ai:params:${symbol}`);
  }

  async overrideStrategy(
    coin: string,
    currency: string,
    strategy: string,
  ): Promise<void> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const cacheKey = `cache:ai:params:${symbol}`;
    const current = await this.redisService.get<any>(cacheKey);
    if (current) {
      current.strategy = strategy;
      await this.redisService.set(cacheKey, current, 4 * 60 * 60);
    }
    this.logger.log(`[AiSignal] Override strategy for ${symbol}: ${strategy}`);
  }
}
