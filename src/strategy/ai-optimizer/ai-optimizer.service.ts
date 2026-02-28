import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import { RedisService } from "../../redis/redis.service";
import { IndicatorService } from "../indicators/indicator.service";
import {
  AiRegimeHistory,
  AiRegimeHistoryDocument,
} from "../../schemas/ai-regime-history.schema";
import { AiTunedParams } from "./ai-tuned-params.interface";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

// Cost per 1M tokens (USD)
const HAIKU_INPUT_COST = 0.8;
const HAIKU_OUTPUT_COST = 4.0;
const SONNET_INPUT_COST = 15.0;
const SONNET_OUTPUT_COST = 75.0;

const AI_PARAMS_TTL = 2 * 60 * 60; // 2h (was 1h — reduces calls by 50%)
const AI_PARAMS_JITTER = 30 * 60; // ±15 min random offset to stagger expiry
const AI_REGIME_TTL = 4 * 60 * 60; // 4h
const HAIKU_TUNE_RATE_KEY = "cache:ai:rate:haiku:tune"; // tuning pool (80%)
const HAIKU_DEMAND_RATE_KEY = "cache:ai:rate:haiku:demand"; // on-demand pool (20%)
const HAIKU_SCAN_BURST_KEY = "cache:ai:rate:haiku:burst"; // per-scan burst limiter
const MAX_RETUNES_PER_SCAN = 5; // max fresh Haiku calls per 30s scan cycle
const SCAN_BURST_TTL = 35; // slightly longer than 30s scan interval
const SONNET_RATE_KEY = "cache:ai:rate:sonnet";
const RATE_WINDOW = 60 * 60; // 1h window

@Injectable()
export class AiOptimizerService {
  private readonly logger = new Logger(AiOptimizerService.name);
  private anthropic: Anthropic;
  private readonly enabled: boolean;
  private readonly maxHaikuTunePerHour: number; // 80% budget for tuning
  private readonly maxHaikuDemandPerHour: number; // 20% budget for on-demand
  private readonly maxSonnetPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly indicatorService: IndicatorService,
    @InjectModel(AiRegimeHistory.name)
    private readonly regimeHistoryModel: Model<AiRegimeHistoryDocument>,
  ) {
    this.enabled = configService.get("AI_ENABLED", "true") === "true";
    const totalHaiku = parseInt(
      configService.get("AI_MAX_HAIKU_PER_HOUR", "60"),
    );
    this.maxHaikuTunePerHour = Math.floor(totalHaiku * 0.8); // 80% for tuning
    this.maxHaikuDemandPerHour = Math.max(5, totalHaiku - this.maxHaikuTunePerHour); // 20% for on-demand (min 5)
    this.maxSonnetPerHour = parseInt(
      configService.get("AI_MAX_SONNET_PER_HOUR", "2"),
    );

    if (this.enabled) {
      const apiKey = configService.get<string>("ANTHROPIC_API_KEY");
      if (apiKey) {
        this.anthropic = new Anthropic({ apiKey });
      } else {
        this.logger.warn(
          "[AiOptimizer] ANTHROPIC_API_KEY not set, using fallback params",
        );
        this.enabled = false;
      }
    }
  }

  // ─── Global regime assessment (Sonnet, every 4h) ──────────────────────────

  async assessGlobalRegime(): Promise<string> {
    const cacheKey = "cache:ai:regime";
    const cached = await this.redisService.get<string>(cacheKey);
    if (cached) return cached;

    if (
      !this.enabled ||
      !(await this.checkRateLimit(SONNET_RATE_KEY, this.maxSonnetPerHour))
    ) {
      return "MIXED";
    }

    try {
      const prompt = `You are a crypto market analyst. In one JSON object, assess the current global crypto market regime.

Return ONLY valid JSON with this exact structure:
{
  "regime": "STRONG_TREND|RANGE_BOUND|VOLATILE|BTC_CORRELATION|MIXED",
  "confidence": <0-100>,
  "rationale": "<one sentence>"
}

Choose the regime based on:
- STRONG_TREND: Bitcoin trending strongly in one direction, alts following
- RANGE_BOUND: Market consolidating, prices bouncing between support/resistance
- VOLATILE: High volatility, unpredictable moves, large wicks
- BTC_CORRELATION: Alts closely following BTC movement
- MIXED: No clear dominant regime`;

      const response = await this.anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });

      await this.incrementRateLimit(SONNET_RATE_KEY);

      const text = (response.content[0] as any).text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in Sonnet response");
      const parsed = JSON.parse(jsonMatch[0]);
      const regime = parsed.regime || "MIXED";

      await this.redisService.set(cacheKey, regime, AI_REGIME_TTL);

      // Log to MongoDB
      await this.saveRegimeHistory(
        "global",
        regime,
        parsed.confidence || 60,
        null,
        SONNET_MODEL,
        response.usage,
      );

      this.logger.log(
        `[AiOptimizer] Global regime: ${regime} (confidence: ${parsed.confidence}%)`,
      );
      return regime;
    } catch (err) {
      this.logger.warn(`[AiOptimizer] Sonnet call failed: ${err?.message}`);
      return "MIXED";
    }
  }

  // ─── Per-coin parameter tuning (Haiku, cached 2h with jitter) ───────────

  async tuneParamsForSymbol(
    coin: string,
    currency: string,
    globalRegime: string,
  ): Promise<AiTunedParams> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const cacheKey = `cache:ai:params:${symbol}`;

    const cached = await this.redisService.get<AiTunedParams>(cacheKey);
    if (cached) return cached;

    // Check: AI enabled, hourly budget, and per-scan burst limit
    const burstCount = (await this.redisService.get<number>(HAIKU_SCAN_BURST_KEY)) || 0;
    if (
      !this.enabled ||
      burstCount >= MAX_RETUNES_PER_SCAN ||
      !(await this.checkRateLimit(HAIKU_TUNE_RATE_KEY, this.maxHaikuTunePerHour))
    ) {
      const defaultParams = this.getDefaultParams(globalRegime);
      this.logger.debug(
        `[AiOptimizer] Using default params for ${symbol} (${burstCount >= MAX_RETUNES_PER_SCAN ? "burst limit" : "rate limit"})`,
      );
      return defaultParams;
    }

    try {
      const indicators = await this.preComputeIndicators(coin);
      const params = await this.callHaiku(symbol, globalRegime, indicators);

      // Stagger cache expiry: TTL + 0-30 min random offset to avoid thundering herd
      const jitter = Math.floor(Math.random() * AI_PARAMS_JITTER);
      await this.redisService.set(cacheKey, params, AI_PARAMS_TTL + jitter);
      await this.incrementRateLimit(HAIKU_TUNE_RATE_KEY);
      // Increment per-scan burst counter (resets every 35s)
      await this.redisService.set(HAIKU_SCAN_BURST_KEY, burstCount + 1, SCAN_BURST_TTL);

      // Log to MongoDB
      await this.saveRegimeHistory(
        symbol,
        params.regime,
        params.confidence,
        params,
        HAIKU_MODEL,
        null,
      );

      this.logger.log(
        `[AiOptimizer] ${symbol}: regime=${params.regime} strategy=${params.strategy} confidence=${params.confidence}%`,
      );
      return params;
    } catch (err) {
      this.logger.warn(
        `[AiOptimizer] Haiku call failed for ${symbol}: ${err?.message}`,
      );
      return this.getDefaultParams(globalRegime);
    }
  }

  // ─── Emergency override (re-tune immediately) ────────────────────────────

  async forceRetune(
    coin: string,
    currency: string,
    reason: string,
  ): Promise<AiTunedParams> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    this.logger.warn(`[AiOptimizer] Emergency retune for ${symbol}: ${reason}`);

    // Clear cache
    await this.redisService.delete(`cache:ai:params:${symbol}`);
    await this.redisService.delete(`cache:ai-signal:state:${coin}:STOCH_BB`);
    await this.redisService.delete(`cache:ai-signal:state:${coin}:STOCH_EMA`);

    const regime = await this.assessGlobalRegime();
    return this.tuneParamsForSymbol(coin, currency, regime);
  }

  // ─── Pre-compute indicators for AI prompt ────────────────────────────────

  private async preComputeIndicators(
    coin: string,
  ): Promise<Record<string, any>> {
    try {
      const [ohlc15m, ohlc1h, ohlc4h] = await Promise.all([
        this.indicatorService.getOhlc(coin, "15m"),
        this.indicatorService.getOhlc(coin, "1h"),
        this.indicatorService.getOhlc(coin, "4h"),
      ]);

      const closes15m = ohlc15m.closes;
      const closes1h = ohlc1h.closes;
      const closes4h = ohlc4h.closes;

      if (closes15m.length < 50) return {};

      // ── 15m indicators (intraday) ─────────────────────────────────────────
      const rsi14 = this.indicatorService.getRsi(closes15m, 14);
      const ema9 = this.indicatorService.getEma(closes15m, 9);
      const ema21 = this.indicatorService.getEma(closes15m, 21);
      const ema200 =
        closes15m.length >= 200
          ? this.indicatorService.getEma(closes15m, 200)
          : null;
      const bb = this.indicatorService.getBollingerBands(closes15m, 20, 2);
      const bbWidthPct = this.indicatorService.getBbWidthPercent(bb);
      const atrPct15m = this.indicatorService.getAtrPercent(
        ohlc15m.highs,
        ohlc15m.lows,
        closes15m,
      );

      const currentPrice = closes15m[closes15m.length - 1];
      const priceVsEma9 = ((currentPrice - ema9.last) / ema9.last) * 100;
      const priceVsEma200 = ema200
        ? ((currentPrice - ema200.last) / ema200.last) * 100
        : null;

      const rsi1h =
        closes1h.length >= 20
          ? this.indicatorService.getRsi(closes1h, 14)
          : null;

      const lastCandles15m = closes15m.slice(-4, -1).map((c, i) => {
        const o = ohlc15m.opens[ohlc15m.opens.length - 4 + i];
        return c > o ? "G" : "R";
      });

      const volumes = ohlc15m.highs.map((h, i) => h - ohlc15m.lows[i]);
      const volRatio =
        volumes.length > 20
          ? volumes[volumes.length - 1] /
            (volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20)
          : 1;

      // ── 4h indicators (swing) ─────────────────────────────────────────────
      const rsi4h =
        closes4h.length >= 20
          ? this.indicatorService.getRsi(closes4h, 14)
          : null;
      const ema21_4h =
        closes4h.length >= 21
          ? this.indicatorService.getEma(closes4h, 21)
          : null;
      const ema200_4h =
        closes4h.length >= 200
          ? this.indicatorService.getEma(closes4h, 200)
          : null;
      const atrPct4h =
        closes4h.length >= 14
          ? this.indicatorService.getAtrPercent(
              ohlc4h.highs,
              ohlc4h.lows,
              closes4h,
            )
          : null;
      const lastCandles4h =
        closes4h.length >= 4
          ? closes4h.slice(-4, -1).map((c, i) => {
              const o = ohlc4h.opens[ohlc4h.opens.length - 4 + i];
              return c > o ? "G" : "R";
            })
          : null;
      const priceVsEma21_4h = ema21_4h
        ? ((currentPrice - ema21_4h.last) / ema21_4h.last) * 100
        : null;

      return {
        price: currentPrice,
        // ── Intraday (15m) ──────────────────────────────────────────────────
        rsi14_15m: rsi14.last.toFixed(1),
        ema9_15m: ema9.last.toFixed(2),
        ema21_15m: ema21.last.toFixed(2),
        ema200_15m: ema200 ? ema200.last.toFixed(2) : "N/A",
        priceVsEma9_pct: priceVsEma9.toFixed(2),
        priceVsEma200_pct: priceVsEma200 ? priceVsEma200.toFixed(2) : "N/A",
        bbUpper: bb.upper.toFixed(2),
        bbMiddle: bb.middle.toFixed(2),
        bbLower: bb.lower.toFixed(2),
        bbWidthPct: bbWidthPct.toFixed(2),
        atrPct_15m: atrPct15m.toFixed(2),
        rsi14_1h: rsi1h ? rsi1h.last.toFixed(1) : "N/A",
        lastCandleColors_15m: lastCandles15m.join("-"),
        volRatio: volRatio.toFixed(2),
        // ── Swing (4h) ──────────────────────────────────────────────────────
        rsi14_4h: rsi4h ? rsi4h.last.toFixed(1) : "N/A",
        ema21_4h: ema21_4h ? ema21_4h.last.toFixed(2) : "N/A",
        ema200_4h: ema200_4h ? ema200_4h.last.toFixed(2) : "N/A",
        priceVsEma21_4h_pct: priceVsEma21_4h
          ? priceVsEma21_4h.toFixed(2)
          : "N/A",
        atrPct_4h: atrPct4h ? atrPct4h.toFixed(2) : "N/A",
        lastCandleColors_4h: lastCandles4h ? lastCandles4h.join("-") : "N/A",
      };
    } catch (err) {
      this.logger.debug(
        `[AiOptimizer] preComputeIndicators failed: ${err?.message}`,
      );
      return {};
    }
  }

  private async callHaiku(
    symbol: string,
    globalRegime: string,
    indicators: Record<string, any>,
  ): Promise<AiTunedParams> {
    const indicatorText = Object.entries(indicators)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    const prompt = `You are a crypto trading parameter optimizer. Given the market data for ${symbol}, return optimal trading parameters.

Current global regime: ${globalRegime}

Indicators (15m=intraday, 4h=swing):
${indicatorText}

Choose timeframeProfile:
- INTRADAY: 15m primary, 1h HTF — for volatile/choppy markets or when 4h trend is unclear
- SWING: 4h primary, 1d HTF — when 4h trend is strong and clear, low atrPct_15m vs atrPct_4h

Return ONLY valid JSON (no extra fields, no comments):
{
  "timeframeProfile": "INTRADAY|SWING",
  "regime": "STRONG_TREND|RANGE_BOUND|VOLATILE|BTC_CORRELATION|MIXED",
  "strategy": "RSI_CROSS|RSI_ZONE|TREND_EMA|MEAN_REVERT_RSI|STOCH_BB_PATTERN|STOCH_EMA_KDJ",
  "confidence": <0-100>,
  "stopLossPercent": <0.5-5.0>,
  "takeProfitPercent": <0.5-15.0>,
  "minConfidenceToTrade": <50-80>,
  "rsiCross": { "primaryKline": "<15m|4h>", "rsiPeriod": 14, "rsiEmaPeriod": 9, "enableThreshold": true, "rsiThreshold": 50, "enableHtfRsi": true, "htfKline": "<1h|1d>", "enableCandleDir": false, "candleKline": "<15m|4h>" },
  "rsiZone": { "primaryKline": "<15m|4h>", "rsiPeriod": 14, "rsiEmaPeriod": 9, "rsiTop": 70, "rsiBottom": 30, "enableHtfRsi": true, "htfKline": "<1h|1d>", "enableInitialCandle": true, "excludeLatestCandle": true }
}

Strategy guide: STRONG_TREND→RSI_CROSS/TREND_EMA, RANGE_BOUND→STOCH_BB_PATTERN/MEAN_REVERT_RSI, VOLATILE→RSI_ZONE, BTC_CORRELATION→RSI_CROSS, MIXED→RSI_ZONE
Kline guide: INTRADAY→primaryKline="15m" htfKline="1h"; SWING→primaryKline="4h" htfKline="1d"
Higher ATR%→wider stop loss. Low BBWidth%→tighter RSI zones. SWING→stopLossPercent 1.5-4.0.
takeProfitPercent guide: set based on regime/volatility. STRONG_TREND→2×-3× SL. RANGE_BOUND→1.5×-2× SL. VOLATILE→1.5× SL. SWING→wider TP (3×-4× SL). Minimum 1.5× stopLossPercent.`;

    const response = await this.anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (response.content[0] as any).text;

    // Extract JSON (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Haiku response");

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and merge with defaults
    return this.mergeWithDefaults(parsed);
  }

  // ─── Default params (F8 Config 2 baseline) ───────────────────────────────

  getDefaultParams(regime = "MIXED"): AiTunedParams {
    return {
      timeframeProfile: "INTRADAY",
      regime: regime as any,
      strategy: "RSI_CROSS",
      confidence: 55,
      stopLossPercent: 2.0,
      takeProfitPercent: 4.0, // default 2:1 reward:risk
      minConfidenceToTrade: 45,
      rsiCross: {
        primaryKline: "15m",
        rsiPeriod: 14,
        rsiEmaPeriod: 9,
        enableThreshold: true,
        rsiThreshold: 50,
        enableHtfRsi: true,
        htfKline: "1h",
        enableCandleDir: false,
        candleKline: "15m",
      },
      rsiZone: {
        primaryKline: "15m",
        rsiPeriod: 14,
        rsiEmaPeriod: 9,
        rsiTop: 70,
        rsiBottom: 30,
        enableHtfRsi: false,
        htfKline: "1h",
        enableInitialCandle: false,
        excludeLatestCandle: true,
      },
      trendEma: {
        primaryKline: "15m",
        fastPeriod: 9,
        slowPeriod: 21,
        enableTrendGate: true,
        trendKline: "4h",
        trendEmaPeriod: 200,
        trendRange: 5,
      },
      meanRevertRsi: {
        primaryKline: "15m",
        rsiPeriod: 14,
        emaPeriod: 200,
        priceRange: 0.5,
        longRsi: 30,
        shortRsi: 70,
      },
      stochBbPattern: {
        primaryKline: "15m",
        bbPeriod: 20,
        bbStdDev: 2,
        stochK: 14,
        stochSmoothK: 3,
        stochSmoothD: 3,
        stochLong: 30,
        stochShort: 70,
        rangeCondition1: 10,
        rangeCondition2: 8,
        maxCandleCount: 5,
      },
      stochEmaKdj: {
        primaryKline: "15m",
        stochK: 14,
        stochSmoothK: 3,
        stochSmoothD: 3,
        stochLong: 30,
        stochShort: 70,
        emaPeriod: 21,
        emaRange: 0.5,
        enableKdj: false,
        kdjRangeLength: 9,
      },
    };
  }

  private mergeWithDefaults(parsed: Partial<AiTunedParams>): AiTunedParams {
    const defaults = this.getDefaultParams(parsed.regime || "MIXED");
    const stopLossPercent = parsed.stopLossPercent ?? defaults.stopLossPercent;
    return {
      ...defaults,
      ...parsed,
      stopLossPercent,
      // Fallback: if Haiku didn't return takeProfitPercent, use 2× SL distance
      takeProfitPercent: parsed.takeProfitPercent ?? stopLossPercent * 2,
      rsiCross: { ...defaults.rsiCross, ...(parsed.rsiCross || {}) },
      rsiZone: { ...defaults.rsiZone, ...(parsed.rsiZone || {}) },
      trendEma: { ...defaults.trendEma, ...(parsed.trendEma || {}) },
      meanRevertRsi: {
        ...defaults.meanRevertRsi,
        ...(parsed.meanRevertRsi || {}),
      },
      stochBbPattern: {
        ...defaults.stochBbPattern,
        ...(parsed.stochBbPattern || {}),
      },
      stochEmaKdj: { ...defaults.stochEmaKdj, ...(parsed.stochEmaKdj || {}) },
    };
  }

  // ─── AI risk advice for signal notifications ────────────────────────────

  async generateSignalAdvice(signal: {
    symbol: string;
    direction: string;
    entryPrice: number;
    stopLossPrice: number;
    stopLossPercent: number;
    strategy: string;
    regime: string;
    aiConfidence: number;
    reason?: string;
  }): Promise<string> {
    if (!this.enabled) return "";

    if (
      !(await this.checkRateLimit(HAIKU_DEMAND_RATE_KEY, this.maxHaikuDemandPerHour))
    ) {
      return "";
    }

    try {
      const coin = signal.symbol.replace("USDT", "");
      const indicators = await this.preComputeIndicators(coin.toLowerCase());

      const indicatorText = Object.entries(indicators)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");

      const prompt = `You are a crypto trading advisor. A trading signal has been generated. Provide a brief risk assessment and recommendation for the user.

Signal Details:
- Symbol: ${signal.symbol}
- Direction: ${signal.direction}
- Entry Price: $${signal.entryPrice}
- Stop Loss: $${signal.stopLossPrice} (-${signal.stopLossPercent.toFixed(1)}%)
- Strategy: ${signal.strategy}
- Market Regime: ${signal.regime}
- AI Confidence: ${signal.aiConfidence}%
- Signal Reason: ${signal.reason || "N/A"}

Current Market Indicators:
${indicatorText}

Return ONLY valid JSON:
{
  "riskLevel": "LOW|MEDIUM|HIGH",
  "advice": "<2-3 sentences in Vietnamese: brief risk assessment, what to watch, position sizing suggestion>",
  "keyRisks": ["<risk1>", "<risk2>"],
  "suggestedLeverage": "<1x-5x based on risk>"
}

Guidelines:
- LOW risk: strong trend alignment, high confidence, clear signals
- MEDIUM risk: mixed signals, moderate confidence, some conflicting indicators
- HIGH risk: counter-trend, low confidence, high volatility, conflicting timeframes
- Always warn about key price levels to watch
- Keep advice practical and actionable`;

      const response = await this.anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });

      await this.incrementRateLimit(HAIKU_DEMAND_RATE_KEY);

      const text = (response.content[0] as any).text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return "";

      const parsed = JSON.parse(jsonMatch[0]);

      // Sanitize AI text for Telegram Markdown
      const sanitize = (s: string) =>
        (s || "").replace(/[*_`\[\]]/g, "");

      const riskEmoji =
        parsed.riskLevel === "LOW"
          ? "🟢"
          : parsed.riskLevel === "HIGH"
            ? "🔴"
            : "🟡";

      const risksText = (parsed.keyRisks || [])
        .map((r: string) => `  ⚠️ ${sanitize(r)}`)
        .join("\n");

      return (
        `\n\n💡 *Khuyến nghị AI:*\n` +
        `${riskEmoji} Rủi ro: *${parsed.riskLevel || "MEDIUM"}*\n` +
        `├ Leverage đề xuất: *${parsed.suggestedLeverage || "2x"}*\n` +
        `├ ${sanitize(parsed.advice)}\n` +
        (risksText ? `${risksText}\n` : "") +
        `└ _Lưu ý: Đây là phân tích AI, không phải lời khuyên tài chính_`
      );
    } catch (err) {
      this.logger.debug(
        `[AiOptimizer] generateSignalAdvice failed: ${err?.message}`,
      );
      return "";
    }
  }

  // ─── AI market overview (for /ai market command) ────────────────────────

  async generateMarketOverview(
    coinData: {
      symbol: string;
      confidence: number;
      regime: string;
      strategy: string;
      lastPrice: number;
      quoteVolume: number;
      priceChangePercent: number;
    }[],
    analyticsData?: Record<string, any>,
  ): Promise<string> {
    if (!this.enabled) {
      return "⚠️ AI không khả dụng (thiếu API key).";
    }

    if (
      !(await this.checkRateLimit(HAIKU_DEMAND_RATE_KEY, this.maxHaikuDemandPerHour))
    ) {
      return "⚠️ Đã đạt giới hạn API. Thử lại sau.";
    }

    // Helper to format large numbers
    const fmtVol = (v: number) =>
      v >= 1e9 ? (v / 1e9).toFixed(1) + "B" :
      v >= 1e6 ? (v / 1e6).toFixed(1) + "M" :
      v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : v.toFixed(0);

    const fmtPrice = (p: number) =>
      p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
      p >= 1 ? p.toFixed(2) :
      p >= 0.01 ? p.toFixed(4) : p.toFixed(6);

    try {
      // Gather indicators for top coins (max 5 to keep prompt small)
      const topCoins = coinData
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);

      const coinSummaries: string[] = [];
      for (const c of topCoins) {
        const coin = c.symbol.replace("USDT", "").toLowerCase();
        const indicators = await this.preComputeIndicators(coin);
        const fa = analyticsData?.[c.symbol];
        const faStr = fa
          ? `funding=${(fa.fundingRate * 100).toFixed(3)}%, OI=${fmtVol(fa.openInterest * c.lastPrice)}, ` +
            `L/S=${fa.longShortRatio.toFixed(2)} (L${fa.longPercent.toFixed(0)}%/S${fa.shortPercent.toFixed(0)}%), ` +
            `takerBuySell=${fa.takerBuyRatio.toFixed(2)}`
          : "";
        coinSummaries.push(
          `${c.symbol}: price=$${fmtPrice(c.lastPrice)}, 24h_change=${c.priceChangePercent >= 0 ? "+" : ""}${c.priceChangePercent.toFixed(1)}%, ` +
          `24h_vol=$${fmtVol(c.quoteVolume)}, confidence=${c.confidence}%, regime=${c.regime}, strategy=${c.strategy}, ` +
          `RSI14_15m=${indicators.rsi14_15m || "N/A"}, RSI14_4h=${indicators.rsi14_4h || "N/A"}, ` +
          `BBWidth=${indicators.bbWidthPct || "N/A"}%, ATR_15m=${indicators.atrPct_15m || "N/A"}%` +
          (faStr ? `, ${faStr}` : ""),
        );
      }

      // Market-wide stats
      const totalVolume = coinData.reduce((sum, c) => sum + c.quoteVolume, 0);
      const avgChange = coinData.length > 0
        ? coinData.reduce((sum, c) => sum + c.priceChangePercent, 0) / coinData.length
        : 0;
      const gainers = coinData.filter((c) => c.priceChangePercent > 0).length;
      const losers = coinData.filter((c) => c.priceChangePercent < 0).length;

      const globalRegime = await this.redisService.get<string>("cache:ai:regime") || "UNKNOWN";

      const prompt = `You are a professional crypto market analyst. Provide a brief market overview for traders.

Global Regime: ${globalRegime}
Monitoring ${coinData.length} coins. Total 24h volume: $${fmtVol(totalVolume)}.
Market: ${gainers} coins up, ${losers} coins down, avg change: ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%.

Top coins by AI confidence (with real-time data):
${coinSummaries.join("\n")}

All coins: ${coinData.map((c) => `${c.symbol} $${fmtPrice(c.lastPrice)} (${c.priceChangePercent >= 0 ? "+" : ""}${c.priceChangePercent.toFixed(1)}%)`).join(", ")}

Return ONLY valid JSON (no trailing commas, no comments):
{
  "marketSentiment": "BULLISH|BEARISH|NEUTRAL|MIXED",
  "overview": "<3-4 sentences in Vietnamese: overall market condition, key trends, what to expect>",
  "topOpportunities": [
    {"symbol": "SYMBOL", "note": "short reason in Vietnamese"}
  ],
  "warnings": ["warning in Vietnamese"],
  "recommendation": "1-2 sentences in Vietnamese: should traders be aggressive or conservative right now?"
}

Be specific about price levels, RSI states, and trend directions. Focus on actionable insights.`;

      const response = await this.anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });

      await this.incrementRateLimit(HAIKU_DEMAND_RATE_KEY);

      const text = (response.content[0] as any).text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return "⚠️ AI không trả về kết quả hợp lệ.";

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        // Attempt to repair common JSON issues from LLM output
        const repaired = jsonMatch[0]
          .replace(/,\s*([\]}])/g, "$1")        // trailing commas
          .replace(/[\x00-\x1F]/g, " ")          // control chars
          .replace(/(["\w])\s*\n\s*(")/g, "$1,$2"); // missing commas between lines
        try {
          parsed = JSON.parse(repaired);
        } catch {
          this.logger.warn(`[AiOptimizer] JSON repair failed, raw: ${jsonMatch[0].slice(0, 200)}`);
          return "⚠️ AI trả về dữ liệu không hợp lệ. Vui lòng thử lại.";
        }
      }

      // Sanitize AI text: remove stray * and _ that break Telegram Markdown
      const sanitize = (s: string) =>
        (s || "").replace(/[*_`\[\]]/g, "");

      const sentimentEmoji =
        parsed.marketSentiment === "BULLISH" ? "🟢" :
        parsed.marketSentiment === "BEARISH" ? "🔴" :
        parsed.marketSentiment === "NEUTRAL" ? "⚪" : "🟡";

      // ── Build the message with real-time market data ──
      let result =
        `🌍 *Phân Tích Thị Trường AI*\n\n` +
        `${sentimentEmoji} Xu hướng: *${parsed.marketSentiment || "MIXED"}*\n` +
        `🏛 Regime: *${globalRegime}*\n` +
        `📊 Theo dõi: *${coinData.length} coins* | Vol: *$${fmtVol(totalVolume)}*\n` +
        `📈 Tăng: *${gainers}* | 📉 Giảm: *${losers}* | TB: *${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%*\n\n`;

      // Real-time price table for top coins
      result += `💰 *Giá & Volume (real-time):*\n`;
      const displayCoins = coinData
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, 8);
      for (const c of displayCoins) {
        const changeIcon = c.priceChangePercent > 0 ? "🟢" : c.priceChangePercent < 0 ? "🔴" : "⚪";
        const sign = c.priceChangePercent >= 0 ? "+" : "";
        result += `  ${changeIcon} ${c.symbol.replace("USDT", "")} $${fmtPrice(c.lastPrice)} (${sign}${c.priceChangePercent.toFixed(1)}%) Vol:$${fmtVol(c.quoteVolume)}\n`;
      }

      // Futures analytics section
      if (analyticsData && Object.keys(analyticsData).length > 0) {
        result += `\n🏦 *Futures Analytics:*\n`;
        const topByVol = displayCoins.slice(0, 5);
        for (const c of topByVol) {
          const fa = analyticsData[c.symbol];
          if (!fa) continue;
          const coin = c.symbol.replace("USDT", "");
          const fundPct = (fa.fundingRate * 100).toFixed(3);
          const fundIcon = fa.fundingRate > 0.0005 ? "🔴" : fa.fundingRate < -0.0005 ? "🟢" : "⚪";
          const oiUsd = fa.openInterest * c.lastPrice;
          result += `  ${coin}: ${fundIcon}F:${fundPct}% | OI:$${fmtVol(oiUsd)} | L${fa.longPercent.toFixed(0)}/S${fa.shortPercent.toFixed(0)}\n`;
        }
      }

      result += `\n📝 *Tổng quan:*\n${sanitize(parsed.overview)}\n`;

      if (parsed.topOpportunities?.length > 0) {
        result += `\n🎯 *Cơ hội nổi bật:*\n`;
        for (const opp of parsed.topOpportunities) {
          result += `  • *${opp.symbol}*: ${sanitize(opp.note)}\n`;
        }
      }

      if (parsed.warnings?.length > 0) {
        result += `\n⚠️ *Cảnh báo:*\n`;
        for (const w of parsed.warnings) {
          result += `  • ${sanitize(w)}\n`;
        }
      }

      result +=
        `\n💬 *Khuyến nghị:*\n${sanitize(parsed.recommendation)}\n\n` +
        `_Cập nhật lúc: ${new Date().toLocaleTimeString("vi-VN")}_\n` +
        `_Đây là phân tích AI, không phải lời khuyên tài chính._`;

      return result;
    } catch (err) {
      this.logger.warn(`[AiOptimizer] generateMarketOverview failed: ${err?.message}`);
      return `⚠️ Lỗi khi phân tích thị trường: ${err?.message}`;
    }
  }

  // ─── Rate limiting ────────────────────────────────────────────────────────

  private async checkRateLimit(
    key: string,
    maxPerHour: number,
  ): Promise<boolean> {
    const count = (await this.redisService.get<number>(key)) || 0;
    return count < maxPerHour;
  }

  private async incrementRateLimit(key: string): Promise<void> {
    const count = (await this.redisService.get<number>(key)) || 0;
    await this.redisService.set(key, count + 1, RATE_WINDOW);
  }

  // ─── Persist regime history to MongoDB ───────────────────────────────────

  private async saveRegimeHistory(
    scope: string,
    regime: string,
    confidence: number,
    params: AiTunedParams | null,
    model: string,
    usage: any,
  ): Promise<void> {
    try {
      const tokensIn = usage?.input_tokens || 0;
      const tokensOut = usage?.output_tokens || 0;
      const isSonnet = model.includes("sonnet");
      const costUsd =
        (tokensIn * (isSonnet ? SONNET_INPUT_COST : HAIKU_INPUT_COST) +
          tokensOut * (isSonnet ? SONNET_OUTPUT_COST : HAIKU_OUTPUT_COST)) /
        1_000_000;

      await this.regimeHistoryModel.create({
        assessedAt: new Date(),
        scope,
        regime,
        confidence,
        strategy: params?.strategy,
        params,
        model,
        tokensIn,
        tokensOut,
        costUsd,
      });
    } catch (err) {
      this.logger.debug(
        `[AiOptimizer] Failed to save regime history: ${err?.message}`,
      );
    }
  }
}
