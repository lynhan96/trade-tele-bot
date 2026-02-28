/**
 * AI Signal Queue Simulator
 * Tests the signal queue state machine, PnL formulas, TTL rules, stop loss math,
 * and confidence threshold gating — all in pure TypeScript, no NestJS/MongoDB/Redis.
 *
 * Mirrors logic in:
 *   - src/ai-signal/signal-queue.service.ts
 *   - src/ai-signal/ai-signal-stats.service.ts
 */

import {
  TestResult,
  runTest,
  assert,
  assertClose,
  assertEqual,
} from "./test-utils";

// ─── Types (mirror ai-signal.schema.ts) ──────────────────────────────────────

type Direction = "LONG" | "SHORT";
type SignalStatus = "ACTIVE" | "QUEUED" | "SKIPPED" | "CANCELLED" | "COMPLETED";
type TimeframeProfile = "INTRADAY" | "SWING";
type HandleAction = "EXECUTED" | "SKIPPED" | "QUEUED";

interface Signal {
  id: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  status: SignalStatus;
  expiresAt: Date;
  profile: TimeframeProfile;
  exitPrice?: number;
  pnlPercent?: number;
  cancelReason?: "REPLACED_BY_NEW" | "TTL_EXPIRED" | "MANUAL";
  executedAt?: Date;
}

// ─── TTL constants (ms) — mirror signal-queue.service.ts getActiveTtl/getQueuedTtl ──

const TTL_MS = {
  INTRADAY: { ACTIVE: 8 * 3600 * 1000, QUEUED: 4 * 3600 * 1000 },
  SWING: { ACTIVE: 72 * 3600 * 1000, QUEUED: 48 * 3600 * 1000 },
} as const;

// ─── Signal Queue State Machine (mirrors signal-queue.service.ts) ─────────────

class SignalQueueMachine {
  private activeMap = new Map<string, Signal>();
  private queuedMap = new Map<string, Signal>();
  readonly completed: Signal[] = [];
  readonly cancelled: Signal[] = [];
  readonly skipped: Signal[] = [];
  private counter = 0;

  private nextId = () => `sig_${++this.counter}`;

  /**
   * handleNewSignal — core state machine.
   * Returns:
   *   "EXECUTED"  → no active signal existed, new signal is now ACTIVE
   *   "SKIPPED"   → same direction as existing ACTIVE (silent, no notification)
   *   "QUEUED"    → opposite direction; existing QUEUED (if any) is REPLACED_BY_NEW
   */
  handleNew(
    symbol: string,
    direction: Direction,
    entryPrice: number,
    profile: TimeframeProfile = "INTRADAY",
  ): HandleAction {
    const active = this.activeMap.get(symbol);

    if (!active) {
      this.activeMap.set(symbol, {
        id: this.nextId(),
        symbol,
        direction,
        entryPrice,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + TTL_MS[profile].ACTIVE),
        profile,
        executedAt: new Date(),
      });
      return "EXECUTED";
    }

    if (active.direction === direction) {
      this.skipped.push({
        id: this.nextId(),
        symbol,
        direction,
        entryPrice,
        status: "SKIPPED",
        expiresAt: new Date(),
        profile,
      });
      return "SKIPPED";
    }

    // Opposite direction → QUEUED, cancel existing QUEUED with REPLACED_BY_NEW
    const existingQueued = this.queuedMap.get(symbol);
    if (existingQueued) {
      existingQueued.status = "CANCELLED";
      existingQueued.cancelReason = "REPLACED_BY_NEW";
      this.cancelled.push({ ...existingQueued });
      this.queuedMap.delete(symbol);
    }

    this.queuedMap.set(symbol, {
      id: this.nextId(),
      symbol,
      direction,
      entryPrice,
      status: "QUEUED",
      expiresAt: new Date(Date.now() + TTL_MS[profile].QUEUED),
      profile,
    });
    return "QUEUED";
  }

  /**
   * resolveActiveSignal — called when a position closes.
   * Guard: if exitPrice <= 0, skip (Binance API failure).
   * Calculates PnL and marks signal COMPLETED.
   */
  resolve(symbol: string, exitPrice: number): { pnlPercent: number } | null {
    if (exitPrice <= 0) return null; // Binance API failure guard
    const active = this.activeMap.get(symbol);
    if (!active) return null;

    const pnlPercent =
      active.direction === "LONG"
        ? ((exitPrice - active.entryPrice) / active.entryPrice) * 100
        : ((active.entryPrice - exitPrice) / active.entryPrice) * 100;

    active.status = "COMPLETED";
    active.exitPrice = exitPrice;
    active.pnlPercent = pnlPercent;
    this.completed.push({ ...active });
    this.activeMap.delete(symbol);
    return { pnlPercent };
  }

  /**
   * activateQueuedSignal — promotes QUEUED → ACTIVE after existing ACTIVE closes.
   * If QUEUED is expired → CANCELLED with TTL_EXPIRED.
   */
  promoteQueued(symbol: string, now = new Date()): Signal | null {
    const queued = this.queuedMap.get(symbol);
    if (!queued) return null;

    if (queued.expiresAt < now) {
      queued.status = "CANCELLED";
      queued.cancelReason = "TTL_EXPIRED";
      this.cancelled.push({ ...queued });
      this.queuedMap.delete(symbol);
      return null;
    }

    queued.status = "ACTIVE";
    queued.executedAt = now;
    queued.expiresAt = new Date(now.getTime() + TTL_MS[queued.profile].ACTIVE);
    this.activeMap.set(symbol, queued);
    this.queuedMap.delete(symbol);
    return queued;
  }

  /** cleanupExpiredQueued — cron: cancel all QUEUED signals past TTL */
  cleanupExpired(now = new Date()): number {
    let count = 0;
    for (const [symbol, queued] of this.queuedMap) {
      if (queued.expiresAt < now) {
        queued.status = "CANCELLED";
        queued.cancelReason = "TTL_EXPIRED";
        this.cancelled.push({ ...queued });
        this.queuedMap.delete(symbol);
        count++;
      }
    }
    return count;
  }

  getActive = (s: string) => this.activeMap.get(s);
  getQueued = (s: string) => this.queuedMap.get(s);
  stats = () => ({
    active: this.activeMap.size,
    queued: this.queuedMap.size,
    completed: this.completed.length,
    cancelled: this.cancelled.length,
    skipped: this.skipped.length,
  });
}

// ─── Pure helper formulas (mirror IndicatorService / SignalQueueService) ──────

/** Stop loss price from entryPrice + stopLossPercent */
function calcStopLoss(
  direction: Direction,
  entryPrice: number,
  slPercent: number,
): number {
  return direction === "LONG"
    ? entryPrice * (1 - slPercent / 100)
    : entryPrice * (1 + slPercent / 100);
}

/** PnL percent for a closed signal */
function calcPnl(
  direction: Direction,
  entryPrice: number,
  exitPrice: number,
): number {
  return direction === "LONG"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
}

/** Win rate from an array of pnlPercent values */
function calcWinRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  return (pnls.filter((p) => p > 0).length / pnls.length) * 100;
}

// ─── Simulator ───────────────────────────────────────────────────────────────

export class AiSignalQueueSimulator {
  public runAllTests(): TestResult {
    const results: TestResult = { total: 0, passed: 0, failed: 0 };

    console.log("\n🤖 AI SIGNAL QUEUE SIMULATOR");
    console.log(
      "Testing signal state machine, PnL formulas, TTL rules, stop loss math\n",
    );

    // ── State Machine: handleNewSignal ────────────────────────────────────────

    runTest(results, "handleNew: no active signal → EXECUTED, signal is ACTIVE", () => {
      const q = new SignalQueueMachine();
      const action = q.handleNew("BTCUSDT", "LONG", 100000);
      assertEqual(action, "EXECUTED", "Should return EXECUTED");
      assert(q.getActive("BTCUSDT") !== undefined, "Signal should be ACTIVE");
      assertEqual(q.getActive("BTCUSDT")!.direction, "LONG", "Direction should be LONG");
    });

    runTest(results, "handleNew: same direction as ACTIVE → SKIPPED (silent)", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      const action = q.handleNew("BTCUSDT", "LONG", 101000);
      assertEqual(action, "SKIPPED", "Same direction should be SKIPPED");
      assertEqual(q.stats().skipped, 1, "Skipped count should be 1");
      // Active signal unchanged
      assertEqual(q.getActive("BTCUSDT")!.entryPrice, 100000, "Active signal entry unchanged");
    });

    runTest(results, "handleNew: opposite direction → QUEUED", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      const action = q.handleNew("BTCUSDT", "SHORT", 102000);
      assertEqual(action, "QUEUED", "Opposite direction should be QUEUED");
      assert(q.getQueued("BTCUSDT") !== undefined, "QUEUED signal should exist");
      assertEqual(q.getQueued("BTCUSDT")!.direction, "SHORT", "QUEUED direction should be SHORT");
    });

    runTest(results, "handleNew: opposite direction with existing QUEUED → REPLACED_BY_NEW", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000); // ACTIVE
      q.handleNew("BTCUSDT", "SHORT", 101000); // QUEUED (first SHORT)
      const oldQueuedId = q.getQueued("BTCUSDT")!.id;

      q.handleNew("BTCUSDT", "SHORT", 102000); // QUEUED (second SHORT — replaces first)
      const newQueued = q.getQueued("BTCUSDT")!;

      assert(newQueued.id !== oldQueuedId, "New QUEUED should have a different id");
      assertEqual(newQueued.entryPrice, 102000, "New QUEUED should have updated entry price");
      assertEqual(q.stats().cancelled, 1, "Old QUEUED should be CANCELLED");
      assertEqual(q.cancelled[0].cancelReason, "REPLACED_BY_NEW", "Cancel reason should be REPLACED_BY_NEW");
    });

    runTest(results, "handleNew: multiple coins are independent", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      q.handleNew("ETHUSDT", "SHORT", 5000);

      // BTC same direction → SKIPPED; ETH not affected
      const action = q.handleNew("BTCUSDT", "LONG", 101000);
      assertEqual(action, "SKIPPED", "BTC same direction → SKIPPED");
      assert(q.getActive("ETHUSDT") !== undefined, "ETH signal should still be ACTIVE");
    });

    // ── State Machine: resolveActiveSignal ────────────────────────────────────

    runTest(results, "resolve: LONG profit → positive pnlPercent", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      const result = q.resolve("BTCUSDT", 110000)!;
      assertClose(result.pnlPercent, 10, 0.001, "LONG +10% PnL");
      assertEqual(q.stats().completed, 1, "Signal should be COMPLETED");
      assert(q.getActive("BTCUSDT") === undefined, "Active signal should be removed");
    });

    runTest(results, "resolve: LONG loss → negative pnlPercent", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      const result = q.resolve("BTCUSDT", 95000)!;
      assertClose(result.pnlPercent, -5, 0.001, "LONG -5% PnL");
    });

    runTest(results, "resolve: SHORT profit → positive pnlPercent", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "SHORT", 100000);
      const result = q.resolve("BTCUSDT", 90000)!;
      assertClose(result.pnlPercent, 10, 0.001, "SHORT +10% PnL (price went down)");
    });

    runTest(results, "resolve: SHORT loss → negative pnlPercent", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "SHORT", 100000);
      const result = q.resolve("BTCUSDT", 105000)!;
      assertClose(result.pnlPercent, -5, 0.001, "SHORT -5% PnL (price went up)");
    });

    runTest(results, "resolve: exitPrice ≤ 0 → null (Binance API failure guard)", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      const result0 = q.resolve("BTCUSDT", 0);
      const resultNeg = q.resolve("BTCUSDT", -1);
      assert(result0 === null, "exitPrice=0 should return null");
      assert(resultNeg === null, "exitPrice<0 should return null");
      assert(q.getActive("BTCUSDT") !== undefined, "Signal should remain ACTIVE on null guard");
    });

    // ── State Machine: activateQueuedSignal ───────────────────────────────────

    runTest(results, "promoteQueued: QUEUED not expired → promotes to ACTIVE", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000); // ACTIVE
      q.handleNew("BTCUSDT", "SHORT", 101000); // QUEUED

      q.resolve("BTCUSDT", 110000); // Close ACTIVE
      assert(q.getActive("BTCUSDT") === undefined, "No active after close");

      const promoted = q.promoteQueued("BTCUSDT");
      assert(promoted !== null, "QUEUED should be promoted");
      assertEqual(promoted!.status, "ACTIVE", "Promoted signal should be ACTIVE");
      assertEqual(promoted!.direction, "SHORT", "Promoted signal direction should be SHORT");
      assert(q.getActive("BTCUSDT") !== undefined, "Active signal should now exist");
      assert(q.getQueued("BTCUSDT") === undefined, "QUEUED slot should be empty");
    });

    runTest(results, "promoteQueued: QUEUED expired → CANCELLED with TTL_EXPIRED", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      q.handleNew("BTCUSDT", "SHORT", 101000); // QUEUED

      // Simulate expired time — pass a future "now"
      const futureNow = new Date(Date.now() + 5 * 3600 * 1000); // 5h later
      q.resolve("BTCUSDT", 110000); // Close ACTIVE first

      const promoted = q.promoteQueued("BTCUSDT", futureNow);
      assert(promoted === null, "Expired QUEUED should return null");
      assertEqual(q.stats().cancelled, 1, "Expired QUEUED should be CANCELLED");
      assertEqual(q.cancelled[0].cancelReason, "TTL_EXPIRED", "Cancel reason should be TTL_EXPIRED");
    });

    runTest(results, "promoteQueued: no QUEUED signal → returns null", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000);
      q.resolve("BTCUSDT", 110000); // Close ACTIVE

      const promoted = q.promoteQueued("BTCUSDT");
      assert(promoted === null, "No QUEUED → should return null");
    });

    // ── TTL Rules ─────────────────────────────────────────────────────────────

    runTest(results, "TTL: INTRADAY ACTIVE = 8h, QUEUED = 4h", () => {
      assertEqual(TTL_MS.INTRADAY.ACTIVE, 8 * 3600 * 1000, "INTRADAY ACTIVE TTL = 8h");
      assertEqual(TTL_MS.INTRADAY.QUEUED, 4 * 3600 * 1000, "INTRADAY QUEUED TTL = 4h");
    });

    runTest(results, "TTL: SWING ACTIVE = 72h, QUEUED = 48h", () => {
      assertEqual(TTL_MS.SWING.ACTIVE, 72 * 3600 * 1000, "SWING ACTIVE TTL = 72h");
      assertEqual(TTL_MS.SWING.QUEUED, 48 * 3600 * 1000, "SWING QUEUED TTL = 48h");
    });

    runTest(results, "TTL: SWING expires later than INTRADAY for same status", () => {
      assert(TTL_MS.SWING.ACTIVE > TTL_MS.INTRADAY.ACTIVE, "SWING ACTIVE TTL > INTRADAY ACTIVE TTL");
      assert(TTL_MS.SWING.QUEUED > TTL_MS.INTRADAY.QUEUED, "SWING QUEUED TTL > INTRADAY QUEUED TTL");
    });

    runTest(results, "TTL: INTRADAY QUEUED (4h) expires before ACTIVE (8h)", () => {
      assert(TTL_MS.INTRADAY.QUEUED < TTL_MS.INTRADAY.ACTIVE, "QUEUED TTL < ACTIVE TTL (signals expire from queue first)");
    });

    // ── cleanupExpired ────────────────────────────────────────────────────────

    runTest(results, "cleanupExpired: cancels all QUEUED signals past TTL", () => {
      const q = new SignalQueueMachine();
      // Add two ACTIVE signals and two QUEUED (opposite direction)
      q.handleNew("BTCUSDT", "LONG", 100000);
      q.handleNew("ETHUSDT", "LONG", 5000);
      q.handleNew("BTCUSDT", "SHORT", 101000); // QUEUED
      q.handleNew("ETHUSDT", "SHORT", 5100); // QUEUED

      // Future time past INTRADAY QUEUED TTL (4h+1ms)
      const futureNow = new Date(Date.now() + 4 * 3600 * 1000 + 1);
      const removed = q.cleanupExpired(futureNow);

      assertEqual(removed, 2, "Should cleanup 2 expired QUEUED signals");
      assertEqual(q.stats().cancelled, 2, "Both QUEUED signals should be CANCELLED");
      assert(q.getQueued("BTCUSDT") === undefined, "BTCUSDT QUEUED should be gone");
      assert(q.getQueued("ETHUSDT") === undefined, "ETHUSDT QUEUED should be gone");
    });

    // ── Stop Loss Math ────────────────────────────────────────────────────────

    runTest(results, "Stop loss: LONG = entryPrice * (1 - slPercent/100)", () => {
      assertClose(calcStopLoss("LONG", 100000, 2), 98000, 0.01, "LONG SL at 2%");
      assertClose(calcStopLoss("LONG", 50000, 5), 47500, 0.01, "LONG SL at 5%");
      assertClose(calcStopLoss("LONG", 100000, 0.5), 99500, 0.01, "LONG SL at 0.5%");
    });

    runTest(results, "Stop loss: SHORT = entryPrice * (1 + slPercent/100)", () => {
      assertClose(calcStopLoss("SHORT", 100000, 2), 102000, 0.01, "SHORT SL at 2%");
      assertClose(calcStopLoss("SHORT", 50000, 5), 52500, 0.01, "SHORT SL at 5%");
      assertClose(calcStopLoss("SHORT", 100000, 0.5), 100500, 0.01, "SHORT SL at 0.5%");
    });

    runTest(results, "Stop loss: SL always on losing side (below LONG entry, above SHORT entry)", () => {
      const longSl = calcStopLoss("LONG", 100000, 2);
      const shortSl = calcStopLoss("SHORT", 100000, 2);
      assert(longSl < 100000, `LONG SL ${longSl} should be below entry 100000`);
      assert(shortSl > 100000, `SHORT SL ${shortSl} should be above entry 100000`);
    });

    // ── PnL & Stats ───────────────────────────────────────────────────────────

    runTest(results, "PnL: symmetric — same % move gives same PnL for LONG/SHORT", () => {
      // LONG +5%: price 100→105
      const longPnl = calcPnl("LONG", 100, 105);
      // SHORT +5%: price 100→95
      const shortPnl = calcPnl("SHORT", 100, 95);
      assertClose(longPnl, shortPnl, 0.001, "LONG and SHORT PnL should be equal for same move %");
    });

    runTest(results, "PnL: SL hit = negative equal to slPercent", () => {
      const slPercent = 2;
      const longSl = calcStopLoss("LONG", 100000, slPercent);
      const longPnl = calcPnl("LONG", 100000, longSl);
      assertClose(longPnl, -slPercent, 0.001, "PnL at SL should equal -slPercent");

      const shortSl = calcStopLoss("SHORT", 100000, slPercent);
      const shortPnl = calcPnl("SHORT", 100000, shortSl);
      assertClose(shortPnl, -slPercent, 0.001, "SHORT PnL at SL should equal -slPercent");
    });

    runTest(results, "Stats: win rate calculation (wins / total * 100)", () => {
      const pnls = [5, -2, 3, -1, 4, 0.5, 2, 1]; // 6 wins, 2 losses
      const winRate = calcWinRate(pnls);
      assertClose(winRate, 75, 0.001, "Win rate should be 75% (6/8)");
    });

    runTest(results, "Stats: win rate = 0% if all losses", () => {
      const pnls = [-1, -2, -3];
      assertClose(calcWinRate(pnls), 0, 0.001, "All losses → 0% win rate");
    });

    runTest(results, "Stats: win rate = 100% if all wins", () => {
      const pnls = [1, 2, 3];
      assertClose(calcWinRate(pnls), 100, 0.001, "All wins → 100% win rate");
    });

    // ── Confidence Gate ───────────────────────────────────────────────────────

    runTest(results, "Confidence gate: confidence < minConfidenceToTrade → skip signal", () => {
      const confidence = 55;
      const minConfidence = 60;
      const shouldTrade = confidence >= minConfidence;
      assert(!shouldTrade, "Below-threshold confidence should not trade");
    });

    runTest(results, "Confidence gate: confidence >= minConfidenceToTrade → allow signal", () => {
      const confidence = 75;
      const minConfidence = 60;
      const shouldTrade = confidence >= minConfidence;
      assert(shouldTrade, "Above-threshold confidence should allow trading");
    });

    runTest(results, "Confidence gate: exact threshold (confidence = minConfidence) → allow", () => {
      const confidence = 60;
      const minConfidence = 60;
      assert(confidence >= minConfidence, "Exact threshold should allow trading (>=)");
    });

    // ── Full Flow ─────────────────────────────────────────────────────────────

    runTest(results, "Full flow: ACTIVE → resolve → promoteQueued → new ACTIVE", () => {
      const q = new SignalQueueMachine();

      // Step 1: Generate LONG signal (ACTIVE)
      q.handleNew("BTCUSDT", "LONG", 100000);
      assert(q.getActive("BTCUSDT")?.direction === "LONG", "Step 1: LONG ACTIVE");

      // Step 2: Opposite signal queued
      q.handleNew("BTCUSDT", "SHORT", 105000);
      assert(q.getQueued("BTCUSDT")?.direction === "SHORT", "Step 2: SHORT QUEUED");

      // Step 3: Resolve LONG with profit
      const resolved = q.resolve("BTCUSDT", 110000)!;
      assertClose(resolved.pnlPercent, 10, 0.001, "Step 3: LONG +10%");
      assert(q.getActive("BTCUSDT") === undefined, "Step 3: No active after resolve");

      // Step 4: Promote QUEUED → ACTIVE
      const promoted = q.promoteQueued("BTCUSDT")!;
      assertEqual(promoted.direction, "SHORT", "Step 4: SHORT promoted to ACTIVE");
      assert(q.getActive("BTCUSDT")?.direction === "SHORT", "Step 4: SHORT now ACTIVE");

      // Verify final stats
      assertEqual(q.stats().completed, 1, "1 completed signal");
      assertEqual(q.stats().active, 1, "1 active signal");
    });

    runTest(results, "Full flow: SWING profile signal gets longer TTL than INTRADAY", () => {
      const q = new SignalQueueMachine();
      q.handleNew("BTCUSDT", "LONG", 100000, "SWING");
      q.handleNew("ETHUSDT", "LONG", 5000, "INTRADAY");

      const swingActive = q.getActive("BTCUSDT")!;
      const intradayActive = q.getActive("ETHUSDT")!;

      assert(
        swingActive.expiresAt > intradayActive.expiresAt,
        "SWING signal should expire later than INTRADAY signal",
      );
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "─".repeat(60));
    console.log(
      `  Total: ${results.total}  ✅ Passed: ${results.passed}  ❌ Failed: ${results.failed}`,
    );

    return results;
  }
}

// Run directly: npx ts-node src/simulator/ai-signal-queue.simulator.ts
if (require.main === module) {
  const sim = new AiSignalQueueSimulator();
  const results = sim.runAllTests();
  process.exit(results.failed > 0 ? 1 : 0);
}
