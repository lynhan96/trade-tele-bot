import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { RedisService } from "../../redis/redis.service";
import { IndicatorService } from "../indicators/indicator.service";
import {
  AiRegimeHistory,
  AiRegimeHistoryDocument,
} from "../../schemas/ai-regime-history.schema";
import {
  AiMarketConfig,
  AiMarketConfigDocument,
} from "../../schemas/ai-market-config.schema";
import { AiTunedParams } from "./ai-tuned-params.interface";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const AI_PARAMS_TTL = 4 * 60 * 60; // 4h cache for tuned params (saves ~50% API calls)
const AI_PARAMS_JITTER = 45 * 60; // ±22.5 min random offset to stagger expiry
const AI_REGIME_TTL = 30 * 60; // 30min cache — react faster to market changes
const HAIKU_RATE_KEY = "cache:ai:rate:haiku"; // single rate limiter (only tuning uses AI now)
const AI_MARKET_FILTERS_KEY = "cache:ai:market-filters"; // AI-decided coin filter settings
const AI_MARKET_FILTERS_TTL = 8 * 60 * 60; // 8h — re-evaluated on regime change
const HAIKU_SCAN_BURST_KEY = "cache:ai:rate:haiku:burst"; // per-scan burst limiter
const MAX_RETUNES_PER_SCAN = 10; // up to 10 Haiku calls per 30s scan (covers 100-coin shortlist faster)
const SCAN_BURST_TTL = 35; // slightly longer than 30s scan interval
const RATE_WINDOW = 60 * 60; // 1h window

const GPT_MODEL = "gpt-4o-mini";
const GPT_RATE_KEY = "cache:ai:rate:gpt"; // hourly budget for GPT fallback

@Injectable()
export class AiOptimizerService {
  private readonly logger = new Logger(AiOptimizerService.name);
  private anthropic: Anthropic;
  private openai: OpenAI | null = null;
  private readonly enabled: boolean;
  private readonly maxHaikuPerHour: number;
  private readonly maxGptPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly indicatorService: IndicatorService,
    @InjectModel(AiRegimeHistory.name)
    private readonly regimeHistoryModel: Model<AiRegimeHistoryDocument>,
    @InjectModel(AiMarketConfig.name)
    private readonly marketConfigModel: Model<AiMarketConfigDocument>,
  ) {
    this.enabled = configService.get("AI_ENABLED", "true") === "true";
    this.maxHaikuPerHour = parseInt(
      configService.get("AI_MAX_HAIKU_PER_HOUR", "60"),
    );
    this.maxGptPerHour = parseInt(configService.get("AI_MAX_GPT_PER_HOUR", "200"));

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

    const openaiKey = configService.get<string>("OPENAI_API_KEY");
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.log("[AiOptimizer] GPT-4o-mini fallback enabled");
    }
  }

  // ─── Flush all coin param caches (e.g. on startup or regime change) ────────

  async flushParamCaches(): Promise<void> {
    const prefix = "binance-bot:";
    const keys = await this.redisService.keys("cache:ai:params:*");
    if (keys.length === 0) return;
    await Promise.all(
      keys.map((k) => {
        const unprefixed = k.startsWith(prefix) ? k.slice(prefix.length) : k;
        return this.redisService.delete(unprefixed);
      }),
    );
    this.logger.log(`[AiOptimizer] Flushed ${keys.length} coin param cache(s) on startup`);
  }

  // ─── Global regime assessment (algorithmic, based on BTC indicators) ──────

  async assessGlobalRegime(): Promise<string> {
    const cacheKey = "cache:ai:regime";
    const prevRegimeKey = "cache:ai:regime:prev";
    const cached = await this.redisService.get<string>(cacheKey);
    if (cached) {
      this.logger.debug(`[AiOptimizer] assessGlobalRegime: cached=${cached}`);
      return cached;
    }

    this.logger.log(`[AiOptimizer] assessGlobalRegime: no cache, computing...`);
    try {
      const indicators = await this.preComputeIndicators("btc");
      if (!indicators.price) {
        this.logger.warn(`[AiOptimizer] assessGlobalRegime: no BTC price data — returning MIXED`);
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

      // CRASH DETECTION: RSI low + price below EMA9 → immediate STRONG_BEAR
      // Catches dumps even if price hasn't crossed EMA200 yet (e.g. BTC RSI=31, down from EMA9)
      if (rsi < 35 && priceVsEma9 < -0.5) {
        regime = "STRONG_BEAR";
        confidence = Math.min(90, 50 + (50 - rsi));
      }
      // VOLATILE: high ATR + wide BB — market is whipping around
      else if (atr15m > 1.5 && bbWidth > 5) {
        regime = "VOLATILE";
        confidence = Math.min(85, 50 + atr15m * 10);
      }
      // STRONG_BULL: RSI bullish + price above EMA9 + 4h RSI confirms + EMA200 supports uptrend
      else if (
        rsi > 58 && priceVsEma9 > 0.3 && rsi4h > 52 &&
        priceVsEma200 > 0 // price above long-term EMA200 = structural uptrend
      ) {
        regime = "STRONG_BULL";
        confidence = Math.min(85, 45 + (rsi - 50) + (priceVsEma200 > 2 ? 5 : 0));
      }
      // STRONG_BEAR: RSI bearish + price below EMA9 + 4h RSI confirms + EMA200 supports downtrend
      else if (
        rsi < 42 && priceVsEma9 < -0.3 && rsi4h < 48 &&
        priceVsEma200 < 0 // price below long-term EMA200 = structural downtrend
      ) {
        regime = "STRONG_BEAR";
        confidence = Math.min(85, 45 + (50 - rsi) + (priceVsEma200 < -2 ? 5 : 0));
      }
      // RANGE_BOUND: tight BB + RSI near middle + low ATR
      else if (bbWidth < 3 && rsi > 40 && rsi < 60 && atr15m < 1.0) {
        regime = "RANGE_BOUND";
        confidence = Math.min(80, 50 + (60 - bbWidth) * 5);
      }
      // SIDEWAYS: moderately tight BB + mid-range RSI + calm ATR — catches the "gray zone" before MIXED
      else if (bbWidth < 4.5 && rsi > 40 && rsi < 60 && atr15m < 1.2) {
        regime = "SIDEWAYS";
        confidence = Math.min(75, 50 + (4.5 - bbWidth) * 5);
      }

      await this.redisService.set(cacheKey, regime, AI_REGIME_TTL);
      // Store BTC context for VOLATILE direction filter in processCoin
      await this.redisService.set("cache:ai:regime:btc-context", {
        rsi, rsi4h, priceVsEma9, priceVsEma200, atr15m, bbWidth,
      }, AI_REGIME_TTL);

      // If regime changed → flush all coin param caches so Haiku re-evaluates with new strategy
      const prevRegime = await this.redisService.get<string>(prevRegimeKey);
      if (prevRegime && prevRegime !== regime) {
        this.logger.log(
          `[AiOptimizer] Regime changed: ${prevRegime} → ${regime} — flushing coin param caches`,
        );
        const paramKeys = await this.redisService.keys("cache:ai:params:*");
        // keys() returns full prefixed keys (e.g. "binance-bot:cache:ai:params:BTC")
        // delete() adds prefix itself, so strip it first
        const prefix = "binance-bot:";
        await Promise.all(
          paramKeys.map((k) => {
            const unprefixed = k.startsWith(prefix) ? k.slice(prefix.length) : k;
            return this.redisService.delete(unprefixed);
          }),
        );
        this.logger.log(`[AiOptimizer] Flushed ${paramKeys.length} coin param cache(s)`);
      }
      await this.redisService.set(prevRegimeKey, regime, AI_REGIME_TTL * 3);

      // Tune market filter settings when regime changes or no cached filters yet
      if (prevRegime !== regime || !(await this.redisService.get(AI_MARKET_FILTERS_KEY))) {
        this.tuneMarketFilters(regime, { rsi15m: rsi, atr15m, bbWidth }).catch((e) =>
          this.logger.warn(`[AiOptimizer] Filter tuning failed: ${e?.message}`),
        );
      }

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

  // ─── AI-decided coin filter settings (saved to MongoDB + Redis) ─────────

  async tuneMarketFilters(
    regime: string,
    indicators: { rsi15m: number; atr15m: number; bbWidth: number },
  ): Promise<void> {
    if (!this.enabled) return;

    // 1. Fetch last 5 decisions as conversation history
    const history = await this.marketConfigModel
      .find()
      .sort({ assessedAt: -1 })
      .limit(5)
      .lean();

    // 2. Format history as conversation context
    const historyText =
      history.length > 0
        ? history
            .reverse()
            .map(
              (h) =>
                `[${h.assessedAt.toISOString().slice(0, 16)}] Regime=${h.regime} → ` +
                `minVol=$${(h.minVolumeUsd / 1e6).toFixed(0)}M, ` +
                `minChange=${h.minPriceChangePct}%, maxCoins=${h.maxShortlistSize}` +
                (h.reasoning ? ` — "${h.reasoning}"` : ""),
            )
            .join("\n")
        : "No previous decisions.";

    // 3. Call Haiku
    const prompt = `You decide optimal crypto coin filter settings for trading signals.

Current market: regime=${regime}, BTC RSI(15m)=${indicators.rsi15m.toFixed(1)}, ATR(15m)=${indicators.atr15m.toFixed(2)}%, BB Width=${indicators.bbWidth.toFixed(2)}%

Past decisions (conversation history):
${historyText}

Constraints:
- minVolumeUsd: 3000000 to 100000000
- minPriceChangePct: 0.1 to 3.0
- maxShortlistSize: 10 to 100

Guidelines:
- VOLATILE: more coins moving → widen filter, increase shortlist
- STRONG_BULL/STRONG_BEAR: normal volume, moderate shortlist
- SIDEWAYS/RANGE_BOUND: lower thresholds to catch subtle moves
- MIXED: balanced defaults

Reply ONLY with valid JSON (no markdown):
{"minVolumeUsd":10000000,"minPriceChangePct":0.3,"maxShortlistSize":50,"reasoning":"brief reason"}`;

    const resp = await this.anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const text = ((resp.content[0] as any).text || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Haiku filter response");

    const parsed = JSON.parse(jsonMatch[0]);

    const minVolumeUsd = Number(parsed.minVolumeUsd);
    const minPriceChangePct = Number(parsed.minPriceChangePct);
    // Clamp to at least the user-configured minimum from .env
    const configuredMin = parseInt(this.configService.get("AI_MAX_SHORTLIST_SIZE", "50"));
    const maxShortlistSize = Math.max(Number(parsed.maxShortlistSize), configuredMin);

    // 4. Store in MongoDB
    await this.marketConfigModel.create({
      assessedAt: new Date(),
      regime,
      minVolumeUsd,
      minPriceChangePct,
      maxShortlistSize,
      reasoning: parsed.reasoning,
      model: HAIKU_MODEL,
      tokensIn: resp.usage.input_tokens,
      tokensOut: resp.usage.output_tokens,
    });

    // 5. Cache in Redis (8h)
    await this.redisService.set(
      AI_MARKET_FILTERS_KEY,
      { minVolumeUsd, minPriceChangePct, maxShortlistSize },
      AI_MARKET_FILTERS_TTL,
    );

    this.logger.log(
      `[AiOptimizer] Market filters tuned for ${regime}: ` +
        `vol=$${(minVolumeUsd / 1e6).toFixed(0)}M, ` +
        `change=${minPriceChangePct}%, coins=${maxShortlistSize} — ${parsed.reasoning}`,
    );
  }

  // ─── Per-coin parameter tuning (Haiku, cached 2h with jitter) ───────────

  async tuneParamsForSymbol(
    coin: string,
    currency: string,
    globalRegime: string,
    forceProfile?: string,
  ): Promise<AiTunedParams> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const cacheKey = forceProfile
      ? `cache:ai:params:${symbol}:${forceProfile}`
      : `cache:ai:params:${symbol}`;

    const cached = await this.redisService.get<AiTunedParams>(cacheKey);
    if (cached) return cached;

    // Pre-compute indicators once — shared across all AI models in the waterfall
    const indicators = this.enabled ? await this.preComputeIndicators(coin) : {};

    // Algorithmic strategy selection — gives per-coin diversity based on indicators
    const algoStrategy = Object.keys(indicators).length > 0
      ? this.selectStrategiesForCoin(globalRegime, indicators)
      : null;

    // Helper: apply profile override, cache result, save history, log
    const saveAndReturn = async (params: AiTunedParams, model: string, tag = ""): Promise<AiTunedParams> => {
      // Override GPT's strategy with algorithmic selection (GPT only tunes SL/TP/confidence)
      if (algoStrategy) params.strategy = algoStrategy;
      if (forceProfile) params = this.applyForcedProfile(params, forceProfile);
      const jitter = Math.floor(Math.random() * AI_PARAMS_JITTER);
      await this.redisService.set(cacheKey, params, AI_PARAMS_TTL + jitter);
      await this.saveRegimeHistory(symbol, params.regime, params.confidence, params, model, null);
      this.logger.log(`[AiOptimizer] ${symbol}${forceProfile ? `:${forceProfile}` : ""}${tag}: regime=${params.regime} strategy=${params.strategy} confidence=${params.confidence}%`);
      return params;
    };

    // ── 1. GPT-4o-mini (primary — cheapest, $0.15/MTok input) ──────────────
    if (this.openai && (await this.checkRateLimit(GPT_RATE_KEY, this.maxGptPerHour))) {
      try {
        const params = await this.callGpt(symbol, globalRegime, indicators);
        await this.incrementRateLimit(GPT_RATE_KEY);
        return saveAndReturn(params, GPT_MODEL, " (GPT)");
      } catch (err) {
        this.logger.warn(`[AiOptimizer] GPT call failed for ${symbol}: ${err?.message}`);
      }
    }

    // ── 2. Haiku (backup — better strategy diversity, used when GPT rate-limited) ─
    if (this.enabled) {
      const haikuBurst = (await this.redisService.get<number>(HAIKU_SCAN_BURST_KEY)) || 0;
      if (haikuBurst < MAX_RETUNES_PER_SCAN && (await this.checkRateLimit(HAIKU_RATE_KEY, this.maxHaikuPerHour))) {
        try {
          const params = await this.callHaiku(symbol, globalRegime, indicators);
          await this.incrementRateLimit(HAIKU_RATE_KEY);
          await this.redisService.set(HAIKU_SCAN_BURST_KEY, haikuBurst + 1, SCAN_BURST_TTL);
          return saveAndReturn(params, HAIKU_MODEL, " (Haiku)");
        } catch (err) {
          this.logger.warn(`[AiOptimizer] Haiku fallback failed for ${symbol}: ${err?.message}`);
        }
      }
    }

    // ── 4. Static ATR-adjusted defaults (still cache so /ai market works) ──
    let defaults = await this.getAtrAdjustedDefaults(coin, globalRegime);
    if (algoStrategy) defaults.strategy = algoStrategy;
    if (forceProfile) defaults = this.applyForcedProfile(defaults, forceProfile);
    const jitter = Math.floor(Math.random() * AI_PARAMS_JITTER);
    await this.redisService.set(cacheKey, defaults, AI_PARAMS_TTL + jitter);
    this.logger.debug(`[AiOptimizer] ${symbol}${forceProfile ? `:${forceProfile}` : ""} using static defaults SL=${defaults.stopLossPercent}%`);
    return defaults;
  }

  /**
   * Override timeframe settings for a forced profile (INTRADAY or SWING).
   * No extra Haiku call — reuses base params and only adjusts kline settings.
   */
  private applyForcedProfile(params: AiTunedParams, profile: string): AiTunedParams {
    const result = { ...params };
    result.timeframeProfile = profile as any;

    if (profile === "SWING") {
      // SWING: 4h primary, 1d HTF, wider SL
      result.stopLossPercent = Math.max(3, result.stopLossPercent);
      result.takeProfitPercent = Math.max(result.stopLossPercent * 2, result.takeProfitPercent);
      if (result.rsiCross) {
        result.rsiCross = { ...result.rsiCross, primaryKline: "4h", htfKline: "1d", candleKline: "4h" };
      }
      if (result.rsiZone) {
        result.rsiZone = { ...result.rsiZone, primaryKline: "4h", htfKline: "1d" };
      }
    } else {
      // INTRADAY: 15m primary, 1h HTF
      if (result.rsiCross) {
        result.rsiCross = { ...result.rsiCross, primaryKline: "15m", htfKline: "1h", candleKline: "15m" };
      }
      if (result.rsiZone) {
        result.rsiZone = { ...result.rsiZone, primaryKline: "15m", htfKline: "1h" };
      }
    }

    return result;
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

  /**
   * Algorithmic strategy selection based on per-coin indicators.
   * Returns pipe-delimited strategies tailored to this coin's condition.
   * Deterministic, free, and gives actual per-coin diversity.
   */
  private selectStrategiesForCoin(
    globalRegime: string,
    indicators: Record<string, any>,
  ): string {
    const rsi = parseFloat(indicators.rsi14_15m) || 50;
    const rsi4h = indicators.rsi14_4h !== "N/A" ? parseFloat(indicators.rsi14_4h) : 50;
    const bbWidth = parseFloat(indicators.bbWidthPct) || 3;
    const atr = parseFloat(indicators.atrPct_15m) || 1;
    const priceVsEma9 = parseFloat(indicators.priceVsEma9_pct) || 0;
    const priceVsEma21_4h = indicators.priceVsEma21_4h_pct !== "N/A"
      ? parseFloat(indicators.priceVsEma21_4h_pct) : 0;

    const isBull = globalRegime === "STRONG_BULL";
    const isBear = globalRegime === "STRONG_BEAR";
    const isTrend = isBull || isBear;
    const isSideways = globalRegime === "SIDEWAYS";
    const isRange = globalRegime === "RANGE_BOUND";
    const isVolatile = globalRegime === "VOLATILE";

    const strategies: string[] = [];

    // ── RSI_CROSS is the best performer (80% win, +2.2% avg) — prioritize it ──
    strategies.push("RSI_CROSS");

    // ── EMA_PULLBACK only for trending + very close to EMA21 (tighter filter) ──
    // Tightened from 5% to 2% — reduces false pullback signals on volatile small-caps
    if (isTrend && Math.abs(priceVsEma21_4h) < 2) {
      strategies.push("EMA_PULLBACK");
    }

    // ── RSI not neutral → mean reversion candidate ──────────────────
    if (rsi < 40 || rsi > 60) {
      strategies.push("MEAN_REVERT_RSI");
    }

    // ── Tight Bollinger Bands → scalp range bounces ────────────────────
    if (bbWidth < 3 && (isSideways || isRange)) {
      strategies.push("BB_SCALP");
    }

    // ── Trending with clear momentum → trend following ─────────────────
    if (isTrend && Math.abs(priceVsEma9) < 3) {
      strategies.push("TREND_EMA");
    }

    // ── Volatile with RSI at extremes → zone trading ───────────────────
    if (isVolatile && (rsi < 30 || rsi > 70)) {
      strategies.push("RSI_ZONE");
    }

    // ── Stoch + BB pattern for range-bound ─────────────────────────────
    if (isRange && bbWidth < 4) {
      strategies.push("STOCH_BB_PATTERN");
    }

    // Cap at 3 strategies
    return strategies.slice(0, 3).join("|");
  }

  private buildTuningPrompt(
    symbol: string,
    globalRegime: string,
    indicators: Record<string, any>,
  ): string {
    // Strategy is now selected algorithmically — GPT only tunes risk params
    const strategy = this.selectStrategiesForCoin(globalRegime, indicators);
    const atr = parseFloat(indicators.atrPct_15m) || 1;
    const rsi = parseFloat(indicators.rsi14_15m) || 50;
    const rsi4h = indicators.rsi14_4h !== "N/A" ? parseFloat(indicators.rsi14_4h) : 50;
    const bbWidth = parseFloat(indicators.bbWidthPct) || 3;
    const priceVsEma200 = indicators.priceVsEma200_pct !== "N/A" ? indicators.priceVsEma200_pct : "N/A";

    return `Risk param optimizer for ${symbol}. Regime: ${globalRegime}. Strategy: ${strategy}.
Key data: RSI(15m)=${rsi.toFixed(1)}, RSI(4h)=${rsi4h.toFixed(1)}, ATR(15m)=${atr.toFixed(2)}%, BBWidth=${bbWidth.toFixed(2)}%, priceVsEMA200=${priceVsEma200}%.

Set SL/TP based on this coin's volatility (ATR). MINIMUM SL is 3%:
- Low ATR (<1%): SL 3.0%, TP 2-3x SL
- Medium ATR (1-2%): SL 3.0-4.0%, TP 2-3x SL
- High ATR (>2%): SL 4.0-6.0%, TP 2-4x SL
- The strategy "${strategy}" is pre-selected. Return it as-is.

Set confidence based on alignment:
- RSI + regime aligned (e.g. RSI>50 in STRONG_BULL): higher confidence 70-85
- RSI neutral (40-60): moderate 55-70
- RSI against regime (e.g. RSI<40 in STRONG_BULL): lower 40-55

Reply ONLY JSON:
{"regime":"${globalRegime}","strategy":"${strategy}","confidence":40-85,"stopLossPercent":3.0-8.0,"takeProfitPercent":6.0-18.0,"minConfidenceToTrade":40}`;
  }

  private async callAnthropic(
    model: string,
    symbol: string,
    globalRegime: string,
    indicators: Record<string, any>,
  ): Promise<AiTunedParams> {
    const prompt = this.buildTuningPrompt(symbol, globalRegime, indicators);
    const response = await this.anthropic.messages.create({
      model,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (response.content[0] as any).text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in ${model} response`);
    return this.mergeWithDefaults(JSON.parse(jsonMatch[0]));
  }

  private callHaiku(symbol: string, globalRegime: string, indicators: Record<string, any>) {
    return this.callAnthropic(HAIKU_MODEL, symbol, globalRegime, indicators);
  }

  private async callGpt(
    symbol: string,
    globalRegime: string,
    indicators: Record<string, any>,
  ): Promise<AiTunedParams> {
    const prompt = this.buildTuningPrompt(symbol, globalRegime, indicators);

    const response = await this.openai!.chat.completions.create({
      model: GPT_MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }, // Forces valid JSON — no repair needed
    });

    const text = response.choices[0].message.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in GPT response");

    return this.mergeWithDefaults(JSON.parse(jsonMatch[0]));
  }

  // ─── Default params (F8 Config 2 baseline) ───────────────────────────────

  getDefaultParams(regime = "MIXED"): AiTunedParams {
    const isSideways = regime === "SIDEWAYS";
    const isTrend = regime === "STRONG_BULL" || regime === "STRONG_BEAR";
    return {
      timeframeProfile: "INTRADAY",
      regime: regime as any,
      // Multi-strategy pipes: primary|fallback1|fallback2 — ensures signals when primary misses
      strategy: isTrend ? "TREND_EMA|EMA_PULLBACK|RSI_CROSS" : isSideways ? "RSI_CROSS|BB_SCALP" : "RSI_CROSS|MEAN_REVERT_RSI",
      confidence: isSideways ? 45 : isTrend ? 60 : 55,
      stopLossPercent: isSideways ? 3.0 : isTrend ? 3.5 : 3.0,
      takeProfitPercent: isSideways ? 3.0 : isTrend ? 5.0 : 4.0,
      minConfidenceToTrade: isSideways ? 42 : isTrend ? 50 : 45,
      rsiCross: {
        primaryKline: "15m",
        rsiPeriod: 14,
        rsiEmaPeriod: 9,
        enableThreshold: true,
        rsiThreshold: 50,
        enableHtfRsi: true,
        htfKline: "1h",
        enableCandleDir: true,
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
        adxMin: 20,
      },
      meanRevertRsi: {
        primaryKline: "15m",
        rsiPeriod: 14,
        emaPeriod: 200,
        priceRange: 3, // was 0.5% — far too tight, almost never triggers
        longRsi: 35, // was 30 — slightly less extreme for more signals
        shortRsi: 65, // was 70 — slightly less extreme for more signals
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
      emaPullback: {
        primaryKline: "15m",
        emaPeriod: 21,
        emaSupportPeriod: 50,
        rsiPeriod: 14,
        rsiMin: 35,
        rsiMax: 55,
        htfKline: "4h",
        htfRsiMin: 45,
      },
      bbScalp: {
        primaryKline: "15m",
        bbPeriod: 20,
        bbStdDev: 2.0,
        bbTolerance: 0.1, // tighter: price must be within 0.1% of band (was 0.3%)
        rsiPeriod: 14,
        rsiLongMax: 45, // stricter: need some oversold condition (was 52)
        rsiShortMin: 55, // stricter: need some overbought condition (was 48)
      },
    };
  }

  /**
   * When Haiku is rate-limited, compute ATR-adjusted SL instead of flat 2%.
   * Volatile coins (ALICE, DOGE) get wider stops; stable coins (BTC) get tighter.
   */
  private async getAtrAdjustedDefaults(
    coin: string,
    regime: string,
  ): Promise<AiTunedParams> {
    const defaults = this.getDefaultParams(regime);
    try {
      // Use per-coin indicators for strategy selection + ATR-adjusted SL
      const indicators = await this.preComputeIndicators(coin);
      if (Object.keys(indicators).length > 0) {
        defaults.strategy = this.selectStrategiesForCoin(regime, indicators);
      }

      const ohlc = await this.indicatorService.getOhlc(coin, "15m");
      if (ohlc.closes.length < 20) return defaults;

      const atrPct = this.indicatorService.getAtrPercent(ohlc.highs, ohlc.lows, ohlc.closes, 14);

      // SL = 1.5× ATR, clamped to [3%, min(8%, ATR×2)]
      // Volatile coins (ATR>4%) get wider SL to avoid noise stops
      const maxSl = Math.min(8, Math.max(6, atrPct * 2));
      const slPct = Math.max(3, Math.min(maxSl, atrPct * 1.5));
      defaults.stopLossPercent = parseFloat(slPct.toFixed(1));
      defaults.takeProfitPercent = parseFloat((slPct * 2).toFixed(1));
    } catch {
      // fallback to static defaults
    }
    return defaults;
  }

  private mergeWithDefaults(parsed: Partial<AiTunedParams>): AiTunedParams {
    // GPT sometimes pipes the regime field too — take only the first value
    if (parsed.regime && String(parsed.regime).includes("|")) {
      parsed.regime = String(parsed.regime).split("|")[0].trim() as any;
    }
    // GPT sometimes returns confidence as range string "55-70" — take the first number
    if (parsed.confidence != null && typeof parsed.confidence !== "number") {
      const num = parseInt(String(parsed.confidence), 10);
      parsed.confidence = isNaN(num) ? 50 : num;
    }
    const defaults = this.getDefaultParams(parsed.regime || "MIXED");
    const MIN_SL = 3.0;
    const stopLossPercent = Math.max(parsed.stopLossPercent ?? defaults.stopLossPercent, MIN_SL);
    const result = {
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
      emaPullback: { ...defaults.emaPullback, ...(parsed.emaPullback || {}) },
    };

    // Cap HTF kline to max 4h — GPT sometimes sets "1d" which is too slow for intraday signals
    const ALLOWED_HTF = ["5m", "15m", "1h", "4h"];
    if (result.rsiCross?.htfKline && !ALLOWED_HTF.includes(result.rsiCross.htfKline)) {
      result.rsiCross.htfKline = "4h";
    }
    if (result.rsiZone?.htfKline && !ALLOWED_HTF.includes(result.rsiZone.htfKline)) {
      result.rsiZone.htfKline = "4h";
    }

    return result;
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
    // ── Helpers ──
    const fmtVol = (v: number) =>
      v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` :
      v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` :
      v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;

    const fmtPrice = (p: number) =>
      p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
      p >= 1 ? `$${p.toFixed(2)}` :
      p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

    const pad = (s: string, len: number) => s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
    const padL = (s: string, len: number) => s.length >= len ? s.slice(0, len) : " ".repeat(len - s.length) + s;

    const bar = (value: number, max: number, width = 12) => {
      if (max <= 0) return "░".repeat(width);
      const filled = Math.round(Math.min(Math.abs(value) / max, 1) * width);
      return "█".repeat(filled) + "░".repeat(width - filled);
    };

    const lsBar = (longPct: number, width = 10) => {
      const filled = Math.round((longPct / 100) * width);
      return "█".repeat(filled) + "░".repeat(width - filled);
    };

    try {
      // ── Market-wide stats ──
      const totalVolume = coinData.reduce((sum, c) => sum + c.quoteVolume, 0);
      const avgChange = coinData.length > 0
        ? coinData.reduce((sum, c) => sum + c.priceChangePercent, 0) / coinData.length
        : 0;
      const gainers = coinData.filter((c) => c.priceChangePercent > 0).length;
      const losers = coinData.filter((c) => c.priceChangePercent < 0).length;

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

      // ── Header ──
      let msg =
        `📊 *PHAN TICH THI TRUONG*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `${sentimentEmoji} *${sentiment}* · Regime: *${globalRegime}*\n` +
        `📈 ${gainers} tang · 📉 ${losers} giam · TB: ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%\n` +
        `💰 ${coinData.length} coins · Vol: ${fmtVol(totalVolume)}\n`;

      // ── BTC & ETH detail ──
      const btc = coinData.find((c) => c.symbol === "BTCUSDT");
      const eth = coinData.find((c) => c.symbol === "ETHUSDT");
      const btcFa = analyticsData?.["BTCUSDT"];
      const ethFa = analyticsData?.["ETHUSDT"];

      if (btc) {
        const sign = btc.priceChangePercent >= 0 ? "+" : "";
        msg += `\n₿ *BITCOIN (BTC)*\n`;
        msg += "```\n";
        msg += ` Gia:    ${fmtPrice(btc.lastPrice)}\n`;
        msg += ` 24h:    ${sign}${btc.priceChangePercent.toFixed(2)}%\n`;
        msg += ` Vol:    ${fmtVol(btc.quoteVolume)}\n`;
        if (btcFa) {
          const oiUsd = btcFa.openInterest * btc.lastPrice;
          msg += ` Fund:   ${(btcFa.fundingRate * 100).toFixed(4)}%\n`;
          msg += ` OI:     ${fmtVol(oiUsd)}\n`;
          msg += ` L/S:    ${lsBar(btcFa.longPercent)} ${Math.round(btcFa.longPercent)}/${Math.round(btcFa.shortPercent)}\n`;
        }
        msg += "```\n";
      }

      if (eth) {
        const sign = eth.priceChangePercent >= 0 ? "+" : "";
        msg += `\nΞ *ETHEREUM (ETH)*\n`;
        msg += "```\n";
        msg += ` Gia:    ${fmtPrice(eth.lastPrice)}\n`;
        msg += ` 24h:    ${sign}${eth.priceChangePercent.toFixed(2)}%\n`;
        msg += ` Vol:    ${fmtVol(eth.quoteVolume)}\n`;
        if (ethFa) {
          const oiUsd = ethFa.openInterest * eth.lastPrice;
          msg += ` Fund:   ${(ethFa.fundingRate * 100).toFixed(4)}%\n`;
          msg += ` OI:     ${fmtVol(oiUsd)}\n`;
          msg += ` L/S:    ${lsBar(ethFa.longPercent)} ${Math.round(ethFa.longPercent)}/${Math.round(ethFa.shortPercent)}\n`;
        }
        msg += "```\n";
      }

      // ── Market Forecast ──
      msg += `\n🔮 *DU DOAN THI TRUONG*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;

      // Build forecast from data signals
      const forecasts: string[] = [];

      // BTC-based forecast
      if (btc && btcFa) {
        const btcBias = btc.priceChangePercent > 0 ? "tang" : "giam";
        const btcStrength = Math.abs(btc.priceChangePercent) > 3 ? "manh" : "nhe";
        const fundBias = btcFa.fundingRate > 0.0005 ? "qua nhieu Long (can than)" :
          btcFa.fundingRate < -0.0005 ? "Short chiem uu the" : "can bang";
        const lsBias = btcFa.longPercent > 65 ? "⚠️ Long crowded" :
          btcFa.shortPercent > 65 ? "⚠️ Short crowded" : "L/S can bang";

        forecasts.push(`₿ BTC dang ${btcBias} ${btcStrength} (${btc.priceChangePercent >= 0 ? "+" : ""}${btc.priceChangePercent.toFixed(1)}%)`);
        forecasts.push(`   Funding: ${fundBias}`);
        forecasts.push(`   ${lsBias}`);
      }

      // Market-wide forecast
      if (sentiment === "BULLISH") {
        forecasts.push(`\n📈 Thi truong dang *BULLISH*`);
        forecasts.push(`   Altcoin co the tiep tuc tang theo BTC`);
        if (btcFa && btcFa.fundingRate > 0.0005)
          forecasts.push(`   ⚠️ Funding cao — rui ro long squeeze`);
        else
          forecasts.push(`   ✅ Funding binh thuong — xu huong on dinh`);
      } else if (sentiment === "BEARISH") {
        forecasts.push(`\n📉 Thi truong dang *BEARISH*`);
        forecasts.push(`   Nen han che mo Long, uu tien Short`);
        if (btcFa && btcFa.fundingRate < -0.0005)
          forecasts.push(`   ⚠️ Funding am — rui ro short squeeze`);
        else
          forecasts.push(`   Chua co dau hieu dao chieu`);
      } else if (sentiment === "NEUTRAL") {
        forecasts.push(`\n⚪ Thi truong dang *SIDEWAY*`);
        forecasts.push(`   Bien do hep — cho breakout truoc khi vao lenh`);
        forecasts.push(`   Uu tien chien luoc Mean Revert`);
      } else {
        forecasts.push(`\n🟡 Thi truong *MIXED* — chua ro xu huong`);
        if (gainers > losers * 1.5)
          forecasts.push(`   Nhieu coin tang nhung chua dong nhat`);
        else if (losers > gainers * 1.5)
          forecasts.push(`   Ap luc ban nhieu hon — can than`);
        else
          forecasts.push(`   Cho tin hieu ro hon truoc khi vao lenh`);
      }

      // Volume insight
      const btcDominanceByVol = btc ? (btc.quoteVolume / totalVolume * 100) : 0;
      if (btcDominanceByVol > 30)
        forecasts.push(`\n💡 BTC dominance cao (${btcDominanceByVol.toFixed(0)}% vol) — altcoin phu thuoc BTC`);

      // High confidence opportunities summary
      const highConf = [...coinData].filter((c) => c.confidence >= 65).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
      if (highConf.length > 0) {
        forecasts.push(`\n🎯 *Co hoi:*`);
        for (const c of highConf) {
          const coin = c.symbol.replace("USDT", "");
          const strat = c.strategy.replace("MEAN_REVERT_RSI", "Mean Revert").replace("RSI_CROSS", "RSI Cross").replace("RSI_ZONE", "RSI Zone").replace("TREND_EMA", "Trend EMA");
          forecasts.push(`   • ${coin} — ${c.confidence}% (${strat})`);
        }
      }

      msg += forecasts.join("\n") + "\n";

      // ── Warnings ──
      const warnings: string[] = [];
      if (analyticsData) {
        for (const [sym, fa] of Object.entries(analyticsData) as any[]) {
          if (Math.abs(fa.fundingRate) > 0.001) {
            const coin = sym.replace("USDT", "");
            warnings.push(`${coin} funding ${fa.fundingRate > 0 ? "cao" : "am"} (${(fa.fundingRate * 100).toFixed(3)}%)`);
          }
        }
      }
      if (warnings.length > 0) {
        msg += `\n⚠️ *CANH BAO*\n`;
        for (const w of warnings.slice(0, 4)) {
          msg += `• ${w}\n`;
        }
      }

      msg +=
        `\n━━━━━━━━━━━━━━━━━━━━\n` +
        `_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · Binance Futures_`;

      return msg;
    } catch (err) {
      this.logger.warn(`[AiOptimizer] generateMarketOverview failed: ${err?.message}`);
      return `⚠️ Loi khi phan tich thi truong: ${err?.message}`;
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
