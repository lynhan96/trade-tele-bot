import { Injectable, Logger } from "@nestjs/common";
import { MarketDataService } from "../../market-data/market-data.service";

const { RSI, EMA, BollingerBands } = require("technicalindicators");

// ─── Helper types ────────────────────────────────────────────────────────────

export interface CrossValue {
  last: number;
  secondLast: number;
}

export interface BbValue {
  upper: number;
  middle: number;
  lower: number;
}

export interface StochResult {
  smoothedK: number[];
  smoothedD: number[];
}

export interface KdjResult {
  K: number[];
  D: number[];
  J: number[];
}

export interface CandleData {
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
}

// ─── Fibonacci types ─────────────────────────────────────────────────────────

export interface SwingPoint {
  index: number;
  price: number;
  type: "high" | "low";
}

export interface FibonacciLevels {
  swingHigh: number;
  swingLow: number;
  direction: "up" | "down"; // up = swing low→high (bullish), down = swing high→low (bearish)
  retracements: {
    level: number; // 0.236, 0.382, 0.5, 0.618, 0.786
    price: number;
  }[];
  extensions: {
    level: number; // 1.272, 1.618, 2.0, 2.618
    price: number;
  }[];
}

// ─── SMC (Smart Money Concepts) types ────────────────────────────────────────

export interface FairValueGap {
  index: number;       // candle index where FVG was detected (middle candle)
  top: number;         // upper boundary of the gap
  bottom: number;      // lower boundary of the gap
  type: "bullish" | "bearish"; // bullish = gap below (support), bearish = gap above (resistance)
  filled: boolean;     // whether price has returned to fill the gap
}

export interface OrderBlock {
  index: number;       // candle index of the order block
  high: number;
  low: number;
  type: "bullish" | "bearish"; // bullish = last bearish candle before BOS up
  mitigated: boolean;  // whether price has returned and mitigated the OB
}

export interface StructureBreak {
  index: number;
  type: "BOS" | "CHoCH"; // Break of Structure vs Change of Character
  direction: "bullish" | "bearish";
  level: number;       // the swing level that was broken
}

// ─── IndicatorService ────────────────────────────────────────────────────────

@Injectable()
export class IndicatorService {
  private readonly logger = new Logger(IndicatorService.name);

  constructor(private readonly marketDataService: MarketDataService) {}

  // ─── RSI ────────────────────────────────────────────────────────────────

  getRsi(closes: number[], period: number): CrossValue {
    const values = RSI.calculate({ period, values: closes });
    return {
      last: values[values.length - 1],
      secondLast: values[values.length - 2],
    };
  }

  getRsiEma(closes: number[], rsiPeriod: number, emaPeriod: number): CrossValue {
    const rsiValues = RSI.calculate({ period: rsiPeriod, values: closes });
    const emaValues = EMA.calculate({ period: emaPeriod, values: rsiValues });
    return {
      last: emaValues[emaValues.length - 1],
      secondLast: emaValues[emaValues.length - 2],
    };
  }

  // ─── EMA / SMA ──────────────────────────────────────────────────────────

  getEma(closes: number[], period: number): CrossValue {
    const values = EMA.calculate({ period, values: closes });
    return {
      last: values[values.length - 1],
      secondLast: values[values.length - 2],
    };
  }

  // ─── Bollinger Bands ────────────────────────────────────────────────────

  getBollingerBands(closes: number[], period = 20, stdDev = 2): BbValue {
    const values = BollingerBands.calculate({ period, values: closes, stdDev });
    const last = values[values.length - 1];
    return {
      upper: last.upper,
      middle: last.middle,
      lower: last.lower,
    };
  }

  getBbWidth(bbValue: BbValue): number {
    return Math.abs(bbValue.upper - bbValue.lower);
  }

  getBbWidthPercent(bbValue: BbValue): number {
    return (this.getBbWidth(bbValue) / bbValue.middle) * 100;
  }

  // ─── Stochastic ─────────────────────────────────────────────────────────

  getStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    periodK = 14,
    smoothingK = 3,
    smoothingD = 3,
  ): StochResult {
    const stochasticResults: number[] = [];

    for (let i = periodK - 1; i < closes.length; i++) {
      const highestHigh = Math.max(...highs.slice(i - periodK + 1, i + 1));
      const lowestLow = Math.min(...lows.slice(i - periodK + 1, i + 1));
      const range = highestHigh - lowestLow;
      const k = range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100;
      stochasticResults.push(k);
    }

    const smoothedK = this.smoothArray(stochasticResults, smoothingK);
    const smoothedD = this.smoothArray(smoothedK, smoothingD);

    return { smoothedK, smoothedD };
  }

  // ─── KDJ ────────────────────────────────────────────────────────────────

  getKdj(
    highs: number[],
    lows: number[],
    closes: number[],
    options: {
      rangeLength?: number;
      kSmoothLength?: number;
      dSmoothLength?: number;
      jSmoothLength?: number;
    } = {},
  ): KdjResult {
    const {
      rangeLength = 9,
      kSmoothLength = 3,
      dSmoothLength = 3,
      jSmoothLength = 3,
    } = options;

    const RSV = this.calculateRSV(highs, lows, closes, rangeLength);

    const K: number[] = [];
    const D: number[] = [];
    let prevK = 50;
    let prevD = 50;

    for (let i = 0; i < closes.length; i++) {
      if (RSV[i] === null) {
        K.push(null);
        D.push(null);
        continue;
      }
      const currentK = 0.666 * prevK + 0.334 * RSV[i];
      K.push(currentK);
      const currentD = 0.666 * prevD + 0.334 * currentK;
      D.push(currentD);
      prevK = currentK;
      prevD = currentD;
    }

    const K_Smoothed = this.calculateSMA(K, kSmoothLength);
    const D_Smoothed = this.calculateSMA(D, dSmoothLength);

    const J_raw = K.map((k, idx) => {
      const d = D[idx];
      if (k === null || d === null) return null;
      return 3 * k - 2 * d;
    });
    const J = this.calculateSMA(J_raw, jSmoothLength);

    return { K: K_Smoothed, D: D_Smoothed, J };
  }

  // ─── ATR ────────────────────────────────────────────────────────────────

  getAtrPercent(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (closes.length < period + 1) return 0;
    const trValues: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
      trValues.push(tr);
    }
    const recentTr = trValues.slice(-period);
    const avgTr = recentTr.reduce((s, v) => s + v, 0) / recentTr.length;
    return (avgTr / closes[closes.length - 1]) * 100;
  }

  /**
   * ADX (Average Directional Index) — measures trend strength (0–100).
   * ADX > 20 = trending market; ADX > 30 = strong trend.
   * Also returns DI+ and DI- for direction context.
   * Uses Wilder's smoothing (alpha = 1/period).
   */
  getAdx(
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14,
  ): { adx: number; diPlus: number; diMinus: number } {
    if (closes.length < 2 * period + 1) return { adx: 0, diPlus: 0, diMinus: 0 };

    const dmPlus: number[] = [];
    const dmMinus: number[] = [];
    const trArr: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
      trArr.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ));
    }

    // Wilder's smoothing: seed with sum of first `period` values, then roll
    const wilder = (arr: number[], p: number): number[] => {
      const out: number[] = [];
      let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
      out.push(s);
      for (let i = p; i < arr.length; i++) {
        s = s * (p - 1) / p + arr[i];
        out.push(s);
      }
      return out;
    };

    const sTr = wilder(trArr, period);
    const sDmPlus = wilder(dmPlus, period);
    const sDmMinus = wilder(dmMinus, period);

    const dx = sTr.map((tr, i) => {
      const diP = tr ? (100 * sDmPlus[i]) / tr : 0;
      const diM = tr ? (100 * sDmMinus[i]) / tr : 0;
      const sum = diP + diM;
      return sum ? (100 * Math.abs(diP - diM)) / sum : 0;
    });

    const adxArr = wilder(dx, period);
    const last = sTr.length - 1;
    const diPlus = sTr[last] ? (100 * sDmPlus[last]) / sTr[last] : 0;
    const diMinus = sTr[last] ? (100 * sDmMinus[last]) / sTr[last] : 0;

    return { adx: adxArr[adxArr.length - 1], diPlus, diMinus };
  }

  // ─── Fibonacci ──────────────────────────────────────────────────────────

  /**
   * Detect swing highs and swing lows from OHLC data.
   * A swing high has lower highs on both sides; a swing low has higher lows on both sides.
   * @param lookback - number of candles on each side to confirm swing (default 5)
   */
  getSwingPoints(highs: number[], lows: number[], lookback = 5): SwingPoint[] {
    const points: SwingPoint[] = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      let isSwingHigh = true;
      let isSwingLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isSwingHigh = false;
        if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isSwingLow = false;
      }
      if (isSwingHigh) points.push({ index: i, price: highs[i], type: "high" });
      if (isSwingLow) points.push({ index: i, price: lows[i], type: "low" });
    }
    return points;
  }

  /**
   * Compute Fibonacci retracement and extension levels from the most recent swing high/low pair.
   * Returns null if insufficient swing points found.
   */
  getFibonacciLevels(highs: number[], lows: number[], lookback = 5): FibonacciLevels | null {
    const swings = this.getSwingPoints(highs, lows, lookback);
    if (swings.length < 2) return null;

    // Find the most recent significant swing high and swing low
    const recentHighs = swings.filter(s => s.type === "high").slice(-3);
    const recentLows = swings.filter(s => s.type === "low").slice(-3);
    if (recentHighs.length === 0 || recentLows.length === 0) return null;

    const lastHigh = recentHighs[recentHighs.length - 1];
    const lastLow = recentLows[recentLows.length - 1];

    const swingHigh = lastHigh.price;
    const swingLow = lastLow.price;
    const range = swingHigh - swingLow;
    if (range <= 0) return null;

    // Direction: if swing low came before swing high → uptrend (bullish fib)
    const direction = lastLow.index < lastHigh.index ? "up" : "down";

    const retracementLevels = [0.236, 0.382, 0.5, 0.618, 0.786];
    const extensionLevels = [1.272, 1.618, 2.0, 2.618];

    const retracements = retracementLevels.map(level => ({
      level,
      price: direction === "up"
        ? swingHigh - range * level  // retracement from high in uptrend
        : swingLow + range * level,  // retracement from low in downtrend
    }));

    const extensions = extensionLevels.map(level => ({
      level,
      price: direction === "up"
        ? swingLow + range * level   // extension from low in uptrend
        : swingHigh - range * level, // extension from high in downtrend
    }));

    return { swingHigh, swingLow, direction, retracements, extensions };
  }

  /**
   * Find the nearest Fibonacci level to a given price.
   * Useful for setting TP at extension levels or SL at retracement levels.
   */
  getNearestFibLevel(
    fib: FibonacciLevels,
    price: number,
    type: "retracement" | "extension",
  ): { level: number; price: number; distance: number } | null {
    const levels = type === "retracement" ? fib.retracements : fib.extensions;
    if (levels.length === 0) return null;

    let nearest = levels[0];
    let minDist = Math.abs(price - nearest.price);
    for (const l of levels) {
      const dist = Math.abs(price - l.price);
      if (dist < minDist) {
        minDist = dist;
        nearest = l;
      }
    }
    return { level: nearest.level, price: nearest.price, distance: minDist };
  }

  // ─── SMC: Fair Value Gap detection ─────────────────────────────────────

  /**
   * Detect Fair Value Gaps (FVGs) in OHLC data.
   * Bullish FVG: candle[i-1].high < candle[i+1].low (gap below = demand zone)
   * Bearish FVG: candle[i-1].low > candle[i+1].high (gap above = supply zone)
   * @param maxAge - only return FVGs within the last N candles (default 50)
   */
  detectFVGs(
    highs: number[],
    lows: number[],
    closes: number[],
    maxAge = 50,
  ): FairValueGap[] {
    const fvgs: FairValueGap[] = [];
    const startIdx = Math.max(1, highs.length - maxAge);

    for (let i = startIdx; i < highs.length - 1; i++) {
      // Bullish FVG: gap between candle[i-1] high and candle[i+1] low
      if (lows[i + 1] > highs[i - 1]) {
        const currentPrice = closes[closes.length - 1];
        fvgs.push({
          index: i,
          top: lows[i + 1],
          bottom: highs[i - 1],
          type: "bullish",
          filled: currentPrice <= lows[i + 1] && currentPrice >= highs[i - 1],
        });
      }
      // Bearish FVG: gap between candle[i-1] low and candle[i+1] high
      if (highs[i + 1] < lows[i - 1]) {
        const currentPrice = closes[closes.length - 1];
        fvgs.push({
          index: i,
          top: lows[i - 1],
          bottom: highs[i + 1],
          type: "bearish",
          filled: currentPrice >= highs[i + 1] && currentPrice <= lows[i - 1],
        });
      }
    }
    return fvgs;
  }

  /**
   * Find unfilled FVGs near the current price (potential entry zones).
   * @param tolerance - % distance from FVG zone to still consider "near" (default 0.5%)
   */
  getUnfilledFVGsNearPrice(
    highs: number[],
    lows: number[],
    closes: number[],
    tolerance = 0.5,
  ): FairValueGap[] {
    const fvgs = this.detectFVGs(highs, lows, closes);
    const currentPrice = closes[closes.length - 1];
    const tolFactor = tolerance / 100;

    return fvgs.filter(fvg => {
      if (fvg.filled) return false;
      const gapMid = (fvg.top + fvg.bottom) / 2;
      const dist = Math.abs(currentPrice - gapMid) / currentPrice;
      return dist <= tolFactor;
    });
  }

  // ─── SMC: Order Block detection ────────────────────────────────────────

  /**
   * Detect Order Blocks: the last opposing candle before a strong move (BOS).
   * Bullish OB: last red candle before a strong bullish move
   * Bearish OB: last green candle before a strong bearish move
   * @param minMovePercent - minimum % move after OB to qualify (default 1.5%)
   * @param maxAge - only look back N candles (default 50)
   */
  detectOrderBlocks(
    opens: number[],
    highs: number[],
    lows: number[],
    closes: number[],
    minMovePercent = 1.5,
    maxAge = 50,
  ): OrderBlock[] {
    const obs: OrderBlock[] = [];
    const startIdx = Math.max(1, closes.length - maxAge);
    const currentPrice = closes[closes.length - 1];

    for (let i = startIdx; i < closes.length - 2; i++) {
      const isRed = closes[i] < opens[i];
      const isGreen = closes[i] > opens[i];

      if (isRed) {
        // Check for strong bullish move after this red candle
        const moveUp = ((highs[i + 1] - lows[i]) / lows[i]) * 100;
        if (moveUp >= minMovePercent) {
          obs.push({
            index: i,
            high: highs[i],
            low: lows[i],
            type: "bullish",
            mitigated: currentPrice <= highs[i] && currentPrice >= lows[i],
          });
        }
      }

      if (isGreen) {
        // Check for strong bearish move after this green candle
        const moveDown = ((highs[i] - lows[i + 1]) / highs[i]) * 100;
        if (moveDown >= minMovePercent) {
          obs.push({
            index: i,
            high: highs[i],
            low: lows[i],
            type: "bearish",
            mitigated: currentPrice >= lows[i] && currentPrice <= highs[i],
          });
        }
      }
    }
    return obs;
  }

  // ─── SMC: Break of Structure / Change of Character ─────────────────────

  /**
   * Detect BOS (Break of Structure) and CHoCH (Change of Character).
   * BOS: price breaks a swing high/low in the SAME direction as the trend
   * CHoCH: price breaks a swing high/low in the OPPOSITE direction (trend reversal signal)
   * @param lookback - swing point lookback (default 5)
   */
  detectStructureBreaks(
    highs: number[],
    lows: number[],
    closes: number[],
    lookback = 5,
  ): StructureBreak[] {
    const swings = this.getSwingPoints(highs, lows, lookback);
    if (swings.length < 3) return [];

    const breaks: StructureBreak[] = [];
    let prevTrend: "bullish" | "bearish" | null = null;

    // Determine initial trend from first two swing points
    for (let i = 1; i < swings.length; i++) {
      const prev = swings[i - 1];
      const curr = swings[i];

      if (prev.type === "low" && curr.type === "high") {
        // Upswing — check if any candle after the swing high broke above it
        const breakIdx = this.findBreakIndex(closes, curr.index, highs.length - 1, curr.price, "above");
        if (breakIdx !== -1) {
          const isSameDir = prevTrend === "bullish" || prevTrend === null;
          breaks.push({
            index: breakIdx,
            type: isSameDir ? "BOS" : "CHoCH",
            direction: "bullish",
            level: curr.price,
          });
          prevTrend = "bullish";
        }
      }

      if (prev.type === "high" && curr.type === "low") {
        // Downswing — check if any candle after the swing low broke below it
        const breakIdx = this.findBreakIndex(closes, curr.index, lows.length - 1, curr.price, "below");
        if (breakIdx !== -1) {
          const isSameDir = prevTrend === "bearish" || prevTrend === null;
          breaks.push({
            index: breakIdx,
            type: isSameDir ? "BOS" : "CHoCH",
            direction: "bearish",
            level: curr.price,
          });
          prevTrend = "bearish";
        }
      }
    }

    return breaks;
  }

  /**
   * Get the most recent structure break within the last N candles.
   */
  getRecentStructureBreak(
    highs: number[],
    lows: number[],
    closes: number[],
    lookback = 5,
    maxAge = 20,
  ): StructureBreak | null {
    const breaks = this.detectStructureBreaks(highs, lows, closes, lookback);
    if (breaks.length === 0) return null;

    const lastIdx = closes.length - 1;
    // Only return breaks that happened within maxAge candles
    const recent = breaks.filter(b => lastIdx - b.index <= maxAge);
    return recent.length > 0 ? recent[recent.length - 1] : null;
  }

  private findBreakIndex(
    closes: number[],
    fromIdx: number,
    toIdx: number,
    level: number,
    direction: "above" | "below",
  ): number {
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      if (direction === "above" && closes[i] > level) return i;
      if (direction === "below" && closes[i] < level) return i;
    }
    return -1;
  }

  // ─── Cross helpers ───────────────────────────────────────────────────────

  crossedAbove(first: CrossValue, second: CrossValue): boolean {
    return first.last > second.last && first.secondLast <= second.secondLast;
  }

  crossedBelow(first: CrossValue, second: CrossValue): boolean {
    return first.last < second.last && first.secondLast >= second.secondLast;
  }

  // ─── Candle data from Redis via MarketDataService ─────────────────────────

  async getCloses(coin: string, interval: string): Promise<number[]> {
    return this.marketDataService.getClosePrices(coin, interval);
  }

  async getOhlc(coin: string, interval: string): Promise<CandleData> {
    const [opens, highs, lows, closes] = await Promise.all([
      this.marketDataService.getOpenPrices(coin, interval),
      this.marketDataService.getHighPrices(coin, interval),
      this.marketDataService.getLowPrices(coin, interval),
      this.marketDataService.getClosePrices(coin, interval),
    ]);
    return { opens, highs, lows, closes };
  }

  /**
   * Returns the last N COMPLETED candles (oldest first, excludes the still-forming current candle).
   * Uses slice(-(n+1), -1) so the current live candle is excluded.
   */
  async getLastNClosedCandles(coin: string, interval: string, n: number): Promise<CandleData> {
    const ohlc = await this.getOhlc(coin, interval);
    return {
      opens: ohlc.opens.slice(-(n + 1), -1),
      highs: ohlc.highs.slice(-(n + 1), -1),
      lows: ohlc.lows.slice(-(n + 1), -1),
      closes: ohlc.closes.slice(-(n + 1), -1),
    };
  }

  // ─── Private math helpers ────────────────────────────────────────────────

  private smoothArray(array: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = period - 1; i < array.length; i++) {
      const slice = array.slice(i - period + 1, i + 1);
      const avg = slice.reduce((s, v) => s + v, 0) / period;
      result.push(avg);
    }
    return result;
  }

  private calculateRSV(
    highs: number[],
    lows: number[],
    closes: number[],
    rangeLength: number,
  ): (number | null)[] {
    return closes.map((close, i) => {
      if (i < rangeLength - 1) return null;
      const h = Math.max(...highs.slice(i - rangeLength + 1, i + 1));
      const l = Math.min(...lows.slice(i - rangeLength + 1, i + 1));
      return h === l ? 50 : ((close - l) / (h - l)) * 100;
    });
  }

  private calculateSMA(data: (number | null)[], period: number): number[] {
    const result: number[] = [];
    let sum = 0;
    let count = 0;

    for (let i = 0; i < data.length; i++) {
      if (data[i] !== null) {
        sum += data[i];
        count++;
      }
      if (i >= period) {
        const old = data[i - period];
        if (old !== null) {
          sum -= old;
          count--;
        }
      }
      if (i >= period - 1 && count === period) {
        result.push(sum / period);
      }
    }
    return result;
  }
}
