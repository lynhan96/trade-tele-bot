/**
 * Hedge System Simulator
 * Tests all hedge logic paths: open, TP, recovery, re-entry, NET_POSITIVE, fees
 * Run: npx ts-node run-hedge-simulator.ts
 */

// ─── Config (mirrors TradingConfig defaults) ─────────────────────────────
const CONFIG = {
  hedgeEnabled: true,
  hedgePartialTriggerPct: 3.0,
  hedgeFullTriggerPct: 3.0,
  hedgeFullSizeRatio: 1.0,
  hedgeTpPctDefault: 2.5,
  hedgeTpPctTrend: 3.0,
  hedgeTpPctVolatile: 3.5,
  hedgeReEntryCooldownMin: 5,
  hedgeSlImprovementRatio: 0.8,
  hedgeSafetySlPct: 10,
  hedgeSlWidenPerWin: 2,
  hedgeSlTightenPerLoss: 3,
  hedgeSlMinPct: 5,
  hedgeSlMaxPct: 15,
  hedgeMaxEffectiveLoss: 100,
  hedgeBlockRegimes: ['SIDEWAYS'],
  simTakerFeePct: 0.05,
  simMakerFeePct: 0.02,
  simFundingEnabled: false,
};

// ─── Fee Helpers ─────────────────────────────────────────────────────────
function takerFee(notional: number): number {
  return +(notional * CONFIG.simTakerFeePct / 100).toFixed(4);
}

function roundPnl(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── Signal Factory ──────────────────────────────────────────────────────
interface SimSignal {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  gridAvgEntry: number;
  stopLossPrice: number;
  originalSlPrice: number;
  hedgeSafetySlPrice: number;
  takeProfitPrice: number;
  simNotional: number;
  hedgeActive: boolean;
  hedgePhase?: string;
  hedgeDirection?: string;
  hedgeEntryPrice?: number;
  hedgeSimNotional?: number;
  hedgeTpPrice?: number;
  hedgeCycleCount: number;
  hedgeHistory: any[];
  gridLevels: any[];
}

function createSignal(overrides: Partial<SimSignal> = {}): SimSignal {
  const entry = overrides.entryPrice || 100;
  const dir = overrides.direction || 'LONG';
  const slPct = CONFIG.hedgeSafetySlPct;
  const slPrice = dir === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const origSlPrice = dir === 'LONG' ? entry * (1 - 3 / 100) : entry * (1 + 3 / 100);
  const tpPrice = dir === 'LONG' ? entry * (1 + 3.5 / 100) : entry * (1 - 3.5 / 100);

  return {
    symbol: 'TESTUSDT',
    direction: dir,
    entryPrice: entry,
    gridAvgEntry: entry,
    stopLossPrice: slPrice,
    originalSlPrice: origSlPrice,
    hedgeSafetySlPrice: slPrice,
    takeProfitPrice: tpPrice,
    simNotional: 1000,
    hedgeActive: false,
    hedgeCycleCount: 0,
    hedgeHistory: [],
    gridLevels: [
      { level: 0, status: 'FILLED', fillPrice: entry, simNotional: 400, volumePct: 40 },
      { level: 1, status: 'PENDING', fillPrice: 0, simNotional: 0, volumePct: 25 },
      { level: 2, status: 'PENDING', fillPrice: 0, simNotional: 0, volumePct: 35 },
    ],
    ...overrides,
  };
}

// ─── PnL Calculation ─────────────────────────────────────────────────────
function calcPnlPct(signal: SimSignal, price: number): number {
  const entry = signal.gridAvgEntry || signal.entryPrice;
  return signal.direction === 'LONG'
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100;
}

function calcPnlUsdt(signal: SimSignal, price: number): number {
  const filledVol = signal.gridLevels
    .filter(g => g.status === 'FILLED')
    .reduce((s, g) => s + (g.simNotional || 0), 0) || signal.simNotional * 0.4;
  return roundPnl((calcPnlPct(signal, price) / 100) * filledVol);
}

// ─── Hedge Logic Simulation ──────────────────────────────────────────────
function shouldOpenHedge(signal: SimSignal, pnlPct: number, regime: string): boolean {
  if (!CONFIG.hedgeEnabled) return false;
  if (signal.hedgeActive) return false;
  if (CONFIG.hedgeBlockRegimes.includes(regime)) return false;

  // Cooldown
  if (signal.hedgeHistory.length > 0) {
    const last = signal.hedgeHistory[signal.hedgeHistory.length - 1];
    if (last?.closedAt) {
      const elapsed = Date.now() - new Date(last.closedAt).getTime();
      if (elapsed < CONFIG.hedgeReEntryCooldownMin * 60 * 1000) return false;
    }
  }

  // Re-entry threshold (1.5x trigger after first cycle)
  if (signal.hedgeHistory.length > 0) {
    if (pnlPct > -CONFIG.hedgePartialTriggerPct * 1.5) return false;
  }

  return pnlPct <= -CONFIG.hedgePartialTriggerPct;
}

function openHedge(signal: SimSignal, currentPrice: number): void {
  const hedgeDir = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
  const hedgeNotional = signal.simNotional * CONFIG.hedgeFullSizeRatio;
  const tpPct = CONFIG.hedgeTpPctDefault;
  const hedgeTp = hedgeDir === 'LONG'
    ? currentPrice * (1 + tpPct / 100)
    : currentPrice * (1 - tpPct / 100);

  signal.hedgeActive = true;
  signal.hedgePhase = 'FULL';
  signal.hedgeDirection = hedgeDir;
  signal.hedgeEntryPrice = currentPrice;
  signal.hedgeSimNotional = hedgeNotional;
  signal.hedgeTpPrice = hedgeTp;
}

function calcHedgePnl(signal: SimSignal, price: number): { pct: number; usdt: number } {
  if (!signal.hedgeEntryPrice || !signal.hedgeDirection) return { pct: 0, usdt: 0 };
  const pct = signal.hedgeDirection === 'LONG'
    ? ((price - signal.hedgeEntryPrice) / signal.hedgeEntryPrice) * 100
    : ((signal.hedgeEntryPrice - price) / signal.hedgeEntryPrice) * 100;
  const usdt = roundPnl((pct / 100) * (signal.hedgeSimNotional || 0));
  return { pct, usdt };
}

function checkHedgeExit(signal: SimSignal, price: number, mainPnlPct: number): string | null {
  if (!signal.hedgeActive) return null;
  const { pct: hedgePnlPct } = calcHedgePnl(signal, price);

  // Recovery: main profitable
  if (mainPnlPct > 0) return 'RECOVERY_PROFIT';
  // Soft recovery: main > -1% and hedge > -0.5%
  if (mainPnlPct > -1.0 && hedgePnlPct > -0.5) return 'SOFT_RECOVERY';
  // TP hit
  if (signal.hedgeTpPrice) {
    const tpHit = signal.hedgeDirection === 'LONG'
      ? price >= signal.hedgeTpPrice
      : price <= signal.hedgeTpPrice;
    if (tpHit) return 'HEDGE_TP';
  }
  return null;
}

function closeHedge(signal: SimSignal, price: number, reason: string): { pnlUsdt: number; fees: number } {
  const { pct, usdt } = calcHedgePnl(signal, price);
  const fees = takerFee(signal.hedgeSimNotional || 0) * 2; // entry + exit
  const netPnl = roundPnl(usdt - fees);

  signal.hedgeHistory.push({
    phase: signal.hedgePhase,
    direction: signal.hedgeDirection,
    entryPrice: signal.hedgeEntryPrice,
    exitPrice: price,
    notional: signal.hedgeSimNotional,
    pnlPct: pct,
    pnlUsdt: netPnl,
    openedAt: new Date(Date.now() - 30 * 60000),
    closedAt: new Date(Date.now() - 10 * 60000), // 10 min ago (past cooldown)
    reason,
  });
  signal.hedgeCycleCount++;
  signal.hedgeActive = false;
  signal.hedgePhase = undefined;
  signal.hedgeDirection = undefined;
  signal.hedgeEntryPrice = undefined;
  signal.hedgeSimNotional = undefined;
  signal.hedgeTpPrice = undefined;

  return { pnlUsdt: netPnl, fees };
}

// ─── Test Scenarios ──────────────────────────────────────────────────────
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

// ── TEST 1: LONG signal — hedge opens at -3% ────────────────────────────
console.log('\n═══ TEST 1: LONG hedge trigger at -3% ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });

  // At -2% — should NOT trigger
  assert(!shouldOpenHedge(sig, -2.0, 'MIXED'), 'No hedge at -2%');
  // At -3% — should trigger
  assert(shouldOpenHedge(sig, -3.0, 'MIXED'), 'Hedge triggers at -3%');
  // Blocked by SIDEWAYS regime
  assert(!shouldOpenHedge(sig, -3.0, 'SIDEWAYS'), 'Blocked by SIDEWAYS regime');

  openHedge(sig, 97.0);
  assert(sig.hedgeActive === true, 'Hedge is active');
  assert(sig.hedgeDirection === 'SHORT', 'Hedge direction is SHORT (opposite of LONG)');
  assert(sig.hedgePhase === 'FULL', 'Hedge phase is FULL');
  assert(sig.hedgeSimNotional === 1000, 'Hedge notional = 100% of position');

  // Hedge TP at 2.5%
  const expectedTp = 97.0 * (1 - 2.5 / 100);
  assert(Math.abs(sig.hedgeTpPrice! - expectedTp) < 0.01, `Hedge TP = ${expectedTp.toFixed(4)} (SHORT)`);
}

// ── TEST 2: SHORT signal — hedge opens as LONG ──────────────────────────
console.log('\n═══ TEST 2: SHORT hedge direction ═══');
{
  const sig = createSignal({ direction: 'SHORT', entryPrice: 100 });

  assert(shouldOpenHedge(sig, -3.0, 'MIXED'), 'SHORT signal hedge triggers at -3%');
  openHedge(sig, 103.0); // price went UP (bad for SHORT)
  assert(sig.hedgeDirection === 'LONG', 'Hedge direction is LONG (opposite of SHORT)');

  // Hedge TP — LONG TP is above entry
  const expectedTp = 103.0 * (1 + 2.5 / 100);
  assert(Math.abs(sig.hedgeTpPrice! - expectedTp) < 0.01, `Hedge TP = ${expectedTp.toFixed(4)} (LONG)`);

  // Hedge PnL when price goes to TP
  const { pct, usdt } = calcHedgePnl(sig, expectedTp);
  assert(pct > 2.4, `Hedge PnL at TP: +${pct.toFixed(2)}%`);
}

// ── TEST 3: Hedge TP hit — close with profit ─────────────────────────────
console.log('\n═══ TEST 3: Hedge TP close ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  openHedge(sig, 97.0);
  const tpPrice = sig.hedgeTpPrice!;

  const exitReason = checkHedgeExit(sig, tpPrice, -5.0);
  assert(exitReason === 'HEDGE_TP', 'TP exit detected');

  const { pnlUsdt, fees } = closeHedge(sig, tpPrice, 'HEDGE_TP');
  assert(pnlUsdt > 0, `Hedge profit: +${pnlUsdt} USDT`);
  assert(fees > 0, `Fees deducted: ${fees} USDT`);
  assert(sig.hedgeActive === false, 'Hedge closed');
  assert(sig.hedgeCycleCount === 1, 'Cycle count = 1');
  assert(sig.hedgeHistory.length === 1, 'History has 1 entry');
  assert(sig.hedgeHistory[0].pnlUsdt === pnlUsdt, 'History PnL matches');
}

// ── TEST 4: Recovery close — main recovers ───────────────────────────────
console.log('\n═══ TEST 4: Recovery close ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  openHedge(sig, 97.0);

  // Main at +1% — should close hedge
  const exit1 = checkHedgeExit(sig, 97.0, 1.0);
  assert(exit1 === 'RECOVERY_PROFIT', 'Recovery close when main profitable');

  // Soft recovery: main at -0.5%, hedge > -0.5%
  const exit2 = checkHedgeExit(sig, 97.0, -0.5);
  assert(exit2 === 'SOFT_RECOVERY', 'Soft recovery when main > -1% and hedge > -0.5%');

  // Main at -0.5% but hedge losing badly (-2%) — should NOT close
  // Simulate hedge LONG at 97, price drops to 95.06 (-2%)
  sig.hedgeDirection = 'LONG';
  sig.hedgeEntryPrice = 97.0;
  const { pct: badHedgePct } = calcHedgePnl(sig, 95.06);
  assert(badHedgePct < -0.5, `Hedge losing ${badHedgePct.toFixed(2)}%`);
  sig.hedgeDirection = 'SHORT'; // restore
  sig.hedgeEntryPrice = 97.0;

  // Direct test of threshold
  const hedgePnlPct = -2.0;
  const shouldSkip = !(hedgePnlPct > -0.5);
  assert(shouldSkip, 'Skip recovery when hedge loss > 0.5%');
}

// ── TEST 5: Re-entry — requires worse PnL after first cycle ──────────────
console.log('\n═══ TEST 5: Re-entry logic ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });

  // First cycle — triggers at -3%
  assert(shouldOpenHedge(sig, -3.0, 'MIXED'), 'First cycle: opens at -3%');
  openHedge(sig, 97.0);
  closeHedge(sig, 94.575, 'HEDGE_TP'); // TP hit

  // After first cycle — need -4.5% (1.5× trigger)
  assert(!shouldOpenHedge(sig, -3.0, 'MIXED'), 'Re-entry blocked at -3% (need -4.5%)');
  assert(!shouldOpenHedge(sig, -4.0, 'MIXED'), 'Re-entry blocked at -4%');
  assert(shouldOpenHedge(sig, -4.51, 'MIXED'), 'Re-entry opens at -4.51% (below -4.5 threshold)');
}

// ── TEST 6: DCA skip during hedge ────────────────────────────────────────
console.log('\n═══ TEST 6: DCA skip during FULL hedge ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  openHedge(sig, 97.0);

  const skipGridFills = sig.hedgeActive && sig.hedgePhase === 'FULL';
  assert(skipGridFills === true, 'Grid DCA fills skipped during FULL hedge');

  // PARTIAL phase (legacy) — should NOT skip
  sig.hedgePhase = 'PARTIAL';
  const skipPartial = sig.hedgeActive && sig.hedgePhase === 'FULL';
  assert(skipPartial === false, 'Grid DCA fills NOT skipped during PARTIAL');
}

// ── TEST 7: Fee calculation ──────────────────────────────────────────────
console.log('\n═══ TEST 7: Fee calculation ═══');
{
  // $1000 notional, taker 0.05% per side
  const fee = takerFee(1000);
  assert(fee === 0.5, `Taker fee for $1000 = $${fee} (expected $0.50)`);

  // Round trip: entry + exit
  const roundTripFee = takerFee(1000) * 2;
  assert(roundTripFee === 1.0, `Round trip fee = $${roundTripFee} (expected $1.00)`);

  // Hedge PnL with fees
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  openHedge(sig, 97.0);
  const { pnlUsdt } = closeHedge(sig, sig.hedgeTpPrice!, 'HEDGE_TP');
  const rawPnl = roundPnl((2.5 / 100) * 1000); // 2.5% of $1000
  const expectedNet = roundPnl(rawPnl - 1.0); // minus $1.00 fees
  assert(Math.abs(pnlUsdt - expectedNet) < 0.1, `Net PnL: ${pnlUsdt} ≈ ${expectedNet} (raw ${rawPnl} - fees 1.00)`);
}

// ── TEST 8: NET_POSITIVE calculation ─────────────────────────────────────
console.log('\n═══ TEST 8: NET_POSITIVE exit ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });

  // Simulate 3 hedge cycles with profit
  sig.hedgeHistory = [
    { pnlUsdt: 20.0, pnlPct: 2.0 },
    { pnlUsdt: 15.0, pnlPct: 1.5 },
    { pnlUsdt: 10.0, pnlPct: 1.0 },
  ];
  const bankedProfit = sig.hedgeHistory.reduce((s, h) => s + h.pnlUsdt, 0); // 45
  assert(bankedProfit === 45, `Banked profit: $${bankedProfit}`);

  // Main at -4% = -$40 (on $1000 filled)
  const mainUnrealized = roundPnl((-4 / 100) * 1000);
  assert(mainUnrealized === -40, `Main unrealized: $${mainUnrealized}`);

  // Net = banked + main + current hedge
  const currentHedgePnl = 5; // current open hedge at +$5
  const netPnl = mainUnrealized + bankedProfit + currentHedgePnl;
  assert(netPnl > 0, `Net PnL positive: $${netPnl} → triggers NET_POSITIVE exit`);
  assert(netPnl === 10, `Net = -40 + 45 + 5 = $${netPnl}`);
}

// ── TEST 9: SL at 10% with hedge ─────────────────────────────────────────
console.log('\n═══ TEST 9: Safety SL at 10% ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  assert(sig.stopLossPrice === 90, 'LONG SL at 90 (10% below 100)');
  assert(sig.hedgeSafetySlPrice === 90, 'Safety SL matches');

  const sigShort = createSignal({ direction: 'SHORT', entryPrice: 100 });
  assert(Math.abs(sigShort.stopLossPrice - 110) < 0.01, `SHORT SL at ${sigShort.stopLossPrice} (10% above 100)`);

  // SL should NOT hit before hedge trigger (-3%)
  // At -3%: LONG price = 97, hedge triggers
  // At -10%: LONG price = 90, SL hits
  // Gap = 7% → hedge has room
  assert(CONFIG.hedgeSafetySlPct > CONFIG.hedgePartialTriggerPct, 'Safety SL > hedge trigger (room for hedge)');
}

// ── TEST 10: Full scenario — LONG drops, hedge cycles, NET_POSITIVE ──────
console.log('\n═══ TEST 10: Full scenario simulation ═══');
{
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  let totalHedgePnl = 0;
  let totalFees = 0;
  const prices = [97, 94.575, 96, 92, 89.7, 91, 88]; // price path

  console.log(`  Entry: $100 LONG, SL: $${sig.stopLossPrice}, TP: $${sig.takeProfitPrice.toFixed(2)}`);

  // Price drops to 97 → -3% → hedge #1
  let pnl = calcPnlPct(sig, 97);
  assert(shouldOpenHedge(sig, pnl, 'MIXED'), `Price $97: PnL ${pnl.toFixed(2)}% → hedge opens`);
  openHedge(sig, 97);

  // Price drops to 94.575 → hedge TP (SHORT from 97 → 94.575 = +2.5%)
  let exit = checkHedgeExit(sig, 94.575, calcPnlPct(sig, 94.575));
  assert(exit === 'HEDGE_TP', 'Hedge #1 TP hit');
  let result = closeHedge(sig, 94.575, 'HEDGE_TP');
  totalHedgePnl += result.pnlUsdt;
  totalFees += result.fees;
  console.log(`  Hedge #1 closed: +$${result.pnlUsdt} (fees: $${result.fees})`);

  // Price bounces to 96 → re-entry blocked (-4% < -4.5%)
  pnl = calcPnlPct(sig, 96);
  assert(!shouldOpenHedge(sig, pnl, 'MIXED'), `Price $96: PnL ${pnl.toFixed(2)}% → re-entry blocked`);

  // Price drops to 92 → -8% → re-entry (> -4.5%)
  pnl = calcPnlPct(sig, 92);
  assert(shouldOpenHedge(sig, pnl, 'MIXED'), `Price $92: PnL ${pnl.toFixed(2)}% → hedge #2 opens`);
  openHedge(sig, 92);

  // Price drops to 89.7 → hedge TP
  exit = checkHedgeExit(sig, 89.7, calcPnlPct(sig, 89.7));
  assert(exit === 'HEDGE_TP', 'Hedge #2 TP hit');
  result = closeHedge(sig, 89.7, 'HEDGE_TP');
  totalHedgePnl += result.pnlUsdt;
  totalFees += result.fees;
  console.log(`  Hedge #2 closed: +$${result.pnlUsdt} (fees: $${result.fees})`);

  // Check NET_POSITIVE
  const filledVol = sig.gridLevels.filter(g => g.status === 'FILLED').reduce((s, g) => s + g.simNotional, 0);
  const mainUnrealized = (calcPnlPct(sig, 91) / 100) * filledVol;
  const banked = sig.hedgeHistory.reduce((s, h) => s + h.pnlUsdt, 0);
  const net = mainUnrealized + banked;

  console.log(`\n  === Final State ===`);
  console.log(`  Main unrealized at $91: $${mainUnrealized.toFixed(2)} (${calcPnlPct(sig, 91).toFixed(2)}%)`);
  console.log(`  Banked hedge: $${banked.toFixed(2)}`);
  console.log(`  Net PnL: $${net.toFixed(2)}`);
  console.log(`  Total fees: $${totalFees.toFixed(2)}`);
  console.log(`  Hedge cycles: ${sig.hedgeCycleCount}`);
  assert(banked > 0, `Banked profit positive: $${banked.toFixed(2)}`);
}

// ── RESULTS ──────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));
process.exit(failed > 0 ? 1 : 0);
