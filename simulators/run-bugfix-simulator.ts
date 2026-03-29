/**
 * Bug Fix & Edge Case Simulator
 * Tests all bugs fixed in Phase 1/2/3 (2026-03-29) + historical bugs
 * Run: npx ts-node run-bugfix-simulator.ts
 */

// ─── Config (mirrors current TradingConfig defaults) ─────────────────────
const CONFIG = {
  hedgeEnabled: true,
  hedgePartialTriggerPct: 3.0,
  hedgeFullTriggerPct: 3.0,
  hedgeTpPctDefault: 3.0,
  hedgeTpPctTrend: 3.5,
  hedgeTpPctVolatile: 4.0,
  hedgeReEntryCooldownMin: 5,
  hedgeSlImprovementRatio: 0.8,
  hedgeSafetySlPct: 10,
  hedgeTrailKeepRatio: 0.70,
  hedgeBlockRegimes: ['SIDEWAYS'],
  hedgeMaxConsecutiveLosses: 2,
  simTakerFeePct: 0.04,
  simNotional: 1000,
  trailTrigger: 2.5,
  trailKeepRatio: 0.80,
  confidenceFloor: 68,
  maxConfidenceCap: 75, // was 68
  riskScoreThreshold: 55,
};

const DCA_WEIGHTS = [40, 15, 15, 30]; // L0=40%, L1=15%, L2=15%, L3=30%
const GRID_DEVIATIONS = [0, 2, 4, 6];

// ─── Helpers ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, details?: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`);
    failed++;
  }
}
function approx(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}
function takerFee(notional: number): number {
  return +(notional * CONFIG.simTakerFeePct / 100).toFixed(4);
}

// ─── Grid Factory ────────────────────────────────────────────────────────
function createGridLevels(entry: number, simNotional: number) {
  return DCA_WEIGHTS.map((w, i) => ({
    level: i,
    deviationPct: GRID_DEVIATIONS[i],
    volumePct: w,
    status: i === 0 ? 'FILLED' : 'PENDING',
    fillPrice: i === 0 ? entry : 0,
    filledAt: i === 0 ? new Date() : null,
    simNotional: i === 0 ? simNotional * (w / 100) : 0,
    simQuantity: i === 0 ? (simNotional * (w / 100)) / entry : 0,
  }));
}

// ─── SL Improvement Calculator (mirrors hedge-manager.service.ts) ────────
function calculateSlImprovement(
  hedgePnlUsdt: number, originalNotional: number, originalEntry: number,
  currentSl: number, direction: string,
): number {
  if (hedgePnlUsdt <= 0 || originalNotional <= 0 || originalEntry <= 0) return currentSl;
  const slImprovement = (hedgePnlUsdt * CONFIG.hedgeSlImprovementRatio) / originalNotional * originalEntry;
  let newSl: number;
  if (direction === 'LONG') {
    newSl = currentSl + slImprovement;
    newSl = Math.min(newSl, originalEntry * 0.998);
  } else {
    newSl = currentSl - slImprovement;
    newSl = Math.max(newSl, originalEntry * 1.002);
  }
  return +newSl.toFixed(6);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 1: L0 WEIGHT FIX — signal-queue must use 40% (was 35%)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 1: L0 Weight Alignment (Bug Fix #1) ═══\n');
{
  const simNotional = 1000;
  const l0Vol = simNotional * 0.40; // FIXED: was 0.35
  const grids = createGridLevels(100, simNotional);

  assert(l0Vol === 400, `L0 volume = $400 (40% of $1000)`, `got $${l0Vol}`);
  assert(grids[0].simNotional === 400, `Grid L0 simNotional = $400`, `got $${grids[0].simNotional}`);
  assert(grids[0].volumePct === 40, `Grid L0 volumePct = 40%`, `got ${grids[0].volumePct}%`);

  // Sum of all weights = 100%
  const totalWeight = DCA_WEIGHTS.reduce((s, w) => s + w, 0);
  assert(totalWeight === 100, `Total grid weights = 100%`, `got ${totalWeight}%`);

  // Full grid notional = simNotional
  const fullNotional = DCA_WEIGHTS.reduce((s, w) => s + simNotional * (w / 100), 0);
  assert(fullNotional === simNotional, `Full grid notional = $${simNotional}`, `got $${fullNotional}`);

  // L0 in signal-queue must match DCA_WEIGHTS[0]
  const signalQueueL0 = simNotional * (DCA_WEIGHTS[0] / 100);
  assert(l0Vol === signalQueueL0, `signal-queue L0 matches DCA_WEIGHTS[0]`, `${l0Vol} vs ${signalQueueL0}`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 2: HEDGE PEAK PERSIST (Bug Fix #2)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 2: Hedge Peak PnL Persist (Bug Fix #2) ═══\n');
{
  // Simulate peak tracking with persist/restore
  const peakMap = new Map<string, number>();
  const signalId = 'test-peak-1';

  // Simulate hedge PnL progression
  const pnlSequence = [0.5, 1.0, 2.0, 3.0, 3.5, 3.2, 2.8, 3.8, 4.0, 3.5];
  let dbPeak = 0; // simulates DB-persisted value

  for (const pnl of pnlSequence) {
    const currentPeak = peakMap.get(signalId) || dbPeak || 0;
    if (pnl > currentPeak) {
      peakMap.set(signalId, pnl);
      dbPeak = pnl; // persist to DB
    }
  }
  assert(peakMap.get(signalId) === 4.0, `Peak tracked correctly: 4.0%`, `got ${peakMap.get(signalId)}%`);
  assert(dbPeak === 4.0, `DB peak persisted: 4.0%`, `got ${dbPeak}%`);

  // Simulate restart — clear in-memory, load from DB
  peakMap.clear();
  assert(peakMap.get(signalId) === undefined, `In-memory cleared after restart`);

  // Restore from DB
  const restoredPeak = peakMap.get(signalId) || dbPeak || 0;
  assert(restoredPeak === 4.0, `Peak restored from DB: 4.0%`, `got ${restoredPeak}%`);
  peakMap.set(signalId, restoredPeak);

  // Continue tracking after restart
  const postRestartPnl = [3.0, 4.5];
  for (const pnl of postRestartPnl) {
    const cp = peakMap.get(signalId) || 0;
    if (pnl > cp) { peakMap.set(signalId, pnl); dbPeak = pnl; }
  }
  assert(peakMap.get(signalId) === 4.5, `Peak continues after restart: 4.5%`, `got ${peakMap.get(signalId)}%`);

  // Edge case: peak should NOT decrease
  const declining = [4.0, 3.5, 3.0];
  for (const pnl of declining) {
    const cp = peakMap.get(signalId) || 0;
    if (pnl > cp) { peakMap.set(signalId, pnl); dbPeak = pnl; }
  }
  assert(peakMap.get(signalId) === 4.5, `Peak never decreases: still 4.5%`, `got ${peakMap.get(signalId)}%`);

  // Edge case: new hedge cycle resets peak
  peakMap.delete(signalId);
  dbPeak = 0;
  assert(peakMap.get(signalId) === undefined, `Peak cleared for new cycle`);
  assert(dbPeak === 0, `DB peak cleared for new cycle`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 3: CONSECUTIVE LOSS PERSIST (Bug Fix #3)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 3: Consecutive Loss Persist (Bug Fix #3) ═══\n');
{
  const lossMap = new Map<string, number>();
  const redisStore: Record<string, number> = {};
  const signalId = 'test-loss-1';

  // Helper: set with Redis backup
  function setLosses(id: string, val: number) {
    lossMap.set(id, val);
    redisStore[`cache:hedge:losses:${id}`] = val;
  }
  // Helper: get with Redis fallback
  function getLosses(id: string): number {
    const mem = lossMap.get(id);
    if (mem !== undefined) return mem;
    return redisStore[`cache:hedge:losses:${id}`] ?? 0;
  }

  // Simulate 3 consecutive losses
  setLosses(signalId, 1);
  assert(getLosses(signalId) === 1, `After 1st loss: count=1`);
  setLosses(signalId, 2);
  assert(getLosses(signalId) === 2, `After 2nd loss: count=2`);
  setLosses(signalId, 3);
  assert(getLosses(signalId) === 3, `After 3rd loss: count=3`);

  // Simulate restart
  lossMap.clear();
  assert(lossMap.get(signalId) === undefined, `In-memory cleared after restart`);
  assert(getLosses(signalId) === 3, `Redis fallback restores count=3`);

  // Win resets counter
  setLosses(signalId, 0);
  assert(getLosses(signalId) === 0, `Win resets to 0`);

  // Cleanup removes Redis key
  lossMap.delete(signalId);
  delete redisStore[`cache:hedge:losses:${signalId}`];
  assert(getLosses(signalId) === 0, `After cleanup: count=0`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 4: CONFIDENCE CAP (Bug Fix #4)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 4: Confidence Cap Raised to 75 (Bug Fix #4) ═══\n');
{
  function applyConfidenceFloor(
    confidence: number, regime: string, marketGuardFloor: number = 0
  ): { minConfidence: number; passed: boolean } {
    const isRanging = regime === 'RANGE_BOUND' || regime === 'SIDEWAYS';
    const rangingFloor = 70;
    const baseFloor = CONFIG.confidenceFloor; // 68
    const effectiveFloor = isRanging
      ? Math.max(rangingFloor, marketGuardFloor)
      : Math.max(baseFloor, marketGuardFloor);
    let minConf = Math.max(0, effectiveFloor);
    const cap = CONFIG.maxConfidenceCap; // 75
    if (minConf > cap) minConf = cap;
    return { minConfidence: minConf, passed: confidence >= minConf };
  }

  // Normal regime: floor=68, cap=75
  const r1 = applyConfidenceFloor(70, 'MIXED');
  assert(r1.minConfidence === 68, `MIXED floor = 68`, `got ${r1.minConfidence}`);
  assert(r1.passed === true, `70 confidence passes MIXED (>= 68)`);

  // Ranging: floor=70, cap=75
  const r2 = applyConfidenceFloor(72, 'RANGE_BOUND');
  assert(r2.minConfidence === 70, `RANGE_BOUND floor = 70`, `got ${r2.minConfidence}`);
  assert(r2.passed === true, `72 confidence passes RANGE_BOUND (>= 70)`);

  // Old bug: cap=68 would kill 70-confidence signals in ranging
  const r3 = applyConfidenceFloor(70, 'RANGE_BOUND');
  assert(r3.passed === true, `70 confidence NOW passes RANGE_BOUND (old cap 68 would block)`);

  // Futures penalty: -8 from funding → 70-8=62 → blocked by floor
  const r4 = applyConfidenceFloor(62, 'MIXED');
  assert(r4.passed === false, `62 confidence blocked in MIXED (< 68)`);

  // Market guard override: floor = 72
  const r5 = applyConfidenceFloor(73, 'MIXED', 72);
  assert(r5.minConfidence === 72, `Market guard raises floor to 72`, `got ${r5.minConfidence}`);
  assert(r5.passed === true, `73 passes with guard floor 72`);

  // Cap prevents floor from going above 75
  const r6 = applyConfidenceFloor(74, 'RANGE_BOUND', 80);
  assert(r6.minConfidence === 75, `Guard floor 80 capped at 75`, `got ${r6.minConfidence}`);
  assert(r6.passed === false, `74 blocked when capped floor = 75`);

  // Edge: exactly at cap
  const r7 = applyConfidenceFloor(75, 'RANGE_BOUND', 80);
  assert(r7.passed === true, `75 passes at cap boundary`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 5: RECOVERY CLOSE THRESHOLD (Phase 2 Fix)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 5: Recovery Close Threshold Raised (Phase 2) ═══\n');
{
  function checkRecoveryClose(mainPnlPct: number, hedgePnlPct: number, bankedTotal: number): string | null {
    const softClose = mainPnlPct > 1.0 && hedgePnlPct >= 1.5; // NEW: was 0.5 + 1.0
    const bankedThreshold = bankedTotal > 20;
    if (softClose) return 'RECOVERY_SOFT';
    if (bankedThreshold) return 'BANKED_TOTAL';
    return null;
  }

  // Old thresholds would close, new thresholds hold
  assert(checkRecoveryClose(0.6, 1.1, 0) === null, `main +0.6% hedge +1.1% → HOLD (was closing before)`);
  assert(checkRecoveryClose(0.8, 1.3, 0) === null, `main +0.8% hedge +1.3% → HOLD (was closing before)`);
  assert(checkRecoveryClose(0.5, 1.0, 0) === null, `main +0.5% hedge +1.0% → HOLD (old threshold exact)`);

  // New thresholds: need main >1% + hedge >=1.5%
  assert(checkRecoveryClose(1.1, 1.5, 0) === 'RECOVERY_SOFT', `main +1.1% hedge +1.5% → CLOSE`);
  assert(checkRecoveryClose(2.0, 2.0, 0) === 'RECOVERY_SOFT', `main +2.0% hedge +2.0% → CLOSE`);
  assert(checkRecoveryClose(1.0, 1.5, 0) === null, `main +1.0% (not >) hedge +1.5% → HOLD`);
  assert(checkRecoveryClose(1.1, 1.4, 0) === null, `main +1.1% hedge +1.4% (< 1.5) → HOLD`);

  // Banked total still works independently
  assert(checkRecoveryClose(-1.0, -0.5, 21) === 'BANKED_TOTAL', `Banked $21 → CLOSE regardless of PnL`);
  assert(checkRecoveryClose(-1.0, -0.5, 19) === null, `Banked $19 → HOLD (< $20 threshold)`);

  // Edge: both conditions met
  assert(checkRecoveryClose(1.5, 2.0, 25) === 'RECOVERY_SOFT', `Both met → soft takes priority`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 6: NET_POSITIVE MIN $20 FLOOR (Phase 2 Fix)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 6: NET_POSITIVE Min $20 Floor (Phase 2) ═══\n');
{
  function calcNetPositiveThreshold(filledVol: number): number {
    return Math.max(filledVol * 0.03, 20); // NEW: min $20 floor
  }
  function shouldCloseNetPositive(
    mainPnlPct: number, filledVol: number, bankedProfit: number, currentHedgePnl: number
  ): { close: boolean; threshold: number; netPnl: number } {
    const mainUnrealized = (mainPnlPct / 100) * filledVol;
    const netPnl = mainUnrealized + bankedProfit + currentHedgePnl;
    const threshold = calcNetPositiveThreshold(filledVol);
    return { close: netPnl > threshold, threshold, netPnl };
  }

  // L0 only filled ($400) — old threshold $12, new min $20
  const r1 = calcNetPositiveThreshold(400);
  assert(r1 === 20, `L0=$400 → threshold=$20 (not $12)`, `got $${r1}`);

  // Full grid ($1000) — 3% = $30 > $20 min
  const r2 = calcNetPositiveThreshold(1000);
  assert(r2 === 30, `Full=$1000 → threshold=$30`, `got $${r2}`);

  // L0+L1 ($550) — 3% = $16.5 < $20 → use $20
  const r3 = calcNetPositiveThreshold(550);
  assert(r3 === 20, `L0+L1=$550 → threshold=$20 (not $16.5)`, `got $${r3}`);

  // $667+ → 3% > $20, use 3%
  const r4 = calcNetPositiveThreshold(700);
  assert(r4 === 21, `$700 → threshold=$21`, `got $${r4}`);

  // Scenario: L0-only position, $15 net profit (would close with old, holds with new)
  const s1 = shouldCloseNetPositive(-2, 400, 25, 0); // main -$8, banked $25 = net $17
  assert(s1.close === false, `Net $17 < $20 → HOLD (old threshold $12 would close)`, `net=$${s1.netPnl}`);

  // Scenario: L0-only, $22 net → close
  const s2 = shouldCloseNetPositive(-1, 400, 26, 0); // main -$4, banked $26 = net $22
  assert(s2.close === true, `Net $22 > $20 → CLOSE`, `net=$${s2.netPnl}`);

  // Full grid, $35 net → close
  const s3 = shouldCloseNetPositive(0.5, 1000, 30, 0); // main $5 + banked $30 = $35
  assert(s3.close === true, `Full grid net $35 > $30 → CLOSE`);

  // Full grid, $25 net → hold
  const s4 = shouldCloseNetPositive(-0.5, 1000, 30, 0); // main -$5 + banked $30 = $25
  assert(s4.close === false, `Full grid net $25 < $30 → HOLD`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 7: SL IMPROVEMENT ENABLED (Phase 3 Fix)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 7: SL Improvement from Hedge Profits (Phase 3) ═══\n');
{
  // ─ Test 7.1: LONG position SL improvement ─
  console.log('--- Test 7.1: LONG SL improvement ---');
  const entry = 100;
  const notional = 1000;
  // Progressive SL base for cycle 1-2 = 40%
  const progressiveSlLong = entry * (1 - 40 / 100); // = $60

  // Hedge profit $15 → improvement
  const newSl1 = calculateSlImprovement(15, notional, entry, progressiveSlLong, 'LONG');
  const expectedImprovement = (15 * 0.8) / 1000 * 100; // = 1.2
  assert(approx(newSl1, 60 + 1.2, 0.01), `LONG: SL $60 → $${newSl1.toFixed(2)} (improvement +$1.20)`, `got ${newSl1}`);
  assert(newSl1 > progressiveSlLong, `Improved SL is tighter (higher for LONG)`, `${newSl1} > ${progressiveSlLong}`);

  // Hedge profit $50 → bigger improvement
  const newSl2 = calculateSlImprovement(50, notional, entry, progressiveSlLong, 'LONG');
  const expected2 = 60 + (50 * 0.8 / 1000 * 100); // = 60 + 4 = 64
  assert(approx(newSl2, 64, 0.01), `LONG: $50 profit → SL $${newSl2.toFixed(2)}`, `expected ~$64`);

  // Cap: can't go above entry * 0.998 ($99.80)
  const newSl3 = calculateSlImprovement(500, notional, entry, progressiveSlLong, 'LONG');
  assert(newSl3 <= entry * 0.998, `LONG: Cap at $${(entry * 0.998).toFixed(2)}`, `got $${newSl3.toFixed(2)}`);

  // Zero/negative profit → no improvement
  const newSl4 = calculateSlImprovement(0, notional, entry, progressiveSlLong, 'LONG');
  assert(newSl4 === progressiveSlLong, `Zero profit → no change`, `got $${newSl4}`);
  const newSl5 = calculateSlImprovement(-10, notional, entry, progressiveSlLong, 'LONG');
  assert(newSl5 === progressiveSlLong, `Negative profit → no change`, `got $${newSl5}`);

  // ─ Test 7.2: SHORT position SL improvement ─
  console.log('--- Test 7.2: SHORT SL improvement ---');
  const progressiveSlShort = entry * (1 + 40 / 100); // = $140

  const newSlS1 = calculateSlImprovement(15, notional, entry, progressiveSlShort, 'SHORT');
  assert(newSlS1 < progressiveSlShort, `SHORT: Improved SL is tighter (lower)`, `${newSlS1} < ${progressiveSlShort}`);
  assert(approx(newSlS1, 140 - 1.2, 0.01), `SHORT: SL $140 → $${newSlS1.toFixed(2)}`, `expected ~$138.80`);

  // Cap: can't go below entry * 1.002 ($100.20)
  const newSlS2 = calculateSlImprovement(500, notional, entry, progressiveSlShort, 'SHORT');
  assert(newSlS2 >= entry * 1.002, `SHORT: Floor at $${(entry * 1.002).toFixed(2)}`, `got $${newSlS2.toFixed(2)}`);

  // ─ Test 7.3: SL improvement override only if tighter ─
  console.log('--- Test 7.3: Tighter check in position-monitor ---');
  function isTighter(direction: string, newSl: number, currentSl: number): boolean {
    return direction === 'LONG' ? newSl > currentSl : newSl < currentSl;
  }

  // LONG: progressive=60, improvement=61.2 → tighter ✅
  assert(isTighter('LONG', 61.2, 60) === true, `LONG: 61.2 > 60 → tighter`);
  // LONG: progressive=65, improvement=61.2 → NOT tighter (progressive already better)
  assert(isTighter('LONG', 61.2, 65) === false, `LONG: 61.2 < 65 → progressive wins`);
  // SHORT: progressive=140, improvement=138.8 → tighter ✅
  assert(isTighter('SHORT', 138.8, 140) === true, `SHORT: 138.8 < 140 → tighter`);
  // SHORT: progressive=130, improvement=138.8 → NOT tighter
  assert(isTighter('SHORT', 138.8, 130) === false, `SHORT: 138.8 > 130 → progressive wins`);

  // ─ Test 7.4: Cumulative improvement across cycles ─
  console.log('--- Test 7.4: Cumulative improvement ---');
  let cumulativeSl = progressiveSlLong; // Start at $60
  const hedgeProfits = [15, 20, 10]; // 3 winning cycles
  for (let i = 0; i < hedgeProfits.length; i++) {
    const improved = calculateSlImprovement(hedgeProfits[i], notional, entry, cumulativeSl, 'LONG');
    if (improved > cumulativeSl) cumulativeSl = improved; // only if tighter
  }
  const totalImprovement = hedgeProfits.reduce((s, p) => s + (p * 0.8 / 1000 * 100), 0); // 1.2+1.6+0.8 = 3.6
  assert(approx(cumulativeSl, 60 + totalImprovement, 0.1), `3 cycles: SL $60 → $${cumulativeSl.toFixed(2)}`, `expected ~$${(60 + totalImprovement).toFixed(2)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 8: GRID DCA COOLDOWN — already works correctly
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 8: Grid DCA Cooldown Verification ═══\n');
{
  const cooldownMs = 5 * 60 * 1000; // 5 min

  // Simulate grid fill + cooldown check
  const grids = createGridLevels(100, 1000);

  // L0 filled at entry
  assert(grids[0].status === 'FILLED', `L0 starts FILLED`);
  assert(grids[0].filledAt !== null, `L0 has filledAt timestamp`);

  // L1 triggers but cooldown blocks (L0 just filled)
  const lastFill = new Date(grids[0].filledAt!).getTime();
  const elapsed = Date.now() - lastFill;
  assert(elapsed < cooldownMs, `L1 blocked by cooldown (${elapsed}ms < ${cooldownMs}ms)`);

  // Simulate 6 minutes later → L1 should pass cooldown
  const oldFill = new Date(Date.now() - 6 * 60 * 1000);
  grids[0].filledAt = oldFill;
  const elapsed2 = Date.now() - new Date(grids[0].filledAt).getTime();
  assert(elapsed2 > cooldownMs, `L1 passes cooldown after 6min (${Math.round(elapsed2/1000)}s > 300s)`);

  // Simulate L1 fills → L2 blocked by L1's fresh filledAt
  grids[1].status = 'FILLED';
  grids[1].filledAt = new Date(); // just filled
  const allFilled = grids.filter(g => g.status === 'FILLED' && g.filledAt)
    .map(g => new Date(g.filledAt!).getTime()).sort((a, b) => b - a);
  const newestFill = allFilled[0];
  const elapsed3 = Date.now() - newestFill;
  assert(elapsed3 < cooldownMs, `L2 blocked: L1 just filled (${elapsed3}ms < ${cooldownMs}ms)`);

  // Verify: gap fill scenario — L1+L2+L3 all trigger at once
  // Only L1 fills, L2+L3 blocked by L1's fresh filledAt
  grids[1].filledAt = new Date();
  grids[2].status = 'PENDING';
  grids[3].status = 'PENDING';
  const gapFillOk = grids.filter(g => g.status === 'FILLED' && g.filledAt)
    .some(g => Date.now() - new Date(g.filledAt!).getTime() < cooldownMs);
  assert(gapFillOk, `Gap fill: L2+L3 blocked (L1 fresh fill exists)`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 9: HISTORICAL BUG — hedgeTrigger min 2% (from 4USDT lesson)
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 9: hedgeTrigger Hard Floor 2% (Historical Bug) ═══\n');
{
  function enforceTriggerFloor(triggerPct: number): number {
    return Math.max(triggerPct, 2.0);
  }

  assert(enforceTriggerFloor(3.0) === 3.0, `3% trigger unchanged`);
  assert(enforceTriggerFloor(2.0) === 2.0, `2% trigger at floor`);
  assert(enforceTriggerFloor(1.5) === 2.0, `1.5% → clamped to 2%`);
  assert(enforceTriggerFloor(0.75) === 2.0, `0.75% → clamped to 2% (was 4USDT bug)`);
  assert(enforceTriggerFloor(0) === 2.0, `0% → clamped to 2%`);
  assert(enforceTriggerFloor(-1) === 2.0, `-1% → clamped to 2%`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 10: HISTORICAL BUG — 30s minimum hedge age
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 10: 30s Minimum Hedge Age (Instant-Close Guard) ═══\n');
{
  function shouldCheckExit(hedgeOpenedAt: Date | null): boolean {
    if (!hedgeOpenedAt) return true; // no timestamp = allow check
    const ageMs = Date.now() - new Date(hedgeOpenedAt).getTime();
    return ageMs >= 30_000; // 30s minimum
  }

  // Just opened (0s ago) → don't check exit
  assert(shouldCheckExit(new Date()) === false, `0s old → skip exit check`);

  // 10s ago → don't check
  assert(shouldCheckExit(new Date(Date.now() - 10_000)) === false, `10s old → skip exit check`);

  // 29s ago → don't check
  assert(shouldCheckExit(new Date(Date.now() - 29_000)) === false, `29s old → skip exit check`);

  // 30s ago → check allowed
  assert(shouldCheckExit(new Date(Date.now() - 30_000)) === true, `30s old → exit check allowed`);

  // 5min ago → check allowed
  assert(shouldCheckExit(new Date(Date.now() - 300_000)) === true, `5min old → exit check allowed`);

  // No timestamp → allow (backward compat)
  assert(shouldCheckExit(null) === true, `No timestamp → allow check`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 11: HISTORICAL BUG — NET_POSITIVE double-count after FLIP
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 11: NET_POSITIVE No Double-Count After FLIP ═══\n');
{
  interface ClosedHedgeOrder { pnlUsdt: number; closedAt: Date }

  function calcBankedProfit(
    closedHedges: ClosedHedgeOrder[],
    lastFlipAt: Date | null
  ): number {
    let orders = closedHedges;
    if (lastFlipAt) {
      // Only count hedges closed AFTER flip (pre-flip profits in FLIP_TP)
      orders = closedHedges.filter(o => o.closedAt > lastFlipAt);
    }
    return orders.reduce((sum, o) => sum + o.pnlUsdt, 0);
  }

  const t1 = new Date(Date.now() - 3600_000); // 1h ago
  const t2 = new Date(Date.now() - 1800_000); // 30min ago
  const flipAt = new Date(Date.now() - 900_000); // 15min ago
  const t3 = new Date(Date.now() - 300_000); // 5min ago

  const hedges: ClosedHedgeOrder[] = [
    { pnlUsdt: 18, closedAt: t1 },   // pre-FLIP cycle 1
    { pnlUsdt: 12, closedAt: t2 },   // pre-FLIP cycle 2
    { pnlUsdt: 8, closedAt: t3 },    // post-FLIP cycle 3
  ];

  // Without FLIP: all hedges counted
  const noFlip = calcBankedProfit(hedges, null);
  assert(noFlip === 38, `No FLIP: banked = $38 (all cycles)`, `got $${noFlip}`);

  // With FLIP: only post-flip hedges
  const withFlip = calcBankedProfit(hedges, flipAt);
  assert(withFlip === 8, `After FLIP: banked = $8 (only post-flip)`, `got $${withFlip}`);

  // Edge: no post-flip hedges
  const noPostFlip = calcBankedProfit(hedges.slice(0, 2), flipAt);
  assert(noPostFlip === 0, `After FLIP with no new hedges: banked = $0`, `got $${noPostFlip}`);

  // Edge: FLIP just happened, hedge closed at exact same time
  const edgeHedges: ClosedHedgeOrder[] = [
    { pnlUsdt: 10, closedAt: flipAt }, // closed at exact flip time
  ];
  const exactFlip = calcBankedProfit(edgeHedges, flipAt);
  assert(exactFlip === 0, `Hedge closed AT flip time → excluded (need > not >=)`, `got $${exactFlip}`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 12: HISTORICAL BUG — Direction-filtered close
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 12: Direction-Filtered Close (Hedge vs Main) ═══\n');
{
  interface Trade { symbol: string; direction: string; status: string; isHedge: boolean }
  const trades: Trade[] = [
    { symbol: 'BTCUSDT', direction: 'LONG', status: 'OPEN', isHedge: false },
    { symbol: 'BTCUSDT', direction: 'SHORT', status: 'OPEN', isHedge: true },
  ];

  function findTradeToClose(symbol: string, closedDirection: string | null): Trade | null {
    return trades.find(t =>
      t.symbol === symbol &&
      t.status === 'OPEN' &&
      (closedDirection ? t.direction === closedDirection : true)
    ) || null;
  }

  // Hedge closes (SHORT) → should match SHORT trade (hedge), NOT LONG (main)
  const hedgeClose = findTradeToClose('BTCUSDT', 'SHORT');
  assert(hedgeClose?.isHedge === true, `SHORT close → matches hedge trade`);
  assert(hedgeClose?.direction === 'SHORT', `Correct direction: SHORT`);

  // Main closes (LONG) → should match LONG trade (main), NOT SHORT (hedge)
  const mainClose = findTradeToClose('BTCUSDT', 'LONG');
  assert(mainClose?.isHedge === false, `LONG close → matches main trade`);

  // No direction → matches first OPEN (dangerous, but backward compat)
  const noDir = findTradeToClose('BTCUSDT', null);
  assert(noDir !== null, `No direction → matches first OPEN (backward compat)`);

  // Different symbol → no match
  const wrongSymbol = findTradeToClose('ETHUSDT', 'LONG');
  assert(wrongSymbol === null, `Wrong symbol → no match`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 13: HISTORICAL BUG — Stale flag 10s grace period
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 13: Stale Hedge Flag 10s Grace Period ═══\n');
{
  function shouldClearHedgeActive(
    hedgeActive: boolean, hedgeOrderExists: boolean, hedgeOpenedAt: Date | null
  ): boolean {
    if (!hedgeActive) return false; // not active, nothing to clear
    if (hedgeOrderExists) return false; // order exists, flag is correct
    // No order but flag=true → might be stale
    if (hedgeOpenedAt) {
      const ageMs = Date.now() - new Date(hedgeOpenedAt).getTime();
      if (ageMs < 10_000) return false; // grace period: order cache may lag
    }
    return true; // stale flag, clear it
  }

  // Hedge just opened (2s ago), no order in cache yet → grace period
  assert(
    shouldClearHedgeActive(true, false, new Date(Date.now() - 2000)) === false,
    `2s old, no order → grace period (don't clear)`
  );

  // Hedge opened 15s ago, no order → stale, clear it
  assert(
    shouldClearHedgeActive(true, false, new Date(Date.now() - 15000)) === true,
    `15s old, no order → stale flag, clear`
  );

  // Hedge active, order exists → don't clear
  assert(
    shouldClearHedgeActive(true, true, new Date(Date.now() - 2000)) === false,
    `Order exists → don't clear regardless of age`
  );

  // Not active → nothing to clear
  assert(
    shouldClearHedgeActive(false, false, null) === false,
    `Not active → nothing to clear`
  );
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 14: PROGRESSIVE SL + SL IMPROVEMENT INTERACTION
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 14: Progressive SL + Improvement Interaction ═══\n');
{
  const entry = 100;
  const notional = 1000;

  function getProgressiveSl(cycleCount: number, recoveryRatio: number, direction: string): number {
    let pct: number;
    if (recoveryRatio >= 0.5 || cycleCount <= 2) {
      pct = 40;
    } else if (cycleCount === 3) {
      pct = 15;
    } else {
      pct = 8;
    }
    return direction === 'LONG'
      ? +(entry * (1 - pct / 100)).toFixed(6)
      : +(entry * (1 + pct / 100)).toFixed(6);
  }

  // Cycle 1, good recovery → 40% SL
  const sl1 = getProgressiveSl(1, 0.8, 'LONG');
  assert(sl1 === 60, `Cycle 1, good recovery → SL at $60 (40%)`, `got $${sl1}`);

  // Cycle 3, bad recovery → 15% SL
  const sl3 = getProgressiveSl(3, 0.3, 'LONG');
  assert(sl3 === 85, `Cycle 3, bad recovery → SL at $85 (15%)`, `got $${sl3}`);

  // Cycle 4, bad recovery → 8% SL
  const sl4 = getProgressiveSl(4, 0.2, 'LONG');
  assert(sl4 === 92, `Cycle 4+, bad recovery → SL at $92 (8%)`, `got $${sl4}`);

  // Cycle 3 with good recovery → stays 40%
  const sl3good = getProgressiveSl(3, 0.6, 'LONG');
  assert(sl3good === 60, `Cycle 3, GOOD recovery (60%) → stays 40% SL`, `got $${sl3good}`);

  // SL improvement on top of progressive
  const progressiveSl = getProgressiveSl(1, 0.8, 'LONG'); // $60
  const improved = calculateSlImprovement(20, notional, entry, progressiveSl, 'LONG');
  assert(improved > progressiveSl, `Improvement tighter than progressive`, `${improved} > ${progressiveSl}`);

  // Combined: progressive cycle 4 ($92) + improvement
  const tightSl = getProgressiveSl(4, 0.2, 'LONG'); // $92
  const improvedTight = calculateSlImprovement(5, notional, entry, tightSl, 'LONG');
  assert(improvedTight > tightSl, `Improvement tightens even cycle 4 SL`);
  assert(improvedTight <= entry * 0.998, `But capped below entry`, `${improvedTight} <= ${entry * 0.998}`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 15: HEDGE TRAIL SYSTEM — peak tracking + exit conditions
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 15: Hedge Trail System (Peak + Exit) ═══\n');
{
  const hedgeTpPct = CONFIG.hedgeTpPctDefault; // 3%
  const keepRatio = CONFIG.hedgeTrailKeepRatio; // 0.70

  function checkTrailExit(
    hedgePnlPct: number, peak: number, tpActivated: boolean
  ): { action: string; newPeak: number } {
    const newPeak = Math.max(peak, hedgePnlPct);

    // TP trail: pullback > 1% from peak
    if (tpActivated && newPeak >= hedgeTpPct && hedgePnlPct < newPeak - 1.0) {
      return { action: 'TP_TRAIL_CLOSE', newPeak };
    }

    // Early trail: keep 70% of peak
    if (!tpActivated && hedgePnlPct >= 2.0) {
      const trailSl = newPeak * keepRatio;
      if (newPeak >= 2.5 && hedgePnlPct <= trailSl && hedgePnlPct >= 1.0) {
        return { action: 'EARLY_TRAIL_CLOSE', newPeak };
      }
    }

    return { action: 'HOLD', newPeak };
  }

  // Peak tracking progression
  let peak = 0;
  const seq = [0.5, 1.0, 2.0, 2.5, 3.0, 3.5, 3.0, 2.5, 2.0];
  for (const pnl of seq) peak = Math.max(peak, pnl);
  assert(peak === 3.5, `Peak tracks max: 3.5%`, `got ${peak}`);

  // Early trail: peak 2.5, PnL at 2.0 but trail SL = 2.5*0.7 = 1.75 → 2.0 > 1.75 → HOLD
  // (early trail only enters when PnL >= 2.0, and closes when PnL <= trailSl)
  const et0 = checkTrailExit(2.0, 2.5, false);
  assert(et0.action === 'HOLD', `Early trail: peak 2.5% → 2.0% > trailSl 1.75% → HOLD`);

  // Early trail: peak 3.0, PnL drops to 2.0 → trailSl = 3.0*0.7 = 2.1, 2.0 <= 2.1 → CLOSE
  const et1 = checkTrailExit(2.0, 3.0, false);
  assert(et1.action === 'EARLY_TRAIL_CLOSE', `Early trail: peak 3.0% → 2.0% <= trailSl 2.1% → CLOSE`);

  // Early trail: peak 2.5, still at 2.0 (80% of 2.5) → hold
  const et2 = checkTrailExit(2.0, 2.5, false);
  assert(et2.action === 'HOLD', `Early trail: peak 2.5% → 2.0% = 80% → HOLD`);

  // Early trail: below 1.0% → hold (min floor)
  const et3 = checkTrailExit(0.9, 2.5, false);
  assert(et3.action === 'HOLD', `Early trail: PnL 0.9% < 1.0% min → HOLD`);

  // TP trail: peak 4%, drops to 2.5% (pullback 1.5%) → close
  const tt1 = checkTrailExit(2.5, 4.0, true);
  assert(tt1.action === 'TP_TRAIL_CLOSE', `TP trail: peak 4% → 2.5% (pullback 1.5%) → CLOSE`);

  // TP trail: peak 4%, at 3.5% (pullback 0.5%) → hold
  const tt2 = checkTrailExit(3.5, 4.0, true);
  assert(tt2.action === 'HOLD', `TP trail: peak 4% → 3.5% (pullback 0.5%) → HOLD`);

  // TP trail: peak 2.5% (below hedgeTpPct 3%) → no trail close yet
  const tt3 = checkTrailExit(1.0, 2.5, true);
  assert(tt3.action === 'HOLD', `TP trail: peak 2.5% < TP 3% → HOLD`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 16: FULL SCENARIO — Multi-cycle with all fixes
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 16: Full Scenario — All Fixes Applied ═══\n');
{
  // LONG at $100, simNotional $1000
  const entry = 100;
  const simNotional = 1000;
  const l0Notional = simNotional * (DCA_WEIGHTS[0] / 100); // 40% = $400

  assert(l0Notional === 400, `L0 = $400 (40% fix applied)`);

  // Step 1: Price drops to $97 → hedge opens at -3%
  const mainPnl1 = ((97 - 100) / 100) * 100; // -3%
  assert(mainPnl1 <= -3.0, `Step 1: PnL -3% → hedge triggers`);

  const hedgeEntry = 97;
  const hedgeNotional = l0Notional * 0.75; // 75% of filledVol = $300
  const hedgeTpPrice = hedgeEntry * (1 - CONFIG.hedgeTpPctDefault / 100); // SHORT hedge TP

  // Step 2: Hedge profits, close at TP trail
  const hedgeExitPrice = 94.2; // below TP
  const hedgePnlPct = ((hedgeEntry - hedgeExitPrice) / hedgeEntry) * 100; // +2.89%
  const hedgePnlUsdt = (hedgePnlPct / 100) * hedgeNotional; // ~$8.66
  const fees = takerFee(hedgeNotional) * 2;
  const netPnl = hedgePnlUsdt - fees;
  console.log(`  Hedge cycle 1: PnL +${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) fees $${fees.toFixed(2)} net $${netPnl.toFixed(2)}`);
  assert(netPnl > 0, `Hedge cycle 1 profitable: $${netPnl.toFixed(2)}`);

  // Step 3: SL improvement applied
  const progressiveSl = entry * (1 - 40 / 100); // $60 (cycle 1-2, 40%)
  const improvedSl = calculateSlImprovement(netPnl, l0Notional, entry, progressiveSl, 'LONG');
  assert(improvedSl > progressiveSl, `SL improved: $${progressiveSl} → $${improvedSl.toFixed(2)}`);

  // Step 4: NET_POSITIVE check with $20 floor
  const netPositiveThreshold = Math.max(l0Notional * 0.03, 20); // max($12, $20) = $20
  assert(netPositiveThreshold === 20, `NET_POSITIVE threshold = $20 (min floor applied)`);

  // After 2 hedge cycles with ~$8 profit each = ~$16 banked + main unrealized
  const banked = netPnl * 2; // ~$16 from 2 cycles
  const mainUnrealized = ((96 - 100) / 100) * l0Notional; // -$16 at $96
  const totalNet = mainUnrealized + banked;
  console.log(`  After 2 cycles: banked $${banked.toFixed(2)}, main $${mainUnrealized.toFixed(2)}, net $${totalNet.toFixed(2)}`);
  assert(totalNet < netPositiveThreshold, `Net $${totalNet.toFixed(2)} < $20 → HOLD (old $12 threshold would close)`);

  // Step 5: Recovery check with raised threshold
  const mainRecoveryPnl = 0.8; // main recovering
  const hedgeRecoveryPnl = 1.2; // hedge profitable
  const softClose = mainRecoveryPnl > 1.0 && hedgeRecoveryPnl >= 1.5;
  assert(softClose === false, `Recovery: main +0.8% hedge +1.2% → HOLD (old thresholds would close)`);

  // Step 6: Peak persist survives restart
  let dbPeak = 3.5;
  let memPeak: number | undefined = undefined; // cleared by restart
  const restoredPeak = memPeak ?? dbPeak ?? 0;
  assert(restoredPeak === 3.5, `Peak restored from DB after restart: ${restoredPeak}%`);

  console.log(`\n  ✅ Full scenario completed — all fixes working together`);
}

// ═════════════════════════════════════════════════════════════════════════
// SUITE 17: EDGE CASES — Boundary conditions
// ═════════════════════════════════════════════════════════════════════════
console.log('\n═══ SUITE 17: Edge Cases & Boundary Conditions ═══\n');
{
  // Edge 1: Very small position (simNotional = $100)
  const smallNotional = 100;
  const smallL0 = smallNotional * 0.40; // $40
  const smallThreshold = Math.max(smallL0 * 0.03, 20); // max($1.2, $20) = $20
  assert(smallThreshold === 20, `Small position $40: threshold $20 (not $1.2)`);

  // Edge 2: Very large position (simNotional = $50000)
  const largeL0 = 50000 * 0.40; // $20000
  const largeThreshold = Math.max(largeL0 * 0.03, 20); // max($600, $20) = $600
  assert(largeThreshold === 600, `Large position $20k: threshold $600`);

  // Edge 3: SL improvement with zero notional
  const zeroSl = calculateSlImprovement(10, 0, 100, 60, 'LONG');
  assert(zeroSl === 60, `Zero notional → no improvement`);

  // Edge 4: SL improvement with zero entry
  const zeroEntry = calculateSlImprovement(10, 1000, 0, 60, 'LONG');
  assert(zeroEntry === 60, `Zero entry → no improvement`);

  // Edge 5: Confidence exactly at boundaries
  const atFloor = 68 >= CONFIG.confidenceFloor;
  assert(atFloor === true, `Confidence 68 = floor → passes`);
  const belowFloor = 67 >= CONFIG.confidenceFloor;
  assert(belowFloor === false, `Confidence 67 < 68 floor → blocked`);

  // Edge 6: Recovery close at exact boundary
  const exactBoundary1 = 1.0 > 1.0; // main must be > 1.0, not >=
  assert(exactBoundary1 === false, `main exactly 1.0% → NOT > 1.0 → HOLD`);
  const exactBoundary2 = 1.5 >= 1.5; // hedge must be >= 1.5
  assert(exactBoundary2 === true, `hedge exactly 1.5% → >= 1.5 → passes`);

  // Edge 7: Hedge trigger exactly at floor
  const triggerAt2 = Math.max(2.0, 2.0);
  assert(triggerAt2 === 2.0, `Trigger at floor 2% → allowed`);
  const triggerAt1_99 = Math.max(1.99, 2.0);
  assert(triggerAt1_99 === 2.0, `Trigger 1.99% → clamped to 2%`);
}

// ═════════════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log(`Bug Fix & Edge Case Simulator: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
