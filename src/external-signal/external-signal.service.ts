import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { SignalQueueService } from "../ai-signal/signal-queue.service";
import { AiSignalService } from "../ai-signal/ai-signal.service";
import { AiOptimizerService } from "../strategy/ai-optimizer/ai-optimizer.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { StrategyAutoTunerService } from "../ai-signal/strategy-auto-tuner.service";
import { TradingConfigService } from "../ai-signal/trading-config";
import {
  AiSignalValidation,
  AiSignalValidationDocument,
} from "../schemas/ai-signal-validation.schema";
import type { ExternalSignalPayload } from "./external-signal.controller";
import type { SignalResult } from "../strategy/rules/rule-engine.service";

const MAX_DAILY_SIGNALS = 35;

// Map botType → strategy name for display/tracking
const BOT_TYPE_MAP: Record<string, string> = {
  BOT_FUTURE_CT_1: "EXTERNAL_CT_1",
  BOT_FUTURE_CT_2: "EXTERNAL_CT_2",
  BOT_FUTURE_CT_3: "EXTERNAL_CT_3",
  BOT_FUTURE_CT_4: "EXTERNAL_CT_4",
  BOT_FUTURE_CT_5: "EXTERNAL_CT_5",
  BOT_FUTURE_CT_6: "EXTERNAL_CT_6",
  BOT_FUTURE_CT_7: "EXTERNAL_CT_7",
  BOT_FUTURE_CT_8: "EXTERNAL_CT_8",
};

@Injectable()
export class ExternalSignalService {
  private readonly logger = new Logger(ExternalSignalService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly signalQueueService: SignalQueueService,
    private readonly aiSignalService: AiSignalService,
    private readonly aiOptimizerService: AiOptimizerService,
    private readonly indicatorService: IndicatorService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly strategyAutoTuner: StrategyAutoTunerService,
    private readonly tradingConfig: TradingConfigService,
    @InjectModel(AiSignalValidation.name)
    private readonly validationModel: Model<AiSignalValidationDocument>,
  ) {}

  async processExternalSignal(
    payload: ExternalSignalPayload,
  ): Promise<{ success: boolean; reason?: string; signalId?: string }> {
    // ── 1. Input validation ──────────────────────────────────────────────
    if (payload.tradingPairType !== "FUTURE") {
      return { success: false, reason: "Only FUTURE supported" };
    }
    if (!payload.coin || !payload.currency || !payload.entry || !payload.stopLoss) {
      return { success: false, reason: "Missing required fields" };
    }
    if (payload.entry <= 0 || payload.stopLoss <= 0) {
      return { success: false, reason: "Invalid entry/stopLoss" };
    }

    const coin = payload.coin.toUpperCase();
    const currency = payload.currency.toUpperCase();
    const symbol = `${coin}${currency}`;
    const isLong = payload.equity === "LONG";
    const direction = isLong ? "LONG" : "SHORT";
    const strategy = BOT_TYPE_MAP[payload.botType] || `EXTERNAL_${payload.botType}`;

    this.logger.log(
      `[ExtSignal] ── Processing ${symbol} ${direction} ── entry=${payload.entry} SL=${payload.stopLoss} bot=${payload.botType} period=${payload.period}`,
    );

    // ── 2. Compute SL% ──────────────────────────────────────────────────
    const rawSlPct = Math.abs((payload.entry - payload.stopLoss) / payload.entry) * 100;
    let slPct = Math.max(2, Math.min(4, rawSlPct)); // clamp [2%, 4%]
    this.logger.log(`[ExtSignal] ${symbol} SL%: raw=${rawSlPct.toFixed(2)}% → clamped=${slPct.toFixed(2)}%`);

    // ── 3. Duplicate guard ───────────────────────────────────────────────
    const signalKey = symbol;
    const activeSignal = await this.signalQueueService.getActiveSignal(signalKey);
    if (activeSignal) {
      this.logger.log(`[ExtSignal] ${symbol} SKIP — already active (${activeSignal.direction})`);
      return { success: false, reason: `Already active: ${symbol} ${activeSignal.direction}` };
    }

    // ── 4. Daily signal cap ──────────────────────────────────────────────
    const dailyCountKey = "cache:ai:daily-signal-count";
    const currentDailyCount = (await this.redisService.get<number>(dailyCountKey)) ?? 0;
    if (currentDailyCount >= MAX_DAILY_SIGNALS) {
      this.logger.log(`[ExtSignal] ${symbol} SKIP — daily cap reached (${currentDailyCount}/${MAX_DAILY_SIGNALS})`);
      return { success: false, reason: `Daily cap reached (${MAX_DAILY_SIGNALS})` };
    }
    this.logger.log(`[ExtSignal] ${symbol} daily count: ${currentDailyCount}/${MAX_DAILY_SIGNALS}`);

    // ── No validation — external signals are pre-validated by source ──
    const regime = (await this.redisService.get<string>("cache:ai:regime")) || "MIXED";

    // ── 6. Compute TP via existing Fib/ATR logic ─────────────────────────
    this.logger.log(`[ExtSignal] ${symbol} ✅ validation PASSED — computing TP...`);
    let tpPct: number;
    try {
      const tunedParams = await this.aiOptimizerService.tuneParamsForSymbol(
        coin, currency, regime,
      );
      const cfg = this.tradingConfig.get();
      const rawTp = tunedParams.takeProfitPercent;
      // Use AI-computed TP but enforce R:R from config
      tpPct = Math.max(rawTp, slPct * cfg.tpRrMultiplier);
      tpPct = Math.min(tpPct, cfg.tpMax);
      this.logger.log(`[ExtSignal] ${symbol} TP: fib/ATR=${rawTp.toFixed(2)}% → R:R adjusted=${tpPct.toFixed(2)}% (SL=${slPct.toFixed(2)}%)`);
    } catch (err) {
      // Fallback: TP = SL × R:R, cap from config
      const cfg = this.tradingConfig.get();
      tpPct = Math.min(slPct * cfg.tpRrMultiplier, cfg.tpMax);
      this.logger.log(`[ExtSignal] ${symbol} TP: fallback SL×2=${tpPct.toFixed(2)}% (tuneParams failed: ${err?.message})`);
    }

    // Compute absolute TP price
    const tpPrice = isLong
      ? payload.entry * (1 + tpPct / 100)
      : payload.entry * (1 - tpPct / 100);
    this.logger.log(`[ExtSignal] ${symbol} entry=${payload.entry} SL=$${payload.stopLoss} TP=$${tpPrice.toFixed(4)} regime=${regime}`);

    // ── Save validation (auto-approved) ──────────────────────────────────
    this.validationModel
      .create({
        symbol, direction, strategy, regime,
        confidence: 65,
        stopLossPercent: slPct,
        takeProfitPercent: tpPct,
        approved: true, reason: "External signal — auto-approved (no validation)",
        model: "external-tcp",
      })
      .catch((e) => this.logger.warn(`[ExtSignal] Save validation error: ${e?.message}`));

    // ── 7. Create signal via SignalQueueService ──────────────────────────
    // External signals follow global test-mode flag (same as internal signals)
    const isTestMode = await this.aiSignalService.isTestModeEnabled();

    const signalResult: SignalResult = {
      isLong,
      entryPrice: payload.entry,
      strategy,
      reason: `External signal from ${payload.botType} (${payload.period})`,
    };

    const params = {
      regime: regime as any,
      timeframeProfile: "SWING" as const,
      strategy,
      confidence: 65,
      stopLossPercent: slPct,
      takeProfitPercent: tpPct,
      minConfidenceToTrade: 60,
    };

    const futuresData = undefined; // no validation data — external signals auto-approved

    const queueResult = await this.signalQueueService.handleNewSignal(
      coin,
      currency,
      signalResult,
      params as any,
      regime,
      isTestMode,
      undefined, // no forceProfile
      futuresData,
    );

    this.logger.log(
      `[ExtSignal] ${symbol} ${direction} ${strategy} → ${queueResult.action} (SL=${slPct.toFixed(1)}% TP=${tpPct.toFixed(1)}%)`,
    );

    if (queueResult.action === "EXECUTED" || queueResult.action === "QUEUED") {
      // Increment daily count
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setUTCDate(midnight.getUTCDate() + 1);
      midnight.setUTCHours(0, 0, 0, 0);
      const ttl = Math.ceil((midnight.getTime() - now) / 1000);
      await this.redisService.initAndIncr(dailyCountKey, 0, ttl);
    }

    if (queueResult.action === "EXECUTED") {
      await this.aiSignalService.handlePostActivation(signalKey, params, isTestMode);
      return { success: true, reason: `EXECUTED — ${symbol} ${direction}` };
    }

    if (queueResult.action === "QUEUED") {
      return { success: true, reason: `QUEUED — ${symbol} ${direction}` };
    }

    return { success: false, reason: `SKIPPED by queue logic` };
  }
}
