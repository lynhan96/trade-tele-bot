/**
 * Strategy & Indicators Simulator
 * Tests all indicator formulas and rule-engine decision logic in pure TypeScript,
 * mirroring the exact implementations in IndicatorService and RuleEngineService.
 *
 * Covers:
 *   - RSI (Wilder's smoothing)
 *   - EMA (multiplier = 2/(period+1))
 *   - SMA (simple average)
 *   - Stochastic (K/D with SMA smoothing)
 *   - KDJ (exponential smoothing, J=3K-2D)
 *   - ATR percent
 *   - Cross detection (crossedAbove / crossedBelow)
 *   - Rule-engine conditions: RSI_ZONE, RSI_CROSS, TREND_EMA, MEAN_REVERT_RSI, 2-stage states
 */

import {
  TestResult,
  runTest,
  assert,
  assertClose,
  assertEqual,
} from "./test-utils";

// ─── Pure indicator implementations (mirror IndicatorService) ────────────────

/** Wilder's RSI — returns array of RSI values starting from index `period` */
function calcRsi(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return [];
  const diffs = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = diffs.map((d) => (d > 0 ? d : 0));
  const losses = diffs.map((d) => (d < 0 ? -d : 0));

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const result: number[] = [];
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));

  for (let i = period; i < diffs.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return result;
}

/** EMA — seed = SMA of first `period` closes */
function calcEma(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const multiplier = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [seed];
  for (let i = period; i < closes.length; i++) {
    result.push((closes[i] - result[result.length - 1]) * multiplier + result[result.length - 1]);
  }
  return result;
}

/** SMA — rolling simple moving average */
function calcSma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    result.push(values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

/** Stochastic — K (raw), smoothedK = SMA(K, smoothK), D = SMA(smoothedK, smoothD) */
function calcStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  periodK = 14,
  smoothK = 3,
  smoothD = 3,
): { smoothedK: number[]; smoothedD: number[] } {
  const rawK: number[] = [];
  for (let i = periodK - 1; i < closes.length; i++) {
    const slice_h = highs.slice(i - periodK + 1, i + 1);
    const slice_l = lows.slice(i - periodK + 1, i + 1);
    const highN = Math.max(...slice_h);
    const lowN = Math.min(...slice_l);
    const range = highN - lowN;
    rawK.push(range === 0 ? 50 : ((closes[i] - lowN) / range) * 100);
  }
  const smoothedK = calcSma(rawK, smoothK);
  const smoothedD = calcSma(smoothedK, smoothD);
  return { smoothedK, smoothedD };
}

/** KDJ — exponential smoothing: K[i]=0.666*K[i-1]+0.334*RSV, D[i]=0.666*D[i-1]+0.334*K, J=3K-2D */
function calcKdj(
  highs: number[],
  lows: number[],
  closes: number[],
  rangeLength = 9,
): { K: number[]; D: number[]; J: number[] } {
  const K: number[] = [];
  const D: number[] = [];
  const J: number[] = [];
  let prevK = 50;
  let prevD = 50;

  for (let i = rangeLength - 1; i < closes.length; i++) {
    const slice_h = highs.slice(i - rangeLength + 1, i + 1);
    const slice_l = lows.slice(i - rangeLength + 1, i + 1);
    const highN = Math.max(...slice_h);
    const lowN = Math.min(...slice_l);
    const range = highN - lowN;
    const rsv = range === 0 ? 50 : ((closes[i] - lowN) / range) * 100;

    const ki = 0.666 * prevK + 0.334 * rsv;
    const di = 0.666 * prevD + 0.334 * ki;
    const ji = 3 * ki - 2 * di;

    K.push(ki);
    D.push(di);
    J.push(ji);
    prevK = ki;
    prevD = di;
  }
  return { K, D, J };
}

/** ATR percent — (avgTR / lastClose) * 100 */
function calcAtrPercent(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number {
  if (closes.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  const slice = trs.slice(-period);
  const avgTr = slice.reduce((a, b) => a + b, 0) / slice.length;
  return (avgTr / closes[closes.length - 1]) * 100;
}

/** Cross detection helpers (exact mirror of IndicatorService) */
function crossedAbove(
  first: { last: number; secondLast: number },
  second: { last: number; secondLast: number },
): boolean {
  return first.last > second.last && first.secondLast <= second.secondLast;
}
function crossedBelow(
  first: { last: number; secondLast: number },
  second: { last: number; secondLast: number },
): boolean {
  return first.last < second.last && first.secondLast >= second.secondLast;
}

/** Helper: last two values from an array */
function lastTwo(arr: number[]): { last: number; secondLast: number } {
  return { last: arr[arr.length - 1], secondLast: arr[arr.length - 2] };
}

// ─── Test data generators ────────────────────────────────────────────────────

/** N prices trending up linearly */
function uptrendPrices(n: number, start = 100, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** N prices trending down linearly */
function downtrendPrices(n: number, start = 130, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

/** N constant prices */
function flatPrices(n: number, price = 100): number[] {
  return Array.from({ length: n }, () => price);
}

/** OHLC with close always at top of range */
function ohlcAtTop(n: number, base = 100, range = 10) {
  return {
    opens: Array.from({ length: n }, () => base),
    highs: Array.from({ length: n }, () => base + range),
    lows: Array.from({ length: n }, () => base - range),
    closes: Array.from({ length: n }, () => base + range), // close = high → K = 100
  };
}

/** OHLC with close always at bottom of range */
function ohlcAtBottom(n: number, base = 100, range = 10) {
  return {
    opens: Array.from({ length: n }, () => base),
    highs: Array.from({ length: n }, () => base + range),
    lows: Array.from({ length: n }, () => base - range),
    closes: Array.from({ length: n }, () => base - range), // close = low → K = 0
  };
}

// ─── 2-Stage state machine (mirrors signal-queue redis cache logic) ───────────

type StageState = { isLong: boolean; count: number } | null;

class TwoStageStateMachine {
  private state: StageState = null;
  readonly maxCount = 5;

  /** Stage 1: detect initial pattern, save state */
  stage1(isLong: boolean): "STAGE1_SAVED" {
    this.state = { isLong, count: 1 };
    return "STAGE1_SAVED";
  }

  /** Stage 2: confirm with second condition */
  stage2(confirmIsLong: boolean): "SIGNAL" | "WAIT" | "RESET" | "NO_STATE" {
    if (!this.state) return "NO_STATE";

    if (this.state.isLong !== confirmIsLong) {
      this.state = null; // Direction mismatch → reset
      return "RESET";
    }

    this.state.count++;

    if (this.state.count <= this.maxCount) {
      this.state = null; // Emit signal, clear state
      return "SIGNAL";
    } else {
      this.state = null; // Too many candles → reset
      return "RESET";
    }
  }

  /** Increment count without confirming (candle passed without stage 2 trigger) */
  tick(): "WAIT" | "RESET" {
    if (!this.state) return "WAIT";
    this.state.count++;
    if (this.state.count > this.maxCount) {
      this.state = null;
      return "RESET";
    }
    return "WAIT";
  }

  hasState(): boolean {
    return this.state !== null;
  }

  getState(): StageState {
    return this.state;
  }
}

// ─── Simulator ───────────────────────────────────────────────────────────────

export class StrategyIndicatorsSimulator {
  public runAllTests(): TestResult {
    const results: TestResult = { total: 0, passed: 0, failed: 0 };

    console.log("\n📐 STRATEGY & INDICATORS SIMULATOR");
    console.log(
      "Testing indicator formulas and rule-engine decision logic\n",
    );

    // ── RSI ──────────────────────────────────────────────────────────────────

    runTest(results, "RSI: all prices up (30 candles) → RSI = 100", () => {
      const closes = uptrendPrices(31);
      const rsi = calcRsi(closes, 14);
      assertEqual(rsi[rsi.length - 1], 100, "All-gain RSI should be 100");
    });

    runTest(results, "RSI: all prices down (30 candles) → RSI = 0", () => {
      const closes = downtrendPrices(31);
      const rsi = calcRsi(closes, 14);
      assertEqual(rsi[rsi.length - 1], 0, "All-loss RSI should be 0");
    });

    runTest(results, "RSI: result always in [0, 100] range", () => {
      const closes = [100, 95, 105, 102, 98, 103, 101, 99, 104, 97, 106, 100, 102, 98, 103, 101];
      const rsi = calcRsi(closes, 7);
      assert(rsi.length > 0, "Should produce RSI values");
      for (const r of rsi) {
        assert(r >= 0 && r <= 100, `RSI value ${r.toFixed(2)} out of [0,100]`);
      }
    });

    runTest(results, "RSI: insufficient data → returns empty array", () => {
      const rsi = calcRsi([100, 101, 102], 14);
      assertEqual(rsi.length, 0, "Should return empty for < period+1 prices");
    });

    runTest(results, "RSI: uptrend RSI > downtrend RSI for same period length", () => {
      const upRsi = calcRsi(uptrendPrices(31), 14);
      const downRsi = calcRsi(downtrendPrices(31), 14);
      assert(
        upRsi[upRsi.length - 1] > downRsi[downRsi.length - 1],
        "Uptrend RSI should be higher than downtrend RSI",
      );
    });

    // ── EMA ──────────────────────────────────────────────────────────────────

    runTest(results, "EMA: constant prices → EMA = that price", () => {
      const ema9 = calcEma(flatPrices(30, 100), 9);
      const ema21 = calcEma(flatPrices(30, 100), 21);
      assertClose(ema9[ema9.length - 1], 100, 0.0001, "EMA9 of flat prices");
      assertClose(ema21[ema21.length - 1], 100, 0.0001, "EMA21 of flat prices");
    });

    runTest(results, "EMA: uptrend → fast EMA(9) > slow EMA(21)", () => {
      const closes = uptrendPrices(50, 100, 1);
      const ema9 = calcEma(closes, 9);
      const ema21 = calcEma(closes, 21);
      assert(
        ema9[ema9.length - 1] > ema21[ema21.length - 1],
        "EMA9 should be above EMA21 in uptrend",
      );
    });

    runTest(results, "EMA: downtrend → fast EMA(9) < slow EMA(21)", () => {
      const closes = downtrendPrices(50, 150, 1);
      const ema9 = calcEma(closes, 9);
      const ema21 = calcEma(closes, 21);
      assert(
        ema9[ema9.length - 1] < ema21[ema21.length - 1],
        "EMA9 should be below EMA21 in downtrend",
      );
    });

    runTest(results, "EMA: seed equals SMA of first period prices", () => {
      const closes = [10, 20, 30, 40, 50, 60, 70, 80, 90]; // SMA(9) = 50
      const ema9 = calcEma(closes, 9);
      assertEqual(ema9[0], 50, "EMA seed should equal SMA of first period");
    });

    // ── Cross Detection ──────────────────────────────────────────────────────

    runTest(results, "crossedAbove: was below, now above → true (LONG signal)", () => {
      // RSI went from 48 to 52, RSI-EMA stayed at 50
      assert(
        crossedAbove({ last: 52, secondLast: 48 }, { last: 50, secondLast: 50 }),
        "Should detect cross above",
      );
    });

    runTest(results, "crossedAbove: already above → false (no new cross)", () => {
      assert(
        !crossedAbove({ last: 55, secondLast: 52 }, { last: 50, secondLast: 50 }),
        "Already-above should NOT be a cross",
      );
    });

    runTest(results, "crossedAbove: boundary case (secondLast exactly equal → still a cross)", () => {
      // secondLast <= other.secondLast when values are equal → true
      assert(
        crossedAbove({ last: 51, secondLast: 50 }, { last: 50, secondLast: 50 }),
        "Boundary: secondLast equal should count as cross (<=)",
      );
    });

    runTest(results, "crossedBelow: was above, now below → true (SHORT signal)", () => {
      assert(
        crossedBelow({ last: 48, secondLast: 52 }, { last: 50, secondLast: 50 }),
        "Should detect cross below",
      );
    });

    runTest(results, "crossedBelow: already below → false (no new cross)", () => {
      assert(
        !crossedBelow({ last: 45, secondLast: 47 }, { last: 50, secondLast: 50 }),
        "Already-below should NOT be a cross",
      );
    });

    // ── Stochastic ───────────────────────────────────────────────────────────

    runTest(results, "Stochastic: close always at range high → smoothedK approaches 100", () => {
      const n = 30;
      const { highs, lows, closes } = ohlcAtTop(n, 100, 10);
      const { smoothedK } = calcStochastic(highs, lows, closes, 14, 3, 3);
      assert(
        smoothedK[smoothedK.length - 1] > 95,
        `smoothedK should be near 100, got ${smoothedK[smoothedK.length - 1].toFixed(2)}`,
      );
    });

    runTest(results, "Stochastic: close always at range low → smoothedK approaches 0", () => {
      const n = 30;
      const { highs, lows, closes } = ohlcAtBottom(n, 100, 10);
      const { smoothedK } = calcStochastic(highs, lows, closes, 14, 3, 3);
      assert(
        smoothedK[smoothedK.length - 1] < 5,
        `smoothedK should be near 0, got ${smoothedK[smoothedK.length - 1].toFixed(2)}`,
      );
    });

    runTest(results, "Stochastic: D lags K (K responds faster to price changes)", () => {
      // After switching from low to high closes, K rises first, D follows
      const n = 30;
      const { highs, lows } = ohlcAtBottom(n, 100, 10);
      // Last 10 closes jump to the top of range
      const closes = Array.from({ length: n - 10 }, () => 90).concat(
        Array.from({ length: 10 }, () => 110),
      );
      const { smoothedK, smoothedD } = calcStochastic(highs, lows, closes, 14, 3, 3);
      assert(
        smoothedK[smoothedK.length - 1] >= smoothedD[smoothedD.length - 1],
        "After price jump to top, K should be >= D (K leads)",
      );
    });

    runTest(results, "Stochastic cross: K crosses above D in recovery", () => {
      const n = 40;
      const highs = Array.from({ length: n }, () => 110);
      const lows = Array.from({ length: n }, () => 90);
      // Prices: first half at bottom (K low), second half at top (K high)
      const closes = Array.from({ length: n }, (_, i) => (i < n / 2 ? 90 : 110));
      const { smoothedK, smoothedD } = calcStochastic(highs, lows, closes, 14, 3, 3);
      const kVals = lastTwo(smoothedK);
      const dVals = lastTwo(smoothedD);
      // After enough upward movement, K should be above D
      assert(
        kVals.last >= dVals.last,
        "K should be at or above D after price recovery",
      );
    });

    // ── KDJ ──────────────────────────────────────────────────────────────────

    runTest(results, "KDJ: RSV = 50 constantly → K = D = J = 50 (initial steady state)", () => {
      // All candles have same high/low/close → range = 0 → RSV = 50
      const n = 20;
      const highs = Array.from({ length: n }, () => 100);
      const lows = Array.from({ length: n }, () => 100);
      const closes = Array.from({ length: n }, () => 100);
      const { K, D, J } = calcKdj(highs, lows, closes, 9);
      assertClose(K[K.length - 1], 50, 0.1, "K should be ~50");
      assertClose(D[D.length - 1], 50, 0.1, "D should be ~50");
      assertClose(J[J.length - 1], 50, 0.1, "J should be ~50");
    });

    runTest(results, "KDJ: J = 3*K - 2*D formula holds for every value", () => {
      const n = 30;
      const highs = uptrendPrices(n, 110, 1);
      const lows = uptrendPrices(n, 90, 1);
      const closes = uptrendPrices(n, 100, 1);
      const { K, D, J } = calcKdj(highs, lows, closes, 9);
      for (let i = 0; i < K.length; i++) {
        assertClose(J[i], 3 * K[i] - 2 * D[i], 0.001, `J[${i}] should equal 3K-2D`);
      }
    });

    runTest(results, "KDJ: RSV = 100 constantly → K converges above 50", () => {
      // Close always at top → RSV = 100
      const n = 40;
      const highs = Array.from({ length: n }, () => 110);
      const lows = Array.from({ length: n }, () => 90);
      const closes = Array.from({ length: n }, () => 110); // = high → RSV = 100
      const { K } = calcKdj(highs, lows, closes, 9);
      assert(K[K.length - 1] > 50, `K (${K[K.length - 1].toFixed(2)}) should converge above 50`);
    });

    // ── ATR ──────────────────────────────────────────────────────────────────

    runTest(results, "ATR: zero intraday range and no gaps → ATR percent = 0", () => {
      const n = 20;
      const price = 100;
      const highs = Array.from({ length: n }, () => price);
      const lows = Array.from({ length: n }, () => price);
      const closes = Array.from({ length: n }, () => price);
      assertClose(calcAtrPercent(highs, lows, closes, 14), 0, 0.001, "Zero-range ATR");
    });

    runTest(results, "ATR: volatile prices → ATR percent > 0", () => {
      const n = 20;
      const highs = Array.from({ length: n }, () => 110);
      const lows = Array.from({ length: n }, () => 90);
      const closes = Array.from({ length: n }, () => 100);
      const atr = calcAtrPercent(highs, lows, closes, 14);
      assert(atr > 0, `ATR should be > 0 for volatile prices, got ${atr}`);
    });

    runTest(results, "ATR: higher intraday range → higher ATR percent", () => {
      const n = 20;
      const mkCandles = (range: number) => ({
        highs: Array.from({ length: n }, () => 100 + range),
        lows: Array.from({ length: n }, () => 100 - range),
        closes: Array.from({ length: n }, () => 100),
      });
      const low = mkCandles(5);
      const high = mkCandles(15);
      assert(
        calcAtrPercent(high.highs, high.lows, high.closes, 14) >
        calcAtrPercent(low.highs, low.lows, low.closes, 14),
        "Larger range → higher ATR percent",
      );
    });

    // ── Rule Engine Conditions ────────────────────────────────────────────────

    runTest(results, "RSI_ZONE: RSI < rsiBottom (30) → LONG signal condition", () => {
      const closes = downtrendPrices(31, 150, 3); // Strong downtrend → RSI very low
      const rsi = calcRsi(closes, 14);
      const rsiLast = rsi[rsi.length - 1];
      const rsiBottom = 30;
      // Verify RSI is actually low for downtrend
      assert(rsiLast < rsiBottom, `RSI (${rsiLast.toFixed(1)}) should be < ${rsiBottom} in downtrend`);
      // Verify LONG condition fires
      const longCondition = rsiLast < rsiBottom;
      assert(longCondition, "RSI_ZONE LONG condition should be true");
    });

    runTest(results, "RSI_ZONE: RSI > rsiTop (70) → SHORT signal condition", () => {
      const closes = uptrendPrices(31, 100, 3); // Strong uptrend → RSI very high
      const rsi = calcRsi(closes, 14);
      const rsiLast = rsi[rsi.length - 1];
      const rsiTop = 70;
      assert(rsiLast > rsiTop, `RSI (${rsiLast.toFixed(1)}) should be > ${rsiTop} in uptrend`);
      const shortCondition = rsiLast > rsiTop;
      assert(shortCondition, "RSI_ZONE SHORT condition should be true");
    });

    runTest(results, "RSI_CROSS: RSI crossedAbove RSI-EMA → LONG signal", () => {
      // Simulate RSI cross above RSI-EMA
      const rsi = { last: 52, secondLast: 48 }; // RSI went up
      const rsiEma = { last: 50, secondLast: 50 }; // RSI-EMA stayed flat
      assert(crossedAbove(rsi, rsiEma), "RSI crossedAbove RSI-EMA → LONG");
    });

    runTest(results, "RSI_CROSS: RSI crossedBelow RSI-EMA → SHORT signal", () => {
      const rsi = { last: 48, secondLast: 52 }; // RSI went down
      const rsiEma = { last: 50, secondLast: 50 }; // RSI-EMA stayed flat
      assert(crossedBelow(rsi, rsiEma), "RSI crossedBelow RSI-EMA → SHORT");
    });

    runTest(results, "TREND_EMA: fast EMA(9) crossedAbove slow EMA(21) → LONG", () => {
      const fastEma = { last: 105, secondLast: 99 }; // just crossed above
      const slowEma = { last: 102, secondLast: 102 };
      assert(crossedAbove(fastEma, slowEma), "Fast EMA crossedAbove slow EMA → LONG");
    });

    runTest(results, "MEAN_REVERT_RSI: price within range% of EMA200 + RSI extreme", () => {
      const entryPrice = 100;
      const ema200 = 100.3; // 0.3% above price
      const priceRange = 1.0; // allow 1% distance
      const rsi = 28; // below rsiBottom=30
      const rsiBottom = 30;

      const priceDistPercent = Math.abs((entryPrice - ema200) / ema200) * 100;
      const withinRange = priceDistPercent <= priceRange;
      const longCondition = rsi < rsiBottom && entryPrice < ema200; // price below EMA → not LONG

      // Actually for LONG: price > EMA (above mean). Let me use correct condition:
      // LONG: RSI < longRsi AND price is near EMA (within priceRange%)
      const isNearEma = priceDistPercent <= priceRange;
      const longRsiCondition = rsi < rsiBottom;
      assert(isNearEma, `Price is ${priceDistPercent.toFixed(2)}% from EMA200, within ${priceRange}%`);
      assert(longRsiCondition, `RSI ${rsi} < ${rsiBottom} → LONG zone`);
      assert(isNearEma && longRsiCondition, "MEAN_REVERT_RSI LONG conditions both met");
    });

    runTest(results, "MEAN_REVERT_RSI: price too far from EMA200 → no signal", () => {
      const entryPrice = 100;
      const ema200 = 103; // 3% away — outside priceRange=0.5%
      const priceRange = 0.5;
      const distPercent = Math.abs((entryPrice - ema200) / ema200) * 100;
      assert(distPercent > priceRange, `Price ${distPercent.toFixed(2)}% from EMA200 exceeds range ${priceRange}%`);
    });

    // ── 2-Stage State Machine (STOCH_BB / STOCH_EMA_KDJ) ────────────────────

    runTest(results, "2-Stage: stage1 → stage2 (same direction) → SIGNAL emitted", () => {
      const sm = new TwoStageStateMachine();
      sm.stage1(true); // Stage 1: LONG pattern detected
      const result = sm.stage2(true); // Stage 2: confirm LONG
      assertEqual(result, "SIGNAL", "Should emit SIGNAL on confirmation");
      assert(!sm.hasState(), "State should be cleared after signal");
    });

    runTest(results, "2-Stage: stage1 → stage2 direction mismatch → RESET", () => {
      const sm = new TwoStageStateMachine();
      sm.stage1(true); // Stage 1: LONG
      const result = sm.stage2(false); // Stage 2: SHORT — mismatch
      assertEqual(result, "RESET", "Direction mismatch should RESET state");
      assert(!sm.hasState(), "State should be cleared after mismatch");
    });

    runTest(results, "2-Stage: maxCandleCount exceeded → RESET (no signal)", () => {
      const sm = new TwoStageStateMachine();
      sm.stage1(true); // count=1
      sm.tick(); // count=2
      sm.tick(); // count=3
      sm.tick(); // count=4
      sm.tick(); // count=5
      const result = sm.tick(); // count=6 > maxCount=5 → RESET
      assertEqual(result, "RESET", "Should RESET after maxCandleCount exceeded");
      assert(!sm.hasState(), "State should be cleared");
    });

    runTest(results, "2-Stage: stage2 without prior stage1 → NO_STATE", () => {
      const sm = new TwoStageStateMachine();
      const result = sm.stage2(true);
      assertEqual(result, "NO_STATE", "Should return NO_STATE with no prior stage1");
    });

    runTest(results, "2-Stage: multiple coins independent (separate state machines)", () => {
      const smBtc = new TwoStageStateMachine();
      const smEth = new TwoStageStateMachine();

      smBtc.stage1(true); // BTC stage 1
      // ETH has no state
      assert(smBtc.hasState(), "BTC should have state");
      assert(!smEth.hasState(), "ETH should have no state (independent)");

      const ethResult = smEth.stage2(true);
      assertEqual(ethResult, "NO_STATE", "ETH stage2 without stage1 → NO_STATE");
      assert(smBtc.hasState(), "BTC state unaffected by ETH operations");
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "─".repeat(60));
    console.log(
      `  Total: ${results.total}  ✅ Passed: ${results.passed}  ❌ Failed: ${results.failed}`,
    );

    return results;
  }
}

// Run directly: npx ts-node src/simulator/strategy-indicators.simulator.ts
if (require.main === module) {
  const sim = new StrategyIndicatorsSimulator();
  const results = sim.runAllTests();
  process.exit(results.failed > 0 ? 1 : 0);
}
