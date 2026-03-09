import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../redis/redis.service";
import { IndicatorService } from "../indicators/indicator.service";
import { AiTunedParams } from "../ai-optimizer/ai-tuned-params.interface";

export interface SignalResult {
  isLong: boolean; // true = LONG, false = SHORT
  entryPrice: number; // current close price
  strategy: string;
  reason: string; // human-readable
}

// Redis TTL for 2-stage pattern state
const PATTERN_STATE_TTL = 4 * 60 * 60; // 4 hours

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    private readonly indicatorService: IndicatorService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Main entry point — evaluates the configured strategy for a coin.
   * Supports pipe-delimited strategies (e.g. "STOCH_BB_PATTERN|MEAN_REVERT_RSI")
   * and tries each in order until one produces a signal.
   */
  async evaluate(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    if (params.confidence < (params.minConfidenceToTrade || 60)) {
      this.logger.debug(
        `[RuleEngine] ${coin} skipped — AI confidence ${params.confidence} < threshold ${params.minConfidenceToTrade}`,
      );
      return null;
    }

    // Support pipe-delimited strategies from AI optimizer (e.g. "STOCH_BB_PATTERN|MEAN_REVERT_RSI")
    const strategies = params.strategy.includes("|")
      ? params.strategy.split("|").map((s) => s.trim())
      : [params.strategy];

    if (strategies.length > 1) {
      this.logger.debug(`[RuleEngine] ${coin} pipe: ${strategies.join(" → ")}`);
    }

    for (const strategy of strategies) {
      const result = await this.evalStrategy(strategy, coin, currency, params);
      if (result) {
        this.logger.debug(`[RuleEngine] ${coin} ✓ ${strategy} fired`);
        return result;
      }
    }
    return null;
  }

  private async evalStrategy(
    strategy: string,
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    switch (strategy) {
      case "RSI_CROSS":
        return this.evalRsiCross(coin, currency, params);
      case "RSI_ZONE":
        return this.evalRsiZone(coin, currency, params);
      case "TREND_EMA":
        return this.evalTrendEma(coin, currency, params);
      case "MEAN_REVERT_RSI":
        return this.evalMeanRevertRsi(coin, currency, params);
      case "STOCH_BB_PATTERN":
        return this.evalStochBbPattern(coin, currency, params);
      case "STOCH_EMA_KDJ":
        return this.evalStochEmaKdj(coin, currency, params);
      case "EMA_PULLBACK":
        return this.evalEmaPullback(coin, currency, params);
      case "BB_SCALP":
        return this.evalBbScalp(coin, currency, params);
      default:
        return null;
    }
  }

  // ─── RSI_CROSS (ported from F8 Config 2) ────────────────────────────────

  async evalRsiCross(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.rsiCross;
    if (!cfg) return null;

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < 50) return null;

    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const rsiEma = this.indicatorService.getRsiEma(closes, cfg.rsiPeriod, cfg.rsiEmaPeriod);

    // Skip coins with degenerate RSI (all-up or all-down — no cross possible)
    if (rsi.last >= 99.9 && rsiEma.last >= 99.9) return null;
    if (rsi.last <= 0.1 && rsiEma.last <= 0.1) return null;

    const isCrossAbove = this.indicatorService.crossedAbove(rsi, rsiEma);
    const isCrossBelow = this.indicatorService.crossedBelow(rsi, rsiEma);

    if (!isCrossAbove && !isCrossBelow) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS: no cross (RSI=${rsi.last.toFixed(1)} EMA=${rsiEma.last.toFixed(1)} prev RSI=${rsi.secondLast?.toFixed(1)} EMA=${rsiEma.secondLast?.toFixed(1)})`);
      return null;
    }

    const isLong = isCrossAbove;

    // RSI threshold gate — tighter thresholds to avoid peak entries
    if (cfg.enableThreshold) {
      const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
      const isBull = params.regime === "STRONG_BULL";
      const isBear = params.regime === "STRONG_BEAR";
      const isMixed = params.regime === "MIXED" || params.regime === "VOLATILE" || params.regime === "BTC_CORRELATION";
      const threshold = isRanging
        ? isLong ? 45 : 55   // ranging: LONG needs RSI < 45, SHORT needs RSI > 55
        : isBull
          ? isLong ? 55 : 40  // bull: LONG OK up to 55, SHORT needs extreme RSI < 40
          : isBear
            ? isLong ? 35 : 60  // bear: LONG needs extreme RSI < 35, SHORT OK up to 60
            : isMixed
              ? isLong ? 50 : 45  // mixed/volatile: LONG < 50, SHORT > 45 (more permissive)
              : cfg.rsiThreshold;  // fallback (50)

      if (isLong && rsi.last >= threshold) {
        this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: RSI=${rsi.last.toFixed(1)} >= threshold ${threshold}`);
        return null;
      }
      if (!isLong && rsi.last <= threshold) {
        this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: RSI=${rsi.last.toFixed(1)} <= threshold ${threshold}`);
        return null;
      }
    }

    // Overbought/oversold absolute protection — never enter at extremes
    if (isLong && rsi.last > 65) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: RSI=${rsi.last.toFixed(1)} overbought (>65)`);
      return null;
    }
    if (!isLong && rsi.last < 35) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: RSI=${rsi.last.toFixed(1)} oversold (<35)`);
      return null;
    }

    // HTF RSI confirmation + overbought/oversold check
    if (cfg.enableHtfRsi) {
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        const htfRsiEma = this.indicatorService.getRsiEma(htfCloses, cfg.rsiPeriod, cfg.rsiEmaPeriod);
        const htfIsBullish = htfRsi.last > htfRsiEma.last;
        if (isLong && !htfIsBullish) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bearish (< EMA ${htfRsiEma.last.toFixed(1)})`);
          return null;
        }
        if (!isLong && htfIsBullish) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bullish (> EMA ${htfRsiEma.last.toFixed(1)})`);
          return null;
        }
        // Block LONG if HTF RSI overbought, SHORT if oversold
        if (isLong && htfRsi.last > 70) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: HTF RSI=${htfRsi.last.toFixed(1)} overbought (>70)`);
          return null;
        }
        if (!isLong && htfRsi.last < 30) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: HTF RSI=${htfRsi.last.toFixed(1)} oversold (<30)`);
          return null;
        }
      }
    }

    // Initial candle direction gate
    if (cfg.enableCandleDir) {
      const ohlc = await this.indicatorService.getLastNClosedCandles(coin, cfg.candleKline, 1);
      if (ohlc.closes.length > 0) {
        const lastClose = ohlc.closes[ohlc.closes.length - 1];
        const lastOpen = ohlc.opens[ohlc.opens.length - 1];
        const isGreen = lastClose > lastOpen;
        if (isLong && !isGreen) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: candle is RED`);
          return null;
        }
        if (!isLong && isGreen) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: candle is GREEN`);
          return null;
        }
      }
    }

    const entryPrice = closes[closes.length - 1];
    const direction = isLong ? "LONG" : "SHORT";
    const rsiLabel = isLong ? "crosses above" : "crosses below";

    return {
      isLong,
      entryPrice,
      strategy: "RSI_CROSS",
      reason: `RSI(${cfg.rsiPeriod}) ${rsiLabel} RSI-EMA(${cfg.rsiEmaPeriod}) on ${cfg.primaryKline}. RSI=${rsi.last.toFixed(1)}`,
    };
  }

  // ─── RSI_ZONE (ported from F8 Config 3) ─────────────────────────────────

  async evalRsiZone(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.rsiZone;
    if (!cfg) return null;

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < 50) return null;

    // Use previous candle RSI (excludeLatestCandle = true in F8 Config 3)
    const closesToUse = cfg.excludeLatestCandle ? closes.slice(0, -1) : closes;
    const rsi = this.indicatorService.getRsi(closesToUse, cfg.rsiPeriod);

    // Skip degenerate RSI (freshly seeded coins with too few real candles)
    if (rsi.last >= 99.9 || rsi.last <= 0.1) return null;

    const isLongZone = rsi.last < cfg.rsiBottom;
    const isShortZone = rsi.last > cfg.rsiTop;

    if (!isLongZone && !isShortZone) return null;

    const isLong = isLongZone;

    // Initial candle direction gate
    if (cfg.enableInitialCandle) {
      const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
      if (ohlc.opens.length > 0) {
        const lastClose = ohlc.closes[ohlc.closes.length - 1];
        const lastOpen = ohlc.opens[ohlc.opens.length - 1];
        const isGreen = lastClose > lastOpen;
        if (isLong && !isGreen) return null;
        if (!isLong && isGreen) return null;
      }
    }

    // HTF RSI confirmation
    if (cfg.enableHtfRsi) {
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        const htfRsiEma = this.indicatorService.getRsiEma(
          htfCloses,
          cfg.rsiPeriod,
          cfg.rsiEmaPeriod || 9,
        );
        const htfIsBullish = htfRsi.last > htfRsiEma.last;
        if (isLong && !htfIsBullish) return null;
        if (!isLong && htfIsBullish) return null;
      }
    }

    const entryPrice = closes[closes.length - 1];
    const zone = isLong ? `oversold (${rsi.last.toFixed(1)} < ${cfg.rsiBottom})` : `overbought (${rsi.last.toFixed(1)} > ${cfg.rsiTop})`;

    return {
      isLong,
      entryPrice,
      strategy: "RSI_ZONE",
      reason: `RSI(${cfg.rsiPeriod}) ${zone} on ${cfg.primaryKline}`,
    };
  }

  // ─── TREND_EMA (ported from F1) ──────────────────────────────────────────

  async evalTrendEma(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.trendEma;
    if (!cfg) return null;

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < Math.max(cfg.slowPeriod, 50) + 5) return null;

    const fastEma = this.indicatorService.getEma(closes, cfg.fastPeriod);
    const slowEma = this.indicatorService.getEma(closes, cfg.slowPeriod);

    const isCrossAbove = this.indicatorService.crossedAbove(fastEma, slowEma);
    const isCrossBelow = this.indicatorService.crossedBelow(fastEma, slowEma);

    if (!isCrossAbove && !isCrossBelow) {
      this.logger.debug(
        `[RuleEngine] ${coin} TREND_EMA miss: no EMA${cfg.fastPeriod}/${cfg.slowPeriod} cross on ${cfg.primaryKline}`,
      );
      return null;
    }

    const isLong = isCrossAbove;

    // Trend gate: price must be near the trend EMA (EMA200 on higher TF)
    // Regime-aware: widen trendRange in strong trends (coins can be further from EMA200)
    if (cfg.enableTrendGate) {
      const trendCloses = await this.indicatorService.getCloses(coin, cfg.trendKline);
      if (trendCloses.length >= cfg.trendEmaPeriod) {
        const trendEma = this.indicatorService.getEma(trendCloses, cfg.trendEmaPeriod);
        const currentPrice = closes[closes.length - 1];
        const distPct =
          (Math.abs(currentPrice - trendEma.last) / trendEma.last) * 100;

        const isTrendRegime = params.regime === "STRONG_BULL" || params.regime === "STRONG_BEAR";
        const effectiveTrendRange = isTrendRegime ? Math.max(cfg.trendRange, 8) : cfg.trendRange;

        if (distPct > effectiveTrendRange) return null; // price too far from trend EMA
        if (isLong && currentPrice < trendEma.last) return null; // price below trend = no LONG
        if (!isLong && currentPrice > trendEma.last) return null; // price above trend = no SHORT
      }
    }

    // ADX trend strength gate — skip EMA crossovers in choppy/weak trend conditions
    // Regime-aware: lower threshold in strong trends (macro trend already confirmed)
    const baseAdxMin = cfg.adxMin ?? 20;
    const isTrendRegime = params.regime === "STRONG_BULL" || params.regime === "STRONG_BEAR";
    const adxMin = isTrendRegime ? Math.max(baseAdxMin - 5, 12) : baseAdxMin;
    if (adxMin > 0) {
      const adxOhlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
      const { adx } = this.indicatorService.getAdx(adxOhlc.highs, adxOhlc.lows, adxOhlc.closes, 14);
      if (adx < adxMin) {
        this.logger.debug(
          `[RuleEngine] ${coin} TREND_EMA blocked — ADX=${adx.toFixed(1)} < ${adxMin} (trend too weak)`,
        );
        return null;
      }
    }

    const entryPrice = closes[closes.length - 1];
    const crossType = isLong ? "crosses above" : "crosses below";

    return {
      isLong,
      entryPrice,
      strategy: "TREND_EMA",
      reason: `EMA(${cfg.fastPeriod}) ${crossType} EMA(${cfg.slowPeriod}) on ${cfg.primaryKline}`,
    };
  }

  // ─── MEAN_REVERT_RSI (ported from F2) ────────────────────────────────────
  // DATA: 22 trades, 1 win, 12 SL = -21.54% PnL. MIXED: 0/7 wins. Catches falling knives.

  async evalMeanRevertRsi(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.meanRevertRsi;
    if (!cfg) return null;

    // Block in MIXED regime — 100% loss rate (7/7 SL) from database
    if (params.regime === "MIXED") {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT blocked: MIXED regime (100% loss rate)`);
      return null;
    }
    // Block in STRONG_BEAR/VOLATILE — catches falling knives
    if (params.regime === "STRONG_BEAR" || params.regime === "VOLATILE") {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT blocked: ${params.regime} regime`);
      return null;
    }

    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const closes = ohlc.closes;
    if (closes.length < cfg.emaPeriod + 20) return null;

    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const ema200 = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const currentPrice = closes[closes.length - 1];

    // Skip degenerate RSI (freshly seeded coins with too few candles)
    if (rsi.last >= 99.9 || rsi.last <= 0.1) return null;

    // Price must be within priceRange% of the EMA
    const distPct = (Math.abs(currentPrice - ema200.last) / ema200.last) * 100;
    if (distPct > cfg.priceRange) {
      this.logger.debug(
        `[RuleEngine] ${coin} MEAN_REVERT miss: price ${distPct.toFixed(1)}% from EMA200 > ${cfg.priceRange}%`,
      );
      return null;
    }

    const isLong = rsi.last < cfg.longRsi && currentPrice > ema200.last;
    const isShort = rsi.last > cfg.shortRsi && currentPrice < ema200.last;

    if (!isLong && !isShort) {
      this.logger.debug(
        `[RuleEngine] ${coin} MEAN_REVERT miss: RSI=${rsi.last.toFixed(1)} not extreme (L<${cfg.longRsi} S>${cfg.shortRsi})`,
      );
      return null;
    }

    // RSI recovery confirmation: RSI must be turning (not still dropping/rising)
    if (isLong && rsi.last < rsi.secondLast) {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT LONG blocked: RSI still dropping ${rsi.secondLast.toFixed(1)}→${rsi.last.toFixed(1)}`);
      return null;
    }
    if (isShort && rsi.last > rsi.secondLast) {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT SHORT blocked: RSI still rising ${rsi.secondLast.toFixed(1)}→${rsi.last.toFixed(1)}`);
      return null;
    }

    // ADX filter: block in trending markets (ADX > 30 = strong trend, mean reversion fails)
    const { adx } = this.indicatorService.getAdx(ohlc.highs, ohlc.lows, closes, 14);
    if (adx > 30) {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT blocked: ADX=${adx.toFixed(1)} > 30 (trending)`);
      return null;
    }

    // Candle confirmation: require bounce candle (green for LONG, red for SHORT)
    const lastOpen = ohlc.opens[ohlc.opens.length - 1];
    if (isLong && currentPrice < lastOpen) {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT LONG blocked: red candle (no bounce)`);
      return null;
    }
    if (isShort && currentPrice > lastOpen) {
      this.logger.debug(`[RuleEngine] ${coin} MEAN_REVERT SHORT blocked: green candle (no rejection)`);
      return null;
    }

    return {
      isLong,
      entryPrice: currentPrice,
      strategy: "MEAN_REVERT_RSI",
      reason: `Price within ${cfg.priceRange}% of EMA(${cfg.emaPeriod}), RSI=${rsi.last.toFixed(1)} turning (ADX=${adx.toFixed(0)}) (${isLong ? "oversold" : "overbought"})`,
    };
  }

  // ─── STOCH_BB_PATTERN (ported from F4) — 2-stage ────────────────────────

  async evalStochBbPattern(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.stochBbPattern;
    if (!cfg) return null;

    const stateKey = `cache:ai-signal:state:${coin}:STOCH_BB`;
    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, highs, lows, closes } = ohlc;

    if (closes.length < 50) return null;

    const bb = this.indicatorService.getBollingerBands(closes, cfg.bbPeriod, cfg.bbStdDev);
    const bbWidth = this.indicatorService.getBbWidth(bb);
    const currentPrice = closes[closes.length - 1];

    const stochResult = this.indicatorService.getStochastic(
      highs,
      lows,
      closes,
      cfg.stochK,
      cfg.stochSmoothK,
      cfg.stochSmoothD,
    );

    const stochK = {
      last: stochResult.smoothedK[stochResult.smoothedK.length - 1],
      secondLast: stochResult.smoothedK[stochResult.smoothedK.length - 2],
    };
    const stochD = {
      last: stochResult.smoothedD[stochResult.smoothedD.length - 1],
      secondLast: stochResult.smoothedD[stochResult.smoothedD.length - 2],
    };

    let patternState = await this.redisService.get<{
      isLong: boolean;
      count: number;
    }>(stateKey);

    // Stage 1: detect 3-candle reversal pattern near BB band
    if (!patternState) {
      const n = closes.length;
      if (n < 4) return null;

      const c3 = { open: opens[n - 4], close: closes[n - 4] }; // oldest
      const c2 = { open: opens[n - 3], close: closes[n - 3] };
      const c1 = { open: opens[n - 2], close: closes[n - 2] }; // most recent closed

      const isGreen = (c) => c.close > c.open;

      // LONG pattern: RED-GREEN-RED at lower BB
      const isLongPattern =
        !isGreen(c3) && isGreen(c2) && !isGreen(c1);
      // SHORT pattern: GREEN-RED-GREEN at upper BB
      const isShortPattern =
        isGreen(c3) && !isGreen(c2) && isGreen(c1);

      if (!isLongPattern && !isShortPattern) return null;

      const isLong = isLongPattern;
      const bbBand = isLong ? bb.lower : bb.upper;
      const distPct = (Math.abs(currentPrice - bbBand) / bbWidth) * 100;

      if (distPct > cfg.rangeCondition1) return null; // price too far from band

      // Store Stage 1 state
      await this.redisService.set(
        stateKey,
        { isLong, count: 1 },
        PATTERN_STATE_TTL,
      );
      this.logger.debug(`[RuleEngine] ${coin} STOCH_BB Stage 1 triggered (${isLong ? "LONG" : "SHORT"})`);
      return null; // wait for Stage 2
    }

    // Stage 2: Stochastic cross confirmation
    patternState = { ...patternState, count: patternState.count + 1 };

    const bbBand = patternState.isLong ? bb.lower : bb.upper;
    const distPct = (Math.abs(currentPrice - bbBand) / bbWidth) * 100;

    // Stage 2 entry conditions
    const longStage2 =
      patternState.isLong &&
      this.indicatorService.crossedAbove(stochK, stochD) &&
      stochD.last < cfg.stochLong &&
      distPct < cfg.rangeCondition2;

    const shortStage2 =
      !patternState.isLong &&
      this.indicatorService.crossedBelow(stochK, stochD) &&
      stochD.last > cfg.stochShort &&
      distPct < cfg.rangeCondition2;

    if (!longStage2 && !shortStage2) {
      if (patternState.count >= cfg.maxCandleCount) {
        // Too many candles without confirmation — reset
        await this.redisService.delete(stateKey);
        this.logger.debug(`[RuleEngine] ${coin} STOCH_BB Stage 1 expired (${cfg.maxCandleCount} candles)`);
      } else {
        // Save updated count
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
      }
      return null;
    }

    // Stage 2 confirmed — clear state and emit signal
    await this.redisService.delete(stateKey);

    return {
      isLong: patternState.isLong,
      entryPrice: currentPrice,
      strategy: "STOCH_BB_PATTERN",
      reason: `3-candle reversal at ${patternState.isLong ? "lower" : "upper"} BB + Stoch cross (K=${stochK.last.toFixed(1)}, D=${stochD.last.toFixed(1)}) on ${cfg.primaryKline}`,
    };
  }

  // ─── STOCH_EMA_KDJ (ported from F5) — 2-stage ────────────────────────────

  async evalStochEmaKdj(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.stochEmaKdj;
    if (!cfg) return null;

    const stateKey = `cache:ai-signal:state:${coin}:STOCH_EMA`;
    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, highs, lows, closes } = ohlc;

    if (closes.length < 100) return null;

    const stochResult = this.indicatorService.getStochastic(
      highs,
      lows,
      closes,
      cfg.stochK,
      cfg.stochSmoothK,
      cfg.stochSmoothD,
    );

    const stochK = {
      last: stochResult.smoothedK[stochResult.smoothedK.length - 1],
      secondLast: stochResult.smoothedK[stochResult.smoothedK.length - 2],
    };
    const stochD = {
      last: stochResult.smoothedD[stochResult.smoothedD.length - 1],
      secondLast: stochResult.smoothedD[stochResult.smoothedD.length - 2],
    };

    let patternState = await this.redisService.get<{
      isLong: boolean;
      count: number;
    }>(stateKey);

    // Stage 1: Stochastic cross in extreme zone
    if (!patternState) {
      const isCrossAbove = this.indicatorService.crossedAbove(stochK, stochD);
      const isCrossBelow = this.indicatorService.crossedBelow(stochK, stochD);

      if (!isCrossAbove && !isCrossBelow) return null;

      const isLong = isCrossAbove;
      const stochInZone = isLong
        ? stochD.last < cfg.stochLong
        : stochD.last > cfg.stochShort;

      if (!stochInZone) return null;

      await this.redisService.set(
        stateKey,
        { isLong, count: 1 },
        PATTERN_STATE_TTL,
      );
      this.logger.debug(`[RuleEngine] ${coin} STOCH_EMA Stage 1 triggered (${isLong ? "LONG" : "SHORT"})`);
      return null;
    }

    // Stage 2: EMA body pierce + optional KDJ confirmation
    patternState = { ...patternState, count: patternState.count + 1 };

    const ema = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const n = closes.length;
    const lastClose = closes[n - 1];
    const lastOpen = opens[n - 1];

    // Candle body must straddle the EMA
    const bodyTop = Math.max(lastClose, lastOpen);
    const bodyBottom = Math.min(lastClose, lastOpen);
    const emaNearBody =
      ema.last >= bodyBottom &&
      ema.last <= bodyTop;

    // The candle must be moving in the signal direction
    const isGreen = lastClose > lastOpen;
    const directionOk = patternState.isLong ? isGreen : !isGreen;

    if (!emaNearBody || !directionOk) {
      if (patternState.count >= 5) {
        await this.redisService.delete(stateKey);
      } else {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
      }
      return null;
    }

    // Optional KDJ confirmation
    if (cfg.enableKdj) {
      const kdj = this.indicatorService.getKdj(highs, lows, closes, {
        rangeLength: cfg.kdjRangeLength,
      });
      const kLast = kdj.K[kdj.K.length - 1];
      const dLast = kdj.D[kdj.D.length - 1];
      const kPrev = kdj.K[kdj.K.length - 2];
      const dPrev = kdj.D[kdj.D.length - 2];

      const kCrossAbove = kLast > dLast && kPrev <= dPrev;
      const kCrossBelow = kLast < dLast && kPrev >= dPrev;

      if (patternState.isLong && !kCrossAbove) {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
        return null;
      }
      if (!patternState.isLong && !kCrossBelow) {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
        return null;
      }
    }

    await this.redisService.delete(stateKey);

    return {
      isLong: patternState.isLong,
      entryPrice: lastClose,
      strategy: "STOCH_EMA_KDJ",
      reason: `Stoch cross in ${patternState.isLong ? "oversold" : "overbought"} zone + EMA(${cfg.emaPeriod}) body pierce on ${cfg.primaryKline}`,
    };
  }

  // ─── EMA_PULLBACK (buy dips to EMA in trending markets) ─────────────────

  async evalEmaPullback(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.emaPullback;
    if (!cfg) return null;

    // Only works in trending regimes — buying dips in uptrend, selling rallies in downtrend
    const isBull = params.regime === "STRONG_BULL";
    const isBear = params.regime === "STRONG_BEAR";
    if (!isBull && !isBear) return null;

    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, closes } = ohlc;
    if (closes.length < cfg.emaSupportPeriod + 10) return null;

    const ema = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const emaSupport = this.indicatorService.getEma(closes, cfg.emaSupportPeriod);
    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const currentOpen = opens[opens.length - 1];

    // LONG: price pulled back to EMA21, bouncing, above EMA50
    if (isBull) {
      // Widen touch tolerance to 1% — price within 1% of EMA21 counts as a pullback
      const touchedEma = prevPrice <= ema.last * 1.01 || currentPrice <= ema.last * 1.01;
      const isGreen = currentPrice > currentOpen;
      const aboveSupport = currentPrice > emaSupport.last;
      // Widen RSI range for STRONG_BULL — RSI 35-62 (bull RSI often 50-65)
      const rsiMax = Math.max(cfg.rsiMax, 62);
      const rsiInRange = rsi.last >= cfg.rsiMin && rsi.last <= rsiMax;

      if (!touchedEma || !isGreen || !aboveSupport || !rsiInRange) {
        this.logger.debug(
          `[RuleEngine] ${coin} EMA_PULLBACK LONG miss: touch=${touchedEma} green=${isGreen} support=${aboveSupport} rsi=${rsi.last.toFixed(1)}(${cfg.rsiMin}-${rsiMax})`,
        );
        return null;
      }

      // HTF RSI confirmation — 4h must still be bullish
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        if (htfRsi.last < cfg.htfRsiMin) return null;
      }

      return {
        isLong: true,
        entryPrice: currentPrice,
        strategy: "EMA_PULLBACK",
        reason: `Pullback to EMA(${cfg.emaPeriod})=${ema.last.toFixed(2)}, bounce (green), RSI=${rsi.last.toFixed(1)} on ${cfg.primaryKline}`,
      };
    }

    // SHORT: price rallied to EMA21, rejecting, below EMA50
    if (isBear) {
      // Widen touch tolerance to 1%
      const touchedEma = prevPrice >= ema.last * 0.99 || currentPrice >= ema.last * 0.99;
      const isRed = currentPrice < currentOpen;
      const belowSupport = currentPrice < emaSupport.last;
      const rsiMin = Math.min(100 - Math.max(cfg.rsiMax, 62), 100 - cfg.rsiMin);
      const rsiInRange = rsi.last >= rsiMin && rsi.last <= (100 - cfg.rsiMin);

      if (!touchedEma || !isRed || !belowSupport || !rsiInRange) {
        this.logger.debug(
          `[RuleEngine] ${coin} EMA_PULLBACK SHORT miss: touch=${touchedEma} red=${isRed} support=${belowSupport} rsi=${rsi.last.toFixed(1)}`,
        );
        return null;
      }

      // HTF RSI confirmation — 4h must still be bearish
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        if (htfRsi.last > (100 - cfg.htfRsiMin)) return null;
      }

      return {
        isLong: false,
        entryPrice: currentPrice,
        strategy: "EMA_PULLBACK",
        reason: `Rally to EMA(${cfg.emaPeriod})=${ema.last.toFixed(2)}, rejection (red), RSI=${rsi.last.toFixed(1)} on ${cfg.primaryKline}`,
      };
    }

    return null;
  }

  // ─── BB_SCALP (mean reversion at Bollinger Band extremes, SIDEWAYS regime) ─
  // DATA: SHORT 16 trades, 0 SL = +30.87%. LONG 22 trades, 0 wins, 9 SL = -13.32%.
  // LONGs bounce off lower band in downtrends → false bounces. Needs HTF confirmation.

  private async evalBbScalp(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.bbScalp ?? {
      primaryKline: "15m",
      bbPeriod: 20,
      bbStdDev: 2.0,
      bbTolerance: 0.1,
      rsiPeriod: 14,
      rsiLongMax: 45,
      rsiShortMin: 55,
    };

    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    if (ohlc.closes.length < cfg.bbPeriod + cfg.rsiPeriod + 5) return null;

    const closes = ohlc.closes;
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const prev2Close = closes[closes.length - 3];

    // Bollinger Bands
    const { upper, lower } = this.indicatorService.getBollingerBands(
      closes,
      cfg.bbPeriod,
      cfg.bbStdDev,
    );

    // RSI
    const rsiSeries = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const rsi = rsiSeries.last;
    const rsiPrev = rsiSeries.secondLast ?? rsi;

    const toleranceFactor = cfg.bbTolerance / 100;

    // ── LONG: confirmed bounce off lower band ──────────────────────────────
    const prevAtLowerBand = prevClose <= lower * (1 + toleranceFactor);
    const bouncingUp = lastClose > prevClose && lastClose > prev2Close;
    const rsiTurningUp = rsi > rsiPrev;
    if (prevAtLowerBand && bouncingUp && rsi < cfg.rsiLongMax && rsiTurningUp) {
      // Extra LONG filter: require RSI to be deeply oversold (< 35 instead of < 45)
      // DATA: BB_SCALP LONGs at RSI 40-45 mostly fail, only deep oversold has chance
      if (rsi >= 35) {
        this.logger.debug(`[RuleEngine] ${coin} BB_SCALP LONG blocked: RSI=${rsi.toFixed(1)} not deeply oversold (<35)`);
        return null;
      }

      // HTF confirmation: 1h RSI must not be in downtrend (> 40)
      const htfCloses = await this.indicatorService.getCloses(coin, "1h");
      if (htfCloses.length >= 20) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, 14);
        if (htfRsi.last < 40) {
          this.logger.debug(`[RuleEngine] ${coin} BB_SCALP LONG blocked: 1h RSI=${htfRsi.last.toFixed(1)} bearish (<40)`);
          return null;
        }
      }

      // Volume confirmation: current candle must show buying pressure
      const lastOpen = ohlc.opens[ohlc.opens.length - 1];
      const bodySize = Math.abs(lastClose - lastOpen);
      const candleRange = ohlc.highs[ohlc.highs.length - 1] - ohlc.lows[ohlc.lows.length - 1];
      // Body must be > 50% of candle range (strong green, not doji)
      if (candleRange > 0 && bodySize / candleRange < 0.5) {
        this.logger.debug(`[RuleEngine] ${coin} BB_SCALP LONG blocked: weak bounce candle (body=${(bodySize/candleRange*100).toFixed(0)}%)`);
        return null;
      }

      return {
        isLong: true,
        entryPrice: lastClose,
        strategy: "BB_SCALP",
        reason: `BB bounce LONG: prev=${prevClose.toFixed(4)} at lower BB=${lower.toFixed(4)}, RSI ${rsiPrev.toFixed(0)}→${rsi.toFixed(0)} on ${cfg.primaryKline}`,
      };
    }

    // ── SHORT: confirmed rejection at upper band ───────────────────────────
    const prevAtUpperBand = prevClose >= upper * (1 - toleranceFactor);
    const rejectingDown = lastClose < prevClose && lastClose < prev2Close;
    const rsiTurningDown = rsi < rsiPrev;
    if (prevAtUpperBand && rejectingDown && rsi > cfg.rsiShortMin && rsiTurningDown) {
      return {
        isLong: false,
        entryPrice: lastClose,
        strategy: "BB_SCALP",
        reason: `BB rejection SHORT: prev=${prevClose.toFixed(4)} at upper BB=${upper.toFixed(4)}, RSI ${rsiPrev.toFixed(0)}→${rsi.toFixed(0)} on ${cfg.primaryKline}`,
      };
    }

    return null;
  }
}
