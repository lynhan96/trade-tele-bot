/**
 * Service Structure Simulator
 * Tests logic patterns extracted during the telegram.service.ts refactoring.
 * Covers: TP profit math, storeTpSl guard, volume reduction, EMA, processingLocks.
 */

import { TestResult, runTest, assert, assertClose, assertEqual } from "./test-utils";

export class ServiceStructureSimulator {
  // ─── TP Profit Percent (mirrors TakeProfitService) ───────────────────────

  private calcProfitPercent(
    side: "LONG" | "SHORT",
    entryPrice: number,
    currentPrice: number,
  ): number {
    return side === "LONG"
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;
  }

  // ─── EMA (mirrors ReentryService.calculateEMA) ────────────────────────────

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  // ─── Volume reduction (mirrors re-entry quantity calc) ────────────────────

  private calcNextQuantity(quantity: number, reductionPercent: number): number {
    return quantity * (1 - reductionPercent / 100);
  }

  // ─── storeTpSl side-change guard (mirrors all services) ──────────────────

  private shouldSkipStoreTpSl(
    existingSide: "LONG" | "SHORT" | null,
    newSide: "LONG" | "SHORT",
  ): boolean {
    // If existing data exists and side changed → skip to avoid overwriting
    return existingSide !== null && existingSide !== newSide;
  }

  // ─── Profitable position filter (mirrors checkAggregateTP / checkIndividualPositionTP) ──

  private isProfitableEnough(
    side: "LONG" | "SHORT",
    entryPrice: number,
    currentPrice: number,
    unrealizedPnl: number,
    minPercent = 2,
  ): boolean {
    if (unrealizedPnl <= 0) return false;
    return this.calcProfitPercent(side, entryPrice, currentPrice) > minPercent;
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  public runAllTests(): TestResult {
    const results: TestResult = { total: 0, passed: 0, failed: 0 };

    console.log("\n🔬 SERVICE STRUCTURE SIMULATOR");
    console.log("Testing logic patterns from the refactored domain services\n");

    // ── 1. TP profit percent — LONG ─────────────────────────────────────────
    runTest(results, "LONG profit: (currentPrice - entryPrice) / entryPrice * 100", () => {
      assertClose(
        this.calcProfitPercent("LONG", 100000, 110000),
        10,
        0.001,
        "LONG +10%",
      );
      assertClose(
        this.calcProfitPercent("LONG", 100000, 95000),
        -5,
        0.001,
        "LONG -5%",
      );
    });

    // ── 2. TP profit percent — SHORT ────────────────────────────────────────
    runTest(results, "SHORT profit: (entryPrice - currentPrice) / entryPrice * 100", () => {
      assertClose(
        this.calcProfitPercent("SHORT", 100000, 90000),
        10,
        0.001,
        "SHORT +10%",
      );
      assertClose(
        this.calcProfitPercent("SHORT", 100000, 105000),
        -5,
        0.001,
        "SHORT -5%",
      );
    });

    // ── 3. Profitable position filter — passes ───────────────────────────────
    runTest(results, "isProfitableEnough: PnL>0 AND profit>2% → true", () => {
      assert(
        this.isProfitableEnough("LONG", 100000, 105000, 500),
        "LONG +5% with PnL should be profitable",
      );
      assert(
        this.isProfitableEnough("SHORT", 100000, 97000, 300),
        "SHORT +3% with PnL should be profitable",
      );
    });

    // ── 4. Profitable position filter — rejects ──────────────────────────────
    runTest(results, "isProfitableEnough: PnL≤0 → false; profit≤2% → false", () => {
      assert(
        !this.isProfitableEnough("LONG", 100000, 105000, -100),
        "Negative PnL should be rejected",
      );
      assert(
        !this.isProfitableEnough("LONG", 100000, 101000, 100),
        "Only +1% (below 2% guard) should be rejected",
      );
      assert(
        !this.isProfitableEnough("LONG", 100000, 102000, 200),
        "Exactly +2% (not > 2%) should be rejected",
      );
    });

    // ── 5. storeTpSl side-change guard ──────────────────────────────────────
    runTest(results, "storeTpSl: skip if side changed (LONG→SHORT)", () => {
      assert(
        this.shouldSkipStoreTpSl("LONG", "SHORT"),
        "Should skip when existing=LONG, new=SHORT",
      );
      assert(
        this.shouldSkipStoreTpSl("SHORT", "LONG"),
        "Should skip when existing=SHORT, new=LONG",
      );
    });

    runTest(results, "storeTpSl: proceed if same side or no existing data", () => {
      assert(
        !this.shouldSkipStoreTpSl("LONG", "LONG"),
        "Should NOT skip when same side LONG→LONG",
      );
      assert(
        !this.shouldSkipStoreTpSl(null, "LONG"),
        "Should NOT skip when no existing data",
      );
    });

    // ── 6. Volume reduction — single cycle ───────────────────────────────────
    runTest(results, "Volume reduction: qty * (1 - reductionPercent/100)", () => {
      assertClose(
        this.calcNextQuantity(1.0, 15),
        0.85,
        0.0001,
        "1.0 BTC at 15% reduction",
      );
      assertClose(
        this.calcNextQuantity(1.0, 20),
        0.8,
        0.0001,
        "1.0 BTC at 20% reduction",
      );
      assertClose(
        this.calcNextQuantity(0.5, 10),
        0.45,
        0.0001,
        "0.5 BTC at 10% reduction",
      );
    });

    // ── 7. Volume reduction — multi-cycle ────────────────────────────────────
    runTest(results, "Volume reduction: 3 cycles at 20% each", () => {
      let qty = 1.0;
      const expected = [0.8, 0.64, 0.512];
      for (const exp of expected) {
        qty = this.calcNextQuantity(qty, 20);
        assertClose(qty, exp, 0.0001, `Expected ${exp} after reduction`);
      }
      assert(qty < 1.0, "Final quantity must be less than original");
    });

    // ── 8. EMA calculation — basic correctness ───────────────────────────────
    runTest(results, "EMA(3) on [10,11,12,13,14] matches expected value", () => {
      const prices = [10, 11, 12, 13, 14];
      const ema3 = this.calculateEMA(prices, 3);
      // Seed = (10+11+12)/3 = 11, multiplier = 2/4 = 0.5
      // i=3: (13-11)*0.5 + 11 = 12
      // i=4: (14-12)*0.5 + 12 = 13
      assertClose(ema3, 13, 0.001, "EMA(3) final value");
    });

    // ── 9. EMA: short price array falls back to last price ───────────────────
    runTest(results, "EMA: prices.length < period → returns last price", () => {
      const prices = [100, 102, 104];
      const ema21 = this.calculateEMA(prices, 21);
      assertEqual(ema21, 104, "Should return last price when not enough data");
    });

    // ── 10. EMA crossover direction check ────────────────────────────────────
    runTest(results, "EMA crossover: ema9 > ema21 signals bullish (LONG re-entry)", () => {
      // Uptrending prices → EMA9 should be above EMA21
      const trendingUp: number[] = [];
      for (let i = 0; i < 30; i++) trendingUp.push(100 + i * 2);

      const ema9 = this.calculateEMA(trendingUp, 9);
      const ema21 = this.calculateEMA(trendingUp, 21);

      assert(ema9 > ema21, `ema9 (${ema9.toFixed(2)}) should > ema21 (${ema21.toFixed(2)}) in uptrend`);
    });

    runTest(results, "EMA crossover: ema9 < ema21 signals bearish (SHORT re-entry)", () => {
      // Downtrending prices → EMA9 should be below EMA21
      const trendingDown: number[] = [];
      for (let i = 0; i < 30; i++) trendingDown.push(200 - i * 2);

      const ema9 = this.calculateEMA(trendingDown, 9);
      const ema21 = this.calculateEMA(trendingDown, 21);

      assert(ema9 < ema21, `ema9 (${ema9.toFixed(2)}) should < ema21 (${ema21.toFixed(2)}) in downtrend`);
    });

    // ── 11. processingLocks Set — prevents concurrent processing ─────────────
    runTest(results, "processingLocks Set: add/has/delete lifecycle", () => {
      const processingLocks = new Set<string>();
      const lockKey = "12345:binance";

      assert(!processingLocks.has(lockKey), "Lock should not exist before add");
      processingLocks.add(lockKey);
      assert(processingLocks.has(lockKey), "Lock should exist after add");
      processingLocks.delete(lockKey);
      assert(!processingLocks.has(lockKey), "Lock should not exist after delete");
    });

    runTest(results, "processingLocks Set: skip if lock already held", () => {
      const processingLocks = new Set<string>();
      const lockKey = "12345:binance";
      let processed = 0;

      // First invocation — acquires lock
      if (!processingLocks.has(lockKey)) {
        processingLocks.add(lockKey);
        processed++;
        processingLocks.delete(lockKey);
      }

      // Second concurrent invocation — lock already held mid-flight
      processingLocks.add(lockKey); // simulate lock held by first
      if (!processingLocks.has(lockKey)) {
        processed++; // this should NOT run
      }
      processingLocks.delete(lockKey);

      assertEqual(processed, 1, "Only one invocation should process");
    });

    // ── 12. IncomingSignal equity field — handles BUY as alias for LONG ──────
    runTest(results, "IncomingSignal equity: BUY maps to LONG side", () => {
      const signal = { equity: "BUY" as "LONG" | "SHORT" | "BUY" };
      // In executeSignalTrade, BUY is treated as LONG for futures
      const normalizedSide = signal.equity === "BUY" ? "LONG" : signal.equity;
      assertEqual(normalizedSide, "LONG", "BUY should normalize to LONG");
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "─".repeat(60));
    console.log(
      `  Total: ${results.total}  ✅ Passed: ${results.passed}  ❌ Failed: ${results.failed}`,
    );

    return results;
  }
}

// Run directly with: npx ts-node src/simulator/service-structure.simulator.ts
if (require.main === module) {
  const simulator = new ServiceStructureSimulator();
  const results = simulator.runAllTests();
  process.exit(results.failed > 0 ? 1 : 0);
}
