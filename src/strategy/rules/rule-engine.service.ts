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
   * Returns SignalResult if a signal is generated, or null if no signal.
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

    switch (params.strategy) {
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

    const isCrossAbove = this.indicatorService.crossedAbove(rsi, rsiEma);
    const isCrossBelow = this.indicatorService.crossedBelow(rsi, rsiEma);

    if (!isCrossAbove && !isCrossBelow) return null;

    const isLong = isCrossAbove;

    // RSI threshold gate
    if (cfg.enableThreshold) {
      if (isLong && rsi.last >= cfg.rsiThreshold) return null; // LONG needs RSI below threshold
      if (!isLong && rsi.last <= cfg.rsiThreshold) return null; // SHORT needs RSI above threshold
    }

    // HTF RSI confirmation
    if (cfg.enableHtfRsi) {
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        const htfRsiEma = this.indicatorService.getRsiEma(htfCloses, cfg.rsiPeriod, cfg.rsiEmaPeriod);
        const htfIsBullish = htfRsi.last > htfRsiEma.last;
        if (isLong && !htfIsBullish) return null;
        if (!isLong && htfIsBullish) return null;
      }
    }

    // Initial candle direction gate
    if (cfg.enableCandleDir) {
      const ohlc = await this.indicatorService.getLastNClosedCandles(coin, cfg.candleKline, 1);
      if (ohlc.closes.length > 0) {
        const lastClose = ohlc.closes[ohlc.closes.length - 1];
        const lastOpen = ohlc.opens[ohlc.opens.length - 1];
        const isGreen = lastClose > lastOpen;
        if (isLong && !isGreen) return null;
        if (!isLong && isGreen) return null;
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

    if (!isCrossAbove && !isCrossBelow) return null;

    const isLong = isCrossAbove;

    // Trend gate: price must be near the trend EMA (EMA200 on higher TF)
    if (cfg.enableTrendGate) {
      const trendCloses = await this.indicatorService.getCloses(coin, cfg.trendKline);
      if (trendCloses.length >= cfg.trendEmaPeriod) {
        const trendEma = this.indicatorService.getEma(trendCloses, cfg.trendEmaPeriod);
        const currentPrice = closes[closes.length - 1];
        const distPct =
          (Math.abs(currentPrice - trendEma.last) / trendEma.last) * 100;

        if (distPct > cfg.trendRange) return null; // price too far from trend EMA
        if (isLong && currentPrice < trendEma.last) return null; // price below trend = no LONG
        if (!isLong && currentPrice > trendEma.last) return null; // price above trend = no SHORT
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

  async evalMeanRevertRsi(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.meanRevertRsi;
    if (!cfg) return null;

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < cfg.emaPeriod + 20) return null;

    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const ema200 = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const currentPrice = closes[closes.length - 1];

    // Price must be within priceRange% of the EMA
    const distPct = (Math.abs(currentPrice - ema200.last) / ema200.last) * 100;
    if (distPct > cfg.priceRange) return null;

    const isLong = rsi.last < cfg.longRsi && currentPrice > ema200.last;
    const isShort = rsi.last > cfg.shortRsi && currentPrice < ema200.last;

    if (!isLong && !isShort) return null;

    return {
      isLong,
      entryPrice: currentPrice,
      strategy: "MEAN_REVERT_RSI",
      reason: `Price within ${cfg.priceRange}% of EMA(${cfg.emaPeriod}), RSI=${rsi.last.toFixed(1)} (${isLong ? "oversold" : "overbought"})`,
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
}
