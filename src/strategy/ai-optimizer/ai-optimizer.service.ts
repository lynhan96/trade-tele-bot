import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import { RedisService } from "../../redis/redis.service";
import { IndicatorService } from "../indicators/indicator.service";
import { MarketDataService } from "../../market-data/market-data.service";
import {
  AiRegimeHistory,
  AiRegimeHistoryDocument,
} from "../../schemas/ai-regime-history.schema";
import {
  AiMarketConfig,
  AiMarketConfigDocument,
} from "../../schemas/ai-market-config.schema";
import {
  AiSignalValidation,
  AiSignalValidationDocument,
} from "../../schemas/ai-signal-validation.schema";
import { AiTunedParams } from "./ai-tuned-params.interface";
import { TradingConfigService } from "../../ai-signal/trading-config";

const AI_PARAMS_TTL = 6 * 60 * 60; // 6h cache — params don't change fast, save API cost
const AI_PARAMS_JITTER = 60 * 60; // ±30 min random offset to stagger expiry
const AI_REGIME_TTL = 30 * 60; // 30min cache — balanced between cost and responsiveness
const AI_MARKET_FILTERS_KEY = "cache:ai:market-filters"; // regime-based coin filter settings
const AI_MARKET_FILTERS_TTL = 8 * 60 * 60; // 8h — re-evaluated on regime change
const RECENT_PERF_KEY = "cache:ai:recent-perf"; // recent SL/TP stats for context
const HAIKU_VALIDATION_CACHE_TTL = 15 * 60; // 15min cache per symbol+direction
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 8000; // 8s timeout — don't block signal pipeline
const HAIKU_CIRCUIT_BREAKER_KEY = "cache:ai:haiku-circuit-open";
const HAIKU_CIRCUIT_BREAKER_TTL = 5 * 60; // 5min cooldown after consecutive failures
const HAIKU_MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class AiOptimizerService {
  private readonly logger = new Logger(AiOptimizerService.name);
  private readonly anthropic: Anthropic | null = null;
  private haikuConsecutiveFailures = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly indicatorService: IndicatorService,
    private readonly marketDataService: MarketDataService,
    @InjectModel(AiRegimeHistory.name)
    private readonly regimeHistoryModel: Model<AiRegimeHistoryDocument>,
    @InjectModel(AiMarketConfig.name)
    private readonly marketConfigModel: Model<AiMarketConfigDocument>,
    @InjectModel(AiSignalValidation.name)
    private readonly validationModel: Model<AiSignalValidationDocument>,
    private readonly tradingConfig: TradingConfigService,
  ) {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      this.logger.log("[AiOptimizer] Claude Haiku signal validation enabled");
    } else {
      this.logger.warn("[AiOptimizer] No ANTHROPIC_API_KEY — AI validation disabled (rule-based only)");
    }
    this.logger.log("[AiOptimizer] SMC/Fibonacci + ATR param tuning");
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
    const btcPriceKey = "cache:ai:regime:btc-price";
    const cached = await this.redisService.get<string>(cacheKey);

    // Fast invalidation: if BTC moved >2% since last regime assessment, force recompute
    if (cached) {
      try {
        const lastBtcPrice = await this.redisService.get<number>(btcPriceKey);
        if (lastBtcPrice) {
          const currentBtcPrice = await this.marketDataService.getPrice("BTCUSDT");
          if (currentBtcPrice) {
            const pctMove = Math.abs((currentBtcPrice - lastBtcPrice) / lastBtcPrice) * 100;
            if (pctMove >= 2) {
              this.logger.log(
                `[AiOptimizer] BTC moved ${pctMove.toFixed(1)}% (${lastBtcPrice.toFixed(0)} → ${currentBtcPrice.toFixed(0)}) — invalidating regime cache`,
              );
              await this.redisService.delete(cacheKey);
              // fall through to recompute
            } else {
              this.logger.debug(`[AiOptimizer] assessGlobalRegime: cached=${cached}`);
              return cached;
            }
          } else {
            this.logger.debug(`[AiOptimizer] assessGlobalRegime: cached=${cached}`);
            return cached;
          }
        } else {
          this.logger.debug(`[AiOptimizer] assessGlobalRegime: cached=${cached}`);
          return cached;
        }
      } catch {
        this.logger.debug(`[AiOptimizer] assessGlobalRegime: cached=${cached}`);
        return cached;
      }
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

      // CRASH DETECTION (multi-level):
      // Level 1: RSI < 35 on 15m + below EMA9 → strong dump signal
      // Level 2: RSI < 45 on 15m + RSI < 45 on 4h + below EMA9 → both timeframes bearish
      // Level 3: RSI < 40 on 15m + price dropping away from EMA9 → moderate dump
      if (rsi < 35 && priceVsEma9 < -0.5) {
        regime = "STRONG_BEAR";
        confidence = Math.min(90, 50 + (50 - rsi));
      }
      else if (rsi < 45 && rsi4h < 45 && priceVsEma9 < -0.3) {
        // Both 15m AND 4h RSI bearish = confirmed downtrend, not just noise
        regime = "STRONG_BEAR";
        confidence = Math.min(85, 40 + (50 - rsi) + (50 - rsi4h) / 2);
      }
      else if (rsi < 40 && priceVsEma9 < -1.0) {
        // Price significantly below EMA9 — dump in progress
        regime = "STRONG_BEAR";
        confidence = Math.min(80, 45 + (50 - rsi));
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

      // ── SMC BOS/CHoCH refinement: structure breaks can confirm or override regime ──
      const bosEnabled = this.configService.get("ENABLE_BOS_CHOCH", "true") === "true";
      if (bosEnabled) {
        try {
          const btcOhlc4h = await this.indicatorService.getOhlc("btc", "4h");
          if (btcOhlc4h.closes.length >= 30) {
            const recentBreak = this.indicatorService.getRecentStructureBreak(
              btcOhlc4h.highs, btcOhlc4h.lows, btcOhlc4h.closes, 5, 10,
            );

            if (recentBreak) {
              // CHoCH (Change of Character) on 4h = potential regime reversal signal
              if (recentBreak.type === "CHoCH") {
                if (recentBreak.direction === "bullish" && (regime === "STRONG_BEAR" || regime === "MIXED")) {
                  this.logger.log(`[AiOptimizer] BOS/CHoCH: bullish CHoCH on BTC 4h — upgrading regime from ${regime}`);
                  if (regime === "STRONG_BEAR") {
                    regime = "MIXED"; // Don't jump straight to BULL, soften to MIXED
                    confidence = Math.min(confidence, 60);
                  }
                }
                if (recentBreak.direction === "bearish" && (regime === "STRONG_BULL" || regime === "MIXED")) {
                  this.logger.log(`[AiOptimizer] BOS/CHoCH: bearish CHoCH on BTC 4h — downgrading regime from ${regime}`);
                  if (regime === "STRONG_BULL") {
                    regime = "MIXED";
                    confidence = Math.min(confidence, 60);
                  }
                }
              }

              // BOS (Break of Structure) confirms existing trend — boost confidence
              if (recentBreak.type === "BOS") {
                if (recentBreak.direction === "bullish" && regime === "STRONG_BULL") {
                  confidence = Math.min(95, confidence + 5);
                  this.logger.debug(`[AiOptimizer] BOS/CHoCH: bullish BOS confirms STRONG_BULL, confidence +5`);
                }
                if (recentBreak.direction === "bearish" && regime === "STRONG_BEAR") {
                  confidence = Math.min(95, confidence + 5);
                  this.logger.debug(`[AiOptimizer] BOS/CHoCH: bearish BOS confirms STRONG_BEAR, confidence +5`);
                }
              }
            }
          }
        } catch (err) {
          this.logger.debug(`[AiOptimizer] BOS/CHoCH detection failed: ${err?.message}`);
        }
      }

      await this.redisService.set(cacheKey, regime, AI_REGIME_TTL);
      // Store BTC price at time of regime assessment for fast invalidation
      if (indicators.price) {
        await this.redisService.set(btcPriceKey, parseFloat(indicators.price), AI_REGIME_TTL * 2);
      }
      // Store BTC context for VOLATILE direction filter in processCoin
      await this.redisService.set("cache:ai:regime:btc-context", {
        rsi, rsi4h, priceVsEma9, priceVsEma200, atr15m, bbWidth,
      }, AI_REGIME_TTL);

      // If regime changed → flush all coin param caches so GPT re-evaluates with new strategy
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

      // Tune market filter settings when regime changes or cached filters expired
      if (prevRegime !== regime || !(await this.redisService.get(AI_MARKET_FILTERS_KEY))) {
        this.tuneMarketFilters(regime).catch((e) =>
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

  // ─── Regime-based coin filter settings (fixed defaults, no GPT) ─────────

  async tuneMarketFilters(regime: string): Promise<void> {
    const configuredMax = parseInt(this.configService.get("AI_MAX_SHORTLIST_SIZE", "120"));

    // Fixed regime-based filter defaults — deterministic, free, no API calls
    const filterMap: Record<string, { minVolumeUsd: number; minPriceChangePct: number; maxShortlistSize: number }> = {
      VOLATILE:     { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.5,  maxShortlistSize: Math.min(200, configuredMax) },
      STRONG_BULL:  { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.1,  maxShortlistSize: Math.min(200, configuredMax) },
      STRONG_BEAR:  { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.1,  maxShortlistSize: Math.min(200, configuredMax) },
      RANGE_BOUND:  { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.1,  maxShortlistSize: Math.min(200, configuredMax) },
      SIDEWAYS:     { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.1,  maxShortlistSize: Math.min(200, configuredMax) },
      MIXED:        { minVolumeUsd: 5_000_000,  minPriceChangePct: 0.1,  maxShortlistSize: Math.min(200, configuredMax) },
    };

    const filters = filterMap[regime] || filterMap.MIXED;

    // Store in MongoDB for tracking
    await this.marketConfigModel.create({
      assessedAt: new Date(),
      regime,
      ...filters,
      reasoning: `Fixed regime-based defaults for ${regime}`,
      model: "algo",
      tokensIn: 0,
      tokensOut: 0,
    });

    // Cache in Redis (8h)
    await this.redisService.set(AI_MARKET_FILTERS_KEY, filters, AI_MARKET_FILTERS_TTL);

    this.logger.log(
      `[AiOptimizer] Market filters for ${regime}: ` +
        `vol=$${(filters.minVolumeUsd / 1e6).toFixed(0)}M, ` +
        `change=${filters.minPriceChangePct}%, coins=${filters.maxShortlistSize}`,
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

    // All coins: SMC/Fibonacci + ATR-based SL/TP + algorithmic strategy
    let defaults = await this.getAtrAdjustedDefaults(coin, globalRegime);
    if (defaults.stopLossPercent < 2.0) defaults.stopLossPercent = 2.0;
    if (forceProfile) defaults = this.applyForcedProfile(defaults, forceProfile);
    const jitter = Math.floor(Math.random() * AI_PARAMS_JITTER);
    await this.redisService.set(cacheKey, defaults, AI_PARAMS_TTL + jitter);
    this.logger.debug(
      `[AiOptimizer] ${symbol}${forceProfile ? `:${forceProfile}` : ""} ` +
      `SL=${defaults.stopLossPercent}% TP=${defaults.takeProfitPercent}% ` +
      `strategy=${defaults.strategy} (SMC/Fib+ATR)`,
    );
    return defaults;
  }

  /**
   * Override timeframe settings for a forced profile (INTRADAY or SWING).
   * Reuses base params and only adjusts kline settings.
   */
  private applyForcedProfile(params: AiTunedParams, profile: string): AiTunedParams {
    const result = { ...params };
    result.timeframeProfile = profile as any;

    if (profile === "SWING") {
      // SWING: 4h primary, 1d HTF, wider SL
      result.stopLossPercent = Math.max(3, result.stopLossPercent);
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

    // ── BB_SCALP is the best performer (SHORT: +30.87%, 0 SL) — prioritize in range ──
    if (bbWidth < 3 && (isSideways || isRange)) {
      strategies.push("BB_SCALP");
    }

    // ── RSI_CROSS is a solid all-rounder — always include ──
    strategies.push("RSI_CROSS");

    // ── EMA_PULLBACK for trending + close to EMA21 ──
    if (isTrend && Math.abs(priceVsEma21_4h) < 2) {
      strategies.push("EMA_PULLBACK");
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

    // ── SMC_FVG: Fair Value Gap + Order Block — supplemental strategy only ──
    // SMC_FVG is added AFTER other strategies as a bonus confluence signal,
    // but never as the sole strategy. It requires traditional TA to also confirm.
    const smcEnabled = this.configService.get("ENABLE_SMC_FVG", "true") === "true";
    if (smcEnabled && (isRange || isSideways || globalRegime === "MIXED")) {
      // Only add SMC_FVG if at least one other strategy (besides RSI_CROSS) is present,
      // OR if RSI_CROSS + specific conditions exist (RSI not neutral 40-60)
      const hasNonRsiCross = strategies.some(s => s !== "RSI_CROSS");
      const rsiNotNeutral = rsi < 40 || rsi > 60;
      if (hasNonRsiCross || rsiNotNeutral) {
        strategies.push("SMC_FVG");
      }
    }

    // Cap at 3 strategies
    return strategies.slice(0, 3).join("|");
  }


  // ─── AI signal validation gate ────────────────────────────────────────────

  /**
   * Ask AI whether a signal should be taken. Returns true (take) or false (skip).
   * Uses GPT-4o-mini with minimal tokens. Falls back to true if AI unavailable.
   */
  /**
   * Rule-based signal validation — replaces GPT validation (was generic, zero value).
   * Uses actual market data: price position in range, candle momentum, RSI checks.
   * Results saved to ai_signal_validations for tracking.
   */
  async validateSignal(signal: {
    symbol: string;
    direction: string;
    strategy: string;
    regime: string;
    confidence: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    indicators: Record<string, any>;
    fundingRate?: number;
    longShortRatio?: number;
    btcDominance?: number;
    btcDomDelta30m?: number;
  }): Promise<{ approved: boolean; reason?: string }> {
    const { symbol, direction, strategy, regime, confidence, stopLossPercent, takeProfitPercent } = signal;
    const isLong = direction === "LONG";
    const rejectedBy: string[] = [];
    let pricePosition: number | undefined;
    let candleMomentum: number | undefined;
    let rsiValue: number | undefined;
    let htfRsiValue: number | undefined;

    try {
      // 1. Price Position — don't short bottoms, don't long tops (1h, 20 candles)
      const ohlc1h = await this.indicatorService.getOhlc(symbol.replace("USDT", ""), "1h");
      if (ohlc1h.highs.length >= 20) {
        const highs = ohlc1h.highs.slice(-20);
        const lows = ohlc1h.lows.slice(-20);
        const high = Math.max(...highs);
        const low = Math.min(...lows);
        const range = high - low;
        if (range > 0) {
          const price = ohlc1h.closes[ohlc1h.closes.length - 1];
          pricePosition = ((price - low) / range) * 100;
          if (!isLong && pricePosition < 25) rejectedBy.push("price_position_bottom");
          if (isLong && pricePosition > 75) rejectedBy.push("price_position_top");
        }
      }

      // 2. Candle Momentum — 2/3 recent 15m candles must align
      const ohlc15m = await this.indicatorService.getOhlc(symbol.replace("USDT", ""), "15m");
      if (ohlc15m.closes.length >= 4) {
        let aligned = 0;
        for (let i = 1; i <= 3; i++) {
          const idx = ohlc15m.closes.length - 1 - i;
          const c = ohlc15m.closes[idx];
          const o = ohlc15m.opens[idx];
          if (isLong && c > o) aligned++;
          if (!isLong && c < o) aligned++;
        }
        candleMomentum = aligned;
        if (aligned < 2) rejectedBy.push("candle_momentum");
      }

      // 3. RSI check — don't LONG if overbought, don't SHORT if oversold
      if (ohlc15m.closes.length >= 20) {
        const rsi = this.indicatorService.getRsi(ohlc15m.closes, 14);
        rsiValue = rsi.last;
        if (isLong && rsi.last > 65) rejectedBy.push("rsi_overbought");
        if (!isLong && rsi.last < 35) rejectedBy.push("rsi_oversold");
      }

      // 4. HTF RSI — 1h trend must not be exhausted
      const closes1h = ohlc1h.closes;
      if (closes1h.length >= 20) {
        const htfRsi = this.indicatorService.getRsi(closes1h, 14);
        htfRsiValue = htfRsi.last;
        if (isLong && htfRsi.last > 70) rejectedBy.push("htf_rsi_overbought");
        if (!isLong && htfRsi.last < 30) rejectedBy.push("htf_rsi_oversold");
      }

      // 5. Risk/reward check
      if (stopLossPercent > takeProfitPercent * 2) rejectedBy.push("bad_risk_reward");

    } catch (err) {
      this.logger.warn(`[AiOptimizer] Rule validation error: ${err?.message}`);
      // fail-open: approve on error (don't block good signals)
    }

    // Rule-based rejection — fast, free
    if (rejectedBy.length > 0) {
      // Include context in rejection reason too
      const ctxParts: string[] = [];
      if (pricePosition != null) ctxParts.push(`pos=${pricePosition.toFixed(0)}%`);
      if (rsiValue != null) ctxParts.push(`RSI=${rsiValue.toFixed(0)}`);
      if (htfRsiValue != null) ctxParts.push(`RSI1h=${htfRsiValue.toFixed(0)}`);
      if (signal.fundingRate != null) ctxParts.push(`funding=${(signal.fundingRate * 100).toFixed(3)}%`);
      const reason = `Rejected by: ${rejectedBy.join(", ")}${ctxParts.length ? ` (${ctxParts.join(", ")})` : ""}`;
      this.validationModel.create({
        symbol, direction, strategy, regime, confidence,
        stopLossPercent, takeProfitPercent,
        approved: false, reason,
        model: "rule-engine",
        pricePosition, candleMomentum, rsiValue, htfRsiValue, rejectedBy,
      }).catch((e) => this.logger.warn(`[AiOptimizer] Failed to save validation: ${e?.message}`));
      return { approved: false, reason };
    }

    // Rule checks passed — approve (AI validation removed)
    // Build detailed reason with all available context
    const parts: string[] = [
      `pos=${pricePosition?.toFixed(0)}%`,
      `momentum=${candleMomentum}/3`,
      `RSI=${rsiValue?.toFixed(0)}`,
    ];
    if (htfRsiValue != null) parts.push(`RSI1h=${htfRsiValue.toFixed(0)}`);
    if (signal.fundingRate != null) parts.push(`funding=${(signal.fundingRate * 100).toFixed(3)}%`);
    if (signal.longShortRatio != null) parts.push(`L/S=${signal.longShortRatio.toFixed(2)}`);
    if (signal.btcDominance != null) parts.push(`BTC.D=${signal.btcDominance.toFixed(1)}%`);
    if (signal.btcDomDelta30m != null) parts.push(`Δ30m=${signal.btcDomDelta30m > 0 ? "+" : ""}${signal.btcDomDelta30m.toFixed(2)}%`);
    const reason = `Rules passed: ${parts.join(", ")}`;

    this.validationModel.create({
      symbol, direction, strategy, regime, confidence,
      stopLossPercent, takeProfitPercent,
      approved: true, reason,
      model: "rule-engine",
      pricePosition, candleMomentum, rsiValue, htfRsiValue,
      rejectedBy: [],
    }).catch((e) => this.logger.warn(`[AiOptimizer] Failed to save validation: ${e?.message}`));

    return { approved: true, reason };
  }

  /**
   * Claude Haiku contextual validation — reviews signal quality with full market context.
   * Cached 15min per symbol+direction. Fail-open on error (approve if API fails).
   */
  private async validateWithHaiku(ctx: {
    symbol: string;
    direction: string;
    strategy: string;
    regime: string;
    confidence: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    pricePosition?: number;
    candleMomentum?: number;
    rsiValue?: number;
    htfRsiValue?: number;
  }): Promise<{ approved: boolean; reason: string; model: string }> {
    // No API key → approve (rule-based only)
    if (!this.anthropic) {
      return { approved: true, reason: "No AI key — rule-based only", model: "rule-engine" };
    }

    // Circuit breaker: skip API calls if too many consecutive failures
    const circuitOpen = await this.redisService.get<boolean>(HAIKU_CIRCUIT_BREAKER_KEY);
    if (circuitOpen) {
      return { approved: true, reason: "AI circuit breaker open — rule-based only", model: "circuit-breaker" };
    }

    // Check cache
    const cacheKey = `cache:ai:haiku-val:${ctx.symbol}:${ctx.direction}`;
    const cached = await this.redisService.get<{ approved: boolean; reason: string }>(cacheKey);
    if (cached) {
      return { ...cached, model: "haiku-cached" };
    }

    try {
      // Get recent performance for context
      const recentPerf = (await this.redisService.get<any[]>(RECENT_PERF_KEY)) || [];
      const last10 = recentPerf.slice(-10);
      const wins = last10.filter((p) => p.pnlPercent > 0).length;
      const losses = last10.length - wins;
      const avgPnl = last10.length > 0 ? last10.reduce((s, p) => s + (p.pnlPercent || 0), 0) / last10.length : 0;

      // Get BTC context
      const btcCtx = await this.redisService.get<{ rsi: number; priceVsEma9: number }>("cache:ai:regime:btc-context");

      const prompt = `You are a crypto futures trading signal validator. Analyze this signal and decide PASS or REJECT.

Signal: ${ctx.symbol} ${ctx.direction} via ${ctx.strategy}
Regime: ${ctx.regime} | Confidence: ${ctx.confidence}
SL: ${ctx.stopLossPercent.toFixed(1)}% | TP: ${ctx.takeProfitPercent.toFixed(1)}% | R:R = 1:${(ctx.takeProfitPercent / ctx.stopLossPercent).toFixed(1)}
Price position in 20h range: ${ctx.pricePosition?.toFixed(0) ?? "N/A"}%
Candle momentum (15m): ${ctx.candleMomentum ?? "N/A"}/3 aligned
RSI(15m): ${ctx.rsiValue?.toFixed(0) ?? "N/A"} | RSI(1h): ${ctx.htfRsiValue?.toFixed(0) ?? "N/A"}
BTC: RSI=${btcCtx?.rsi?.toFixed(0) ?? "N/A"}, vs EMA9=${btcCtx?.priceVsEma9?.toFixed(2) ?? "N/A"}%
Recent 10 trades: ${wins}W/${losses}L, avg PnL=${avgPnl.toFixed(2)}%

Rules:
- REJECT if direction conflicts with regime (e.g. LONG in STRONG_BEAR without strong reversal signals)
- REJECT if RSI diverges from direction (LONG with RSI>60, SHORT with RSI<40)
- REJECT if price position is unfavorable (LONG above 65%, SHORT below 35%)
- REJECT if recent performance is very poor (>7 losses in last 10) and signal is marginal
- REJECT if R:R ratio < 0.8
- PASS if setup has good confluence: aligned momentum, favorable RSI, good price position, reasonable R:R

Respond ONLY with JSON: {"decision":"PASS"|"REJECT","reason":"brief 10-word max reason"}`;

      // API call with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);

      let response: Anthropic.Message;
      try {
        response = await this.anthropic.messages.create(
          { model: HAIKU_MODEL, max_tokens: 80, messages: [{ role: "user", content: prompt }] },
          { signal: controller.signal as any },
        );
      } finally {
        clearTimeout(timeout);
      }

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      const json = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim());
      const approved = json.decision === "PASS";
      const reason = json.reason || (approved ? "AI approved" : "AI rejected");

      // Success — reset failure counter, cache result
      this.haikuConsecutiveFailures = 0;
      await this.redisService.set(cacheKey, { approved, reason }, HAIKU_VALIDATION_CACHE_TTL);

      this.logger.log(
        `[AiOptimizer] Haiku ${approved ? "PASS" : "REJECT"}: ${ctx.symbol} ${ctx.direction} — ${reason}`,
      );

      return { approved, reason, model: HAIKU_MODEL };
    } catch (err) {
      this.haikuConsecutiveFailures++;
      const isRateLimit = err?.status === 429;
      const errType = isRateLimit ? "rate-limited" : err?.name === "AbortError" ? "timeout" : "error";

      // Circuit breaker: open after consecutive failures
      if (this.haikuConsecutiveFailures >= HAIKU_MAX_CONSECUTIVE_FAILURES) {
        await this.redisService.set(HAIKU_CIRCUIT_BREAKER_KEY, true, HAIKU_CIRCUIT_BREAKER_TTL);
        this.logger.warn(
          `[AiOptimizer] Haiku circuit breaker OPEN — ${this.haikuConsecutiveFailures} consecutive failures (${errType}). Cooling down ${HAIKU_CIRCUIT_BREAKER_TTL / 60}min`,
        );
      }

      this.logger.warn(`[AiOptimizer] Haiku ${errType}: ${err?.message} — APPROVED (fail-open)`);
      return { approved: true, reason: `AI ${errType} — fail-open`, model: `haiku-${errType}` };
    }
  }

  // ─── Default params (F8 Config 2 baseline) ───────────────────────────────

  getDefaultParams(regime = "MIXED"): AiTunedParams {
    const isSideways = regime === "SIDEWAYS";
    const isTrend = regime === "STRONG_BULL" || regime === "STRONG_BEAR";
    return {
      timeframeProfile: "INTRADAY",
      regime: regime as any,
      // Multi-strategy pipes: primary|fallback1|fallback2
      strategy: isTrend ? "EMA_PULLBACK|TREND_EMA|RSI_CROSS" : isSideways ? "BB_SCALP|RSI_CROSS" : "RSI_CROSS|BB_SCALP",
      confidence: 65, // base default — overridden by dynamic calculation in getAtrAdjustedDefaults
      stopLossPercent: 2.0,
      takeProfitPercent: 3.0,   // matches tpMax from config
      minConfidenceToTrade: 50, // floor enforced in ai-signal.service.ts (CONFIDENCE_FLOOR=63)
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
      smcFvg: {
        primaryKline: "15m",
        htfKline: "1h",
        fvgTolerance: 0.5,
        obMinMove: 1.5,
        rsiPeriod: 14,
        rsiLongMax: 60,
        rsiShortMin: 40,
        requireBos: true,
        maxFvgAge: 30,
      },
    };
  }

  /**
   * Compute SL/TP using SMC (Order Blocks) + Fibonacci + ATR.
   * Priority: OB for SL, Fib extension for TP, ATR as fallback for both.
   */
  private async getAtrAdjustedDefaults(
    coin: string,
    regime: string,
  ): Promise<AiTunedParams> {
    const defaults = this.getDefaultParams(regime);
    try {
      // Use per-coin indicators for strategy selection
      const indicators = await this.preComputeIndicators(coin);
      if (Object.keys(indicators).length > 0) {
        defaults.strategy = this.selectStrategiesForCoin(regime, indicators);
      }

      const ohlc = await this.indicatorService.getOhlc(coin, "15m");
      if (ohlc.closes.length < 20) return defaults;

      const currentPrice = ohlc.closes[ohlc.closes.length - 1];
      const atrPct = this.indicatorService.getAtrPercent(ohlc.highs, ohlc.lows, ohlc.closes, 14);

      // ── ATR baseline SL/TP ── uses TradingConfig for caps
      const cfg = this.tradingConfig.get();
      const maxSl = Math.min(cfg.slMax + 1, Math.max(cfg.slMax, atrPct * 2));
      let slPct = Math.max(cfg.slMin, Math.min(maxSl, atrPct * 1.5));
      let tpPct = Math.max(cfg.tpMin, Math.min(cfg.tpMax, atrPct * 2.0));

      let slSource = "ATR";
      let tpSource = "ATR";

      // ── SMC Order Block SL: place SL behind nearest OB ──
      if (ohlc.closes.length >= 30) {
        try {
          const obs = this.indicatorService.detectOrderBlocks(
            ohlc.opens, ohlc.highs, ohlc.lows, ohlc.closes, 1.5, 50,
          );

          if (obs.length > 0) {
            // For SL, find the nearest non-mitigated OB
            // Bullish OB (demand zone) → SL for LONG below it
            // Bearish OB (supply zone) → SL for SHORT above it
            // Since we don't know direction yet, compute both and use the tighter one
            const bullishObs = obs.filter(ob => ob.type === "bullish" && !ob.mitigated && ob.low < currentPrice);
            const bearishObs = obs.filter(ob => ob.type === "bearish" && !ob.mitigated && ob.high > currentPrice);

            // Find nearest bullish OB below price (for LONG SL)
            const nearestBullishOb = bullishObs.length > 0
              ? bullishObs.reduce((best, ob) => ob.low > best.low ? ob : best)
              : null;

            // Find nearest bearish OB above price (for SHORT SL)
            const nearestBearishOb = bearishObs.length > 0
              ? bearishObs.reduce((best, ob) => ob.high < best.high ? ob : best)
              : null;

            // Use the OB that gives a SL within our [2%, 4%] range
            let obSlPct: number | null = null;
            if (nearestBullishOb) {
              const dist = ((currentPrice - nearestBullishOb.low) / currentPrice) * 100;
              if (dist >= cfg.slMin && dist <= cfg.slMax + 1) obSlPct = dist;
            }
            if (nearestBearishOb && !obSlPct) {
              const dist = ((nearestBearishOb.high - currentPrice) / currentPrice) * 100;
              if (dist >= cfg.slMin && dist <= cfg.slMax + 1) obSlPct = dist;
            }

            if (obSlPct) {
              slPct = parseFloat(obSlPct.toFixed(1));
              slSource = "OB";
              this.logger.debug(
                `[AiOptimizer] ${coin} OB SL: ${slPct}% (Order Block at ${nearestBullishOb?.low?.toFixed(2) || nearestBearishOb?.high?.toFixed(2)})`,
              );
            }
          }
        } catch (err) {
          this.logger.debug(`[AiOptimizer] ${coin} OB detection failed: ${err?.message}`);
        }
      }

      // ── Fibonacci SL + TP: market-structure aligned with R:R guarantee ──
      // Strategy:
      //   1. SL: Fib 0.618 retracement if OB not found (market support/resistance)
      //   2. TP: find the SMALLEST Fib extension where fibTp >= SL×2 (R:R ≥ 2:1)
      //      Try in order: 1.272 → 1.618 → 2.0 → 2.618 — pick first that satisfies R:R
      //   3. Fallback: if no Fib TP qualifies, enforce TP = SL×2 (no Fib structure)
      const fibEnabled = this.configService.get("ENABLE_FIBONACCI", "true") === "true";
      if (fibEnabled && ohlc.closes.length >= 30) {
        const fib = this.indicatorService.getFibonacciLevels(ohlc.highs, ohlc.lows, 5);
        if (fib) {
          const range = fib.swingHigh - fib.swingLow;
          const rangePct = (range / currentPrice) * 100;

          if (rangePct > 2) {
            // Step 1: SL from Fib 0.618 retracement (if OB didn't find one)
            if (slSource === "ATR") {
              const ret618 = fib.retracements.find(r => r.level === 0.618);
              if (ret618) {
                const fibSlPct = Math.abs((currentPrice - ret618.price) / currentPrice) * 100;
                if (fibSlPct >= cfg.slMin && fibSlPct <= cfg.slMax + 1) {
                  slPct = parseFloat(fibSlPct.toFixed(1));
                  slSource = "Fib0.618";
                  this.logger.debug(
                    `[AiOptimizer] ${coin} Fib SL: ${slPct}% (0.618 ret at ${ret618.price.toFixed(2)})`,
                  );
                }
              }
            }

            // Step 2: TP — pick smallest extension that achieves R:R ≥ tpRrMultiplier vs final slPct
            const targetTpPct = slPct * cfg.tpRrMultiplier;
            const fibTpExtLevels = [1.272, 1.618, 2.0, 2.618]; // try smallest first
            for (const level of fibTpExtLevels) {
              const ext = fib.extensions.find(e => e.level === level);
              if (ext) {
                const fibTpPct = Math.abs((ext.price - currentPrice) / currentPrice) * 100;
                if (fibTpPct >= targetTpPct && fibTpPct <= cfg.tpMax + 1) {
                  tpPct = parseFloat(fibTpPct.toFixed(1));
                  tpSource = `Fib${level}`;
                  (defaults as any).fibTpUsed = true;
                  (defaults as any).fibSwingRange = rangePct.toFixed(1);
                  this.logger.debug(
                    `[AiOptimizer] ${coin} Fib TP: ${tpPct}% (${level} ext at ${ext.price.toFixed(2)}, R:R=${(tpPct/slPct).toFixed(1)}, swing ${fib.direction})`,
                  );
                  break;
                }
              }
            }
          }
        }
      }

      // ── Enforce minimum R:R fallback — fires only when Fib couldn't satisfy R:R ──
      const minTp = parseFloat((slPct * cfg.tpRrMultiplier).toFixed(1));
      if (tpPct < minTp) {
        this.logger.debug(`[AiOptimizer] ${coin} R:R fallback: TP ${tpPct}% → ${minTp}% (SL=${slPct}%, R:R=${cfg.tpRrMultiplier})`);
        tpPct = minTp;
        tpSource = tpSource === "ATR" ? "ATR(R:R)" : `${tpSource}(R:R)`;
      }
      tpPct = Math.min(cfg.tpMax, tpPct); // hard cap from config

      defaults.stopLossPercent = parseFloat(slPct.toFixed(1));
      defaults.takeProfitPercent = parseFloat(tpPct.toFixed(1));
      (defaults as any).slSource = slSource;
      (defaults as any).tpSource = tpSource;

      // ── Dynamic confidence: compute from indicator alignment ──
      // Base: 60 (above absolute min, below floor in some regimes)
      let dynConf = 60;

      if (Object.keys(indicators).length > 0) {
        const rsi = parseFloat(indicators.rsi14_15m) || 50;
        const rsi4h = indicators.rsi14_4h !== "N/A" ? parseFloat(indicators.rsi14_4h) : 50;
        const bbWidth = parseFloat(indicators.bbWidthPct) || 3;

        // +5 if RSI not in danger zone (35-65 is comfortable)
        if (rsi >= 35 && rsi <= 65) dynConf += 5;
        // +5 if 4h RSI aligns with 15m RSI (same side of 50)
        if ((rsi > 50 && rsi4h > 50) || (rsi < 50 && rsi4h < 50)) dynConf += 5;
        // +3 if ATR is moderate (0.5-2% — not too dead, not too wild)
        if (atrPct >= 0.5 && atrPct <= 2.0) dynConf += 3;
        // +3 if SMC/Fib levels found (structural SL/TP = higher quality)
        if (slSource !== "ATR") dynConf += 3;
        if (tpSource !== "ATR") dynConf += 2;
        // +2 if BB width is reasonable (not too tight/wide)
        if (bbWidth >= 1.5 && bbWidth <= 5.0) dynConf += 2;
      }

      // Cap at 80 — rule engine still applies regime-based caps on top
      defaults.confidence = Math.min(80, dynConf);

      this.logger.debug(
        `[AiOptimizer] ${coin} SL=${slPct.toFixed(1)}%(${slSource}) TP=${tpPct.toFixed(1)}%(${tpSource}) conf=${defaults.confidence} ATR=${atrPct.toFixed(2)}%`,
      );
    } catch {
      // fallback to static defaults
    }
    return defaults;
  }


  // ─── Recent performance tracking (for GPT context) ─────────────────────

  /**
   * Called by AiSignalService when a trade closes.
   * Stores recent results in Redis so GPT can factor in recent performance.
   */
  async recordTradeResult(result: {
    symbol: string;
    direction: string;
    strategy: string;
    pnlPercent: number;
    closeReason: string;
  }): Promise<void> {
    const perf = (await this.redisService.get<any[]>(RECENT_PERF_KEY)) || [];
    perf.push({
      ...result,
      time: new Date().toISOString().slice(11, 16),
    });
    // Keep last 30 results, 12h TTL — enough data for momentum filter to detect direction bias
    const trimmed = perf.slice(-30);
    await this.redisService.set(RECENT_PERF_KEY, trimmed, 12 * 60 * 60);
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
          const strat = c.strategy.replace("RSI_CROSS", "RSI Cross").replace("RSI_ZONE", "RSI Zone").replace("TREND_EMA", "Trend EMA");
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
