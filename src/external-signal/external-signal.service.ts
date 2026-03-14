import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { SignalQueueService } from "../ai-signal/signal-queue.service";
import { AiSignalService } from "../ai-signal/ai-signal.service";
import { AiOptimizerService } from "../strategy/ai-optimizer/ai-optimizer.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
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

    // ── 5. Custom validation (lighter than full pipeline) ────────────────
    const rejectedBy: string[] = [];
    let pricePosition: number | undefined;
    let rsiValue: number | undefined;
    let htfRsiValue: number | undefined;
    let fundingRate: number | undefined;
    let longShortRatio: number | undefined;

    try {
      // 5a. Funding rate check
      const analyticsCache = await this.futuresAnalyticsService.getCachedAnalytics();
      let fa = analyticsCache.get(symbol);
      if (!fa) {
        fa = await this.futuresAnalyticsService.fetchSingleCoin(symbol);
      }
      if (fa) {
        fundingRate = fa.fundingRate;
        longShortRatio = fa.longShortRatio;
        const fundingPct = fa.fundingRate * 100;
        this.logger.log(`[ExtSignal] ${symbol} funding=${fundingPct.toFixed(3)}% L/S=${fa.longShortRatio?.toFixed(2)}`);
        if (Math.abs(fundingPct) > 0.5) {
          rejectedBy.push("extreme_funding");
        } else if (fundingPct > 0.3 && isLong) {
          rejectedBy.push("funding_crowded_longs");
        } else if (fundingPct < -0.3 && !isLong) {
          rejectedBy.push("funding_crowded_shorts");
        }
      } else {
        this.logger.log(`[ExtSignal] ${symbol} funding data unavailable (fail-open)`);
      }

      // 5b. RSI sanity (15m)
      const ohlc15m = await this.indicatorService.getOhlc(coin, "15m");
      if (ohlc15m.closes.length >= 20) {
        const rsi = this.indicatorService.getRsi(ohlc15m.closes, 14);
        rsiValue = rsi.last;
        this.logger.log(`[ExtSignal] ${symbol} RSI(15m)=${rsi.last.toFixed(1)}`);
        if (isLong && rsi.last > 70) rejectedBy.push("rsi_overbought");
        if (!isLong && rsi.last < 30) rejectedBy.push("rsi_oversold");
      } else {
        this.logger.log(`[ExtSignal] ${symbol} RSI(15m) unavailable — insufficient candles (${ohlc15m.closes.length})`);
      }

      // 5c. Price position (1h, 20 candles)
      const ohlc1h = await this.indicatorService.getOhlc(coin, "1h");
      if (ohlc1h.highs.length >= 20) {
        const highs = ohlc1h.highs.slice(-20);
        const lows = ohlc1h.lows.slice(-20);
        const high = Math.max(...highs);
        const low = Math.min(...lows);
        const range = high - low;
        if (range > 0) {
          const price = ohlc1h.closes[ohlc1h.closes.length - 1];
          pricePosition = ((price - low) / range) * 100;
          this.logger.log(`[ExtSignal] ${symbol} pricePos=${pricePosition.toFixed(0)}% (price=${price}, range=${low.toFixed(2)}-${high.toFixed(2)})`);
          if (!isLong && pricePosition < 25) rejectedBy.push("price_position_bottom");
          if (isLong && pricePosition > 75) rejectedBy.push("price_position_top");
        }

        // 5d. HTF RSI (1h)
        if (ohlc1h.closes.length >= 20) {
          const htfRsi = this.indicatorService.getRsi(ohlc1h.closes, 14);
          htfRsiValue = htfRsi.last;
          this.logger.log(`[ExtSignal] ${symbol} RSI(1h)=${htfRsi.last.toFixed(1)}`);
          if (isLong && htfRsi.last > 70) rejectedBy.push("htf_rsi_overbought");
          if (!isLong && htfRsi.last < 30) rejectedBy.push("htf_rsi_oversold");
        }
      } else {
        this.logger.log(`[ExtSignal] ${symbol} pricePos unavailable — insufficient 1h candles (${ohlc1h.highs.length})`);
      }
    } catch (err) {
      this.logger.warn(`[ExtSignal] ${symbol} validation error (fail-open): ${err?.message}`);
      // fail-open: approve on error
    }

    // ── Save validation result ───────────────────────────────────────────
    const regime = (await this.redisService.get<string>("cache:ai:regime")) || "MIXED";

    if (rejectedBy.length > 0) {
      const ctxParts: string[] = [];
      if (pricePosition != null) ctxParts.push(`pos=${pricePosition.toFixed(0)}%`);
      if (rsiValue != null) ctxParts.push(`RSI=${rsiValue.toFixed(0)}`);
      if (htfRsiValue != null) ctxParts.push(`RSI1h=${htfRsiValue.toFixed(0)}`);
      if (fundingRate != null) ctxParts.push(`funding=${(fundingRate * 100).toFixed(3)}%`);
      const reason = `Rejected by: ${rejectedBy.join(", ")}${ctxParts.length ? ` (${ctxParts.join(", ")})` : ""}`;

      this.validationModel
        .create({
          symbol, direction, strategy, regime,
          confidence: 65,
          stopLossPercent: slPct,
          takeProfitPercent: 0,
          approved: false, reason,
          model: "external-tcp",
          pricePosition, candleMomentum: undefined, rsiValue, htfRsiValue, rejectedBy,
        })
        .catch((e) => this.logger.warn(`[ExtSignal] Save validation error: ${e?.message}`));

      this.logger.log(`[ExtSignal] ${symbol} ${direction} REJECTED: ${reason}`);
      return { success: false, reason };
    }

    // ── 6. Compute TP via existing Fib/ATR logic ─────────────────────────
    this.logger.log(`[ExtSignal] ${symbol} ✅ validation PASSED — computing TP...`);
    let tpPct: number;
    try {
      const tunedParams = await this.aiOptimizerService.tuneParamsForSymbol(
        coin, currency, regime,
      );
      const rawTp = tunedParams.takeProfitPercent;
      // Use AI-computed TP but enforce R:R ≥ 2
      tpPct = Math.max(rawTp, slPct * 2);
      tpPct = Math.min(tpPct, 4); // cap 4%
      this.logger.log(`[ExtSignal] ${symbol} TP: fib/ATR=${rawTp.toFixed(2)}% → R:R adjusted=${tpPct.toFixed(2)}% (SL=${slPct.toFixed(2)}%)`);
    } catch (err) {
      // Fallback: TP = SL × 2, cap 4%
      tpPct = Math.min(slPct * 2, 4);
      this.logger.log(`[ExtSignal] ${symbol} TP: fallback SL×2=${tpPct.toFixed(2)}% (tuneParams failed: ${err?.message})`);
    }

    // Compute absolute TP price
    const tpPrice = isLong
      ? payload.entry * (1 + tpPct / 100)
      : payload.entry * (1 - tpPct / 100);
    this.logger.log(`[ExtSignal] ${symbol} entry=${payload.entry} SL=$${payload.stopLoss} TP=$${tpPrice.toFixed(4)} regime=${regime}`);

    // ── Save approval validation ─────────────────────────────────────────
    const parts: string[] = [
      `pos=${pricePosition?.toFixed(0)}%`,
      `RSI=${rsiValue?.toFixed(0)}`,
    ];
    if (htfRsiValue != null) parts.push(`RSI1h=${htfRsiValue.toFixed(0)}`);
    if (fundingRate != null) parts.push(`funding=${(fundingRate * 100).toFixed(3)}%`);
    if (longShortRatio != null) parts.push(`L/S=${longShortRatio.toFixed(2)}`);
    const approvalReason = `Rules passed: ${parts.join(", ")}`;

    this.validationModel
      .create({
        symbol, direction, strategy, regime,
        confidence: 65,
        stopLossPercent: slPct,
        takeProfitPercent: tpPct,
        approved: true, reason: approvalReason,
        model: "external-tcp",
        pricePosition, candleMomentum: undefined, rsiValue, htfRsiValue, rejectedBy: [],
      })
      .catch((e) => this.logger.warn(`[ExtSignal] Save validation error: ${e?.message}`));

    // ── 7. Create signal via SignalQueueService ──────────────────────────
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

    const futuresData = fundingRate != null
      ? { fundingRate, longShortRatio: longShortRatio ?? 0 }
      : undefined;

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
