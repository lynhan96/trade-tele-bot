/**
 * AI-tuned parameters for a given coin/interval combination.
 * Returned by AiOptimizerService (Haiku call or fallback defaults).
 */
export interface AiTunedParams {
  /** Market regime detected by AI */
  regime:
    | "STRONG_BULL"
    | "STRONG_BEAR"
    | "RANGE_BOUND"
    | "SIDEWAYS"
    | "VOLATILE"
    | "BTC_CORRELATION"
    | "MIXED";

  /** Timeframe profile: INTRADAY = 15m primary / 1h HTF; SWING = 4h primary / 1d HTF */
  timeframeProfile: "INTRADAY" | "SWING";

  /** Selected strategy — pipe-delimited for multi-strategy: "TREND_EMA|RSI_CROSS|EMA_PULLBACK" */
  strategy: string;

  /** AI confidence in this regime assessment (0-100) */
  confidence: number;

  /** Stop loss percent for generated signals */
  stopLossPercent: number;

  /**
   * Take profit percent for generated signals.
   * Haiku sets this based on regime/volatility (typical range: 1.5×–3× stopLossPercent).
   * Falls back to stopLossPercent × 2 if omitted.
   */
  takeProfitPercent: number;

  /** Minimum AI confidence to actually trade (skip signal if below this) */
  minConfidenceToTrade: number;

  /** RSI_CROSS specific params */
  rsiCross?: {
    primaryKline: string; // e.g. "15m"
    rsiPeriod: number; // default 14
    rsiEmaPeriod: number; // default 9
    enableThreshold: boolean;
    rsiThreshold: number; // default 50
    enableHtfRsi: boolean;
    htfKline: string; // e.g. "1h"
    enableCandleDir: boolean;
    candleKline: string;
  };

  /** RSI_ZONE specific params */
  rsiZone?: {
    primaryKline: string;
    rsiPeriod: number;
    rsiEmaPeriod: number;
    rsiTop: number; // SHORT when RSI > rsiTop (default 70)
    rsiBottom: number; // LONG when RSI < rsiBottom (default 30)
    enableHtfRsi: boolean;
    htfKline: string;
    enableInitialCandle: boolean;
    excludeLatestCandle: boolean;
  };

  /** TREND_EMA specific params */
  trendEma?: {
    primaryKline: string;
    fastPeriod: number; // default 9
    slowPeriod: number; // default 21
    enableTrendGate: boolean;
    trendKline: string; // e.g. "4h"
    trendEmaPeriod: number; // default 200
    trendRange: number; // price must be within X% of trend EMA
    adxMin?: number; // minimum ADX to allow entry (default 20); 0 = disabled
  };

  /** MEAN_REVERT_RSI specific params */
  meanRevertRsi?: {
    primaryKline: string;
    rsiPeriod: number;
    emaPeriod: number; // EMA to measure "mean" (default 200)
    priceRange: number; // price must be within X% of EMA
    longRsi: number; // LONG when RSI < longRsi
    shortRsi: number; // SHORT when RSI > shortRsi
  };

  /** STOCH_BB_PATTERN specific params */
  stochBbPattern?: {
    primaryKline: string;
    bbPeriod: number; // default 20
    bbStdDev: number; // default 2
    stochK: number; // Stoch period K
    stochSmoothK: number;
    stochSmoothD: number;
    stochLong: number; // Stoch zone for LONG (default < 30)
    stochShort: number; // Stoch zone for SHORT (default > 70)
    rangeCondition1: number; // Stage 1: price within X% of BB band
    rangeCondition2: number; // Stage 2: price within X% of BB band (tighter)
    maxCandleCount: number; // Max candles to wait for Stage 2
  };

  /** STOCH_EMA_KDJ specific params */
  stochEmaKdj?: {
    primaryKline: string;
    stochK: number;
    stochSmoothK: number;
    stochSmoothD: number;
    stochLong: number;
    stochShort: number;
    emaPeriod: number; // EMA to pierce
    emaRange: number; // Candle body must straddle EMA within X%
    enableKdj: boolean;
    kdjRangeLength: number;
  };

  /** EMA_PULLBACK specific params — buy dips to EMA in trending markets */
  emaPullback?: {
    primaryKline: string;     // "15m" or "4h"
    emaPeriod: number;        // EMA to pull back to (default 21)
    emaSupportPeriod: number; // larger EMA for trend confirmation (default 50)
    rsiPeriod: number;        // default 14
    rsiMin: number;           // min RSI — below this is a crash, not a dip (default 35)
    rsiMax: number;           // max RSI — must have pulled back from high (default 55)
    htfKline: string;         // "4h" — higher timeframe confirmation
    htfRsiMin: number;        // HTF RSI must be above this for LONG (default 45)
  };

  /** BB_SCALP specific params — mean reversion at Bollinger Band extremes (SIDEWAYS regime) */
  bbScalp?: {
    primaryKline: string; // default "15m"
    bbPeriod: number;     // default 20
    bbStdDev: number;     // default 2.0
    bbTolerance: number;  // % distance from band still triggers (default 0.3)
    rsiPeriod: number;    // default 14
    rsiLongMax: number;   // LONG only when RSI < this (default 52)
    rsiShortMin: number;  // SHORT only when RSI > this (default 48)
  };

  /** SMC_FVG specific params — Smart Money Concepts: Fair Value Gap + Order Block entry */
  smcFvg?: {
    primaryKline: string;  // default "15m"
    htfKline: string;      // default "1h" — HTF for structure break confirmation
    fvgTolerance: number;  // % distance from FVG zone to trigger (default 0.5)
    obMinMove: number;     // min % move after OB to qualify (default 1.5)
    rsiPeriod: number;     // default 14
    rsiLongMax: number;    // LONG only when RSI < this (default 60)
    rsiShortMin: number;   // SHORT only when RSI > this (default 40)
    requireBos: boolean;   // require BOS/CHoCH confirmation on HTF (default true)
    maxFvgAge: number;     // max candles age for FVG (default 30)
  };
}
