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

const AI_PARAMS_TTL = 2 * 60 * 60; // 2h cache for tuned params
const AI_PARAMS_JITTER = 30 * 60; // ±15 min random offset to stagger expiry
const AI_REGIME_TTL = 4 * 60 * 60; // 4h cache for global regime
const HAIKU_RATE_KEY = "cache:ai:rate:haiku"; // single rate limiter (only tuning uses AI now)
const HAIKU_SCAN_BURST_KEY = "cache:ai:rate:haiku:burst"; // per-scan burst limiter
const MAX_RETUNES_PER_SCAN = 5; // max fresh Haiku calls per 30s scan cycle
const SCAN_BURST_TTL = 35; // slightly longer than 30s scan interval
const RATE_WINDOW = 60 * 60; // 1h window

@Injectable()
export class AiOptimizerService {
  private readonly logger = new Logger(AiOptimizerService.name);
  private anthropic: Anthropic;
  private readonly enabled: boolean;
  private readonly maxHaikuPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly indicatorService: IndicatorService,
    @InjectModel(AiRegimeHistory.name)
    private readonly regimeHistoryModel: Model<AiRegimeHistoryDocument>,
  ) {
    this.enabled = configService.get("AI_ENABLED", "true") === "true";
    this.maxHaikuPerHour = parseInt(
      configService.get("AI_MAX_HAIKU_PER_HOUR", "60"),
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

  // ─── Global regime assessment (algorithmic, based on BTC indicators) ──────

  async assessGlobalRegime(): Promise<string> {
    const cacheKey = "cache:ai:regime";
    const cached = await this.redisService.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const indicators = await this.preComputeIndicators("btc");
      if (!indicators.price) {
        return "MIXED";
      }

      const rsi = parseFloat(indicators.rsi14_15m) || 50;
      const rsi4h = indicators.rsi14_4h !== "N/A" ? parseFloat(indicators.rsi14_4h) : 50;
      const atr15m = parseFloat(indicators.atrPct_15m) || 1;
      const atr4h = indicators.atrPct_4h !== "N/A" ? parseFloat(indicators.atrPct_4h) : 2;
      const bbWidth = parseFloat(indicators.bbWidthPct) || 3;
      const priceVsEma9 = parseFloat(indicators.priceVsEma9_pct) || 0;
      const priceVsEma200 = indicators.priceVsEma200_pct !== "N/A"
        ? parseFloat(indicators.priceVsEma200_pct)
        : 0;

      let regime = "MIXED";
      let confidence = 50;

      // VOLATILE: high ATR + wide BB — market is whipping around
      if (atr15m > 1.5 && bbWidth > 5) {
        regime = "VOLATILE";
        confidence = Math.min(85, 50 + atr15m * 10);
      }
      // STRONG_TREND: RSI extreme + price far from EMA + 4h RSI confirms
      else if (
        (rsi > 65 || rsi < 35) &&
        Math.abs(priceVsEma9) > 0.5 &&
        ((rsi > 60 && rsi4h > 55) || (rsi < 40 && rsi4h < 45))
      ) {
        regime = "STRONG_TREND";
        confidence = Math.min(85, 50 + Math.abs(rsi - 50));
      }
      // RANGE_BOUND: tight BB + RSI near middle + low ATR
      else if (bbWidth < 3 && rsi > 40 && rsi < 60 && atr15m < 1.0) {
        regime = "RANGE_BOUND";
        confidence = Math.min(80, 50 + (60 - bbWidth) * 5);
      }

      await this.redisService.set(cacheKey, regime, AI_REGIME_TTL);

      await this.saveRegimeHistory("global", regime, confidence, null, "algo", null);

      this.logger.log(
        `[AiOptimizer] Global regime: ${regime} (confidence: ${confidence}%, BTC RSI=${rsi.toFixed(0)} ATR=${atr15m}% BB=${bbWidth}%)`,
      );
      return regime;
    } catch (err) {
      this.logger.warn(`[AiOptimizer] assessGlobalRegime algo failed: ${err?.message}`);
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
      !(await this.checkRateLimit(HAIKU_RATE_KEY, this.maxHaikuPerHour))
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
      await this.incrementRateLimit(HAIKU_RATE_KEY);
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

  // ─── Risk advice for signal notifications (algorithmic, no AI call) ─────

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
    try {
      const coin = signal.symbol.replace("USDT", "").toLowerCase();
      const indicators = await this.preComputeIndicators(coin);

      const rsi = parseFloat(indicators.rsi14_15m) || 50;
      const rsi4h = indicators.rsi14_4h !== "N/A" ? parseFloat(indicators.rsi14_4h) : 50;
      const atr = parseFloat(indicators.atrPct_15m) || 1;
      const bbWidth = parseFloat(indicators.bbWidthPct) || 3;

      // Determine risk level from data
      let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
      const risks: string[] = [];

      // HIGH risk factors
      if (signal.aiConfidence < 50) { riskLevel = "HIGH"; risks.push("Confidence thấp"); }
      if (atr > 2.0) { riskLevel = "HIGH"; risks.push(`Biến động cao (ATR ${atr.toFixed(1)}%)`); }
      if (signal.direction === "LONG" && rsi > 70) { risks.push("RSI quá mua"); }
      if (signal.direction === "SHORT" && rsi < 30) { risks.push("RSI quá bán"); }
      if (signal.direction === "LONG" && rsi4h > 75) { riskLevel = "HIGH"; risks.push("RSI 4h quá mua"); }
      if (signal.direction === "SHORT" && rsi4h < 25) { riskLevel = "HIGH"; risks.push("RSI 4h quá bán"); }

      // LOW risk factors (only if no HIGH flags)
      if (riskLevel !== "HIGH" && signal.aiConfidence >= 70 && atr < 1.5) {
        const trendAligned =
          (signal.direction === "LONG" && rsi > 50 && rsi4h > 50) ||
          (signal.direction === "SHORT" && rsi < 50 && rsi4h < 50);
        if (trendAligned) riskLevel = "LOW";
      }

      // Suggested leverage based on risk + SL distance
      const leverage = riskLevel === "LOW" ? "3x-5x"
        : riskLevel === "HIGH" ? "1x-2x"
        : signal.stopLossPercent > 3 ? "1x-2x" : "2x-3x";

      const riskEmoji = riskLevel === "LOW" ? "🟢" : riskLevel === "HIGH" ? "🔴" : "🟡";
      const risksText = risks.length > 0
        ? risks.map((r) => `  ⚠️ ${r}`).join("\n") + "\n"
        : "";

      // Key levels to watch
      const priceVsEma9 = parseFloat(indicators.priceVsEma9_pct) || 0;
      const supportResist = priceVsEma9 > 0
        ? `EMA9 hỗ trợ tại $${indicators.ema9_15m}`
        : `EMA9 kháng cự tại $${indicators.ema9_15m}`;

      return (
        `\n\n💡 *Phân tích:*\n` +
        `${riskEmoji} Rủi ro: *${riskLevel}*\n` +
        `├ Leverage: *${leverage}*\n` +
        `├ ${supportResist}\n` +
        (risksText ? risksText : "") +
        `└ _RSI: ${rsi.toFixed(0)} | ATR: ${atr.toFixed(1)}% | BB: ${bbWidth.toFixed(1)}%_`
      );
    } catch (err) {
      this.logger.debug(
        `[AiOptimizer] generateSignalAdvice failed: ${err?.message}`,
      );
      return "";
    }
  }

  // ─── Market overview (algorithmic, no AI call) ─────────────────────────

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
    const fmtVol = (v: number) =>
      v >= 1e9 ? (v / 1e9).toFixed(1) + "B" :
      v >= 1e6 ? (v / 1e6).toFixed(1) + "M" :
      v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : v.toFixed(0);

    const fmtPrice = (p: number) =>
      p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
      p >= 1 ? p.toFixed(2) :
      p >= 0.01 ? p.toFixed(4) : p.toFixed(6);

    try {
      // Market-wide stats
      const totalVolume = coinData.reduce((sum, c) => sum + c.quoteVolume, 0);
      const avgChange = coinData.length > 0
        ? coinData.reduce((sum, c) => sum + c.priceChangePercent, 0) / coinData.length
        : 0;
      const gainers = coinData.filter((c) => c.priceChangePercent > 0).length;
      const losers = coinData.filter((c) => c.priceChangePercent < 0).length;

      // Determine sentiment from data
      let sentiment: string;
      let sentimentEmoji: string;
      if (avgChange > 3 && gainers > losers * 2) {
        sentiment = "BULLISH"; sentimentEmoji = "🟢";
      } else if (avgChange < -3 && losers > gainers * 2) {
        sentiment = "BEARISH"; sentimentEmoji = "🔴";
      } else if (Math.abs(avgChange) < 1 && Math.abs(gainers - losers) < coinData.length * 0.2) {
        sentiment = "NEUTRAL"; sentimentEmoji = "⚪";
      } else {
        sentiment = "MIXED"; sentimentEmoji = "🟡";
      }

      const globalRegime = await this.redisService.get<string>("cache:ai:regime") || "MIXED";

      // ── Build the message with real-time market data ──
      let result =
        `🌍 *Phân Tích Thị Trường*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${sentimentEmoji} Xu hướng: *${sentiment}*\n` +
        `🏛 Regime: *${globalRegime}*\n` +
        `📊 Theo dõi: *${coinData.length} coins* | Vol: *$${fmtVol(totalVolume)}*\n` +
        `📈 Tăng: *${gainers}* | 📉 Giảm: *${losers}* | TB: *${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%*\n\n`;

      // Real-time price table — top by volume
      result += `💰 *Giá & Volume:*\n`;
      const displayCoins = [...coinData]
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

      // Top movers
      const topGainers = [...coinData].sort((a, b) => b.priceChangePercent - a.priceChangePercent).slice(0, 3);
      const topLosers = [...coinData].sort((a, b) => a.priceChangePercent - b.priceChangePercent).slice(0, 3);

      result += `\n🚀 *Top tăng:*\n`;
      for (const c of topGainers) {
        result += `  🟢 ${c.symbol.replace("USDT", "")} +${c.priceChangePercent.toFixed(1)}% ($${fmtPrice(c.lastPrice)})\n`;
      }
      result += `\n📉 *Top giảm:*\n`;
      for (const c of topLosers) {
        result += `  🔴 ${c.symbol.replace("USDT", "")} ${c.priceChangePercent.toFixed(1)}% ($${fmtPrice(c.lastPrice)})\n`;
      }

      // High-confidence coins — opportunities
      const highConf = [...coinData].filter((c) => c.confidence >= 65).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
      if (highConf.length > 0) {
        result += `\n🎯 *Confidence cao:*\n`;
        for (const c of highConf) {
          result += `  • ${c.symbol.replace("USDT", "")} — ${c.confidence}% (${c.strategy}, ${c.regime})\n`;
        }
      }

      // Warnings from futures data
      const warnings: string[] = [];
      if (analyticsData) {
        for (const [sym, fa] of Object.entries(analyticsData) as any[]) {
          if (Math.abs(fa.fundingRate) > 0.001) {
            const coin = sym.replace("USDT", "");
            warnings.push(`${coin} funding ${fa.fundingRate > 0 ? "cao" : "âm"} (${(fa.fundingRate * 100).toFixed(3)}%)`);
          }
        }
      }
      if (warnings.length > 0) {
        result += `\n⚠️ *Cảnh báo:*\n`;
        for (const w of warnings.slice(0, 4)) {
          result += `  • ${w}\n`;
        }
      }

      result +=
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `_${new Date().toLocaleTimeString("vi-VN")} • Binance Futures_`;

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
      // Haiku: $0.80/1M input, $4.00/1M output
      const costUsd = (tokensIn * 0.8 + tokensOut * 4.0) / 1_000_000;

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
