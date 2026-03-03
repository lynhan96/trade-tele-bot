import { Injectable, Logger } from "@nestjs/common";
import { MarketDataService } from "../../market-data/market-data.service";

const { RSI, EMA, SMA, BollingerBands } = require("technicalindicators");

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

  getSma(closes: number[], period: number): CrossValue {
    const values = SMA.calculate({ period, values: closes });
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
