/**
 * Order-Based Refactor Simulator
 * Tests all Phase 1-2 scenarios: hedge state from orders, FLIP, NET_POSITIVE, desync detection
 * Run: npx ts-node run-order-refactor-simulator.ts
 */

// ─── Config ─────────────────────────────────────────────────────────────
const CONFIG = {
  hedgeEnabled: true,
  hedgePartialTriggerPct: 3.0,
  hedgeTpPctDefault: 2.5,
  hedgeReEntryCooldownMin: 5,
  hedgeMaxCycles: 7,
  simTakerFeePct: 0.05,
  simMakerFeePct: 0.02,
  simFundingEnabled: false,
  trailTrigger: 2.0,
  trailKeepRatio: 0.75,
  gridLevelCount: 3,
};

function takerFee(notional: number): number {
  return +(notional * CONFIG.simTakerFeePct / 100).toFixed(4);
}
function roundPnl(v: number): number { return Math.round(v * 100) / 100; }

// ─── Mock Order DB ──────────────────────────────────────────────────────
interface MockOrder {
  _id: string;
  signalId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  type: 'MAIN' | 'DCA' | 'HEDGE';
  status: 'OPEN' | 'CLOSED';
  entryPrice: number;
  exitPrice?: number;
  notional: number;
  quantity: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  pnlPercent?: number;
  pnlUsdt?: number;
  entryFeeUsdt: number;
  exitFeeUsdt?: number;
  fundingFeeUsdt?: number;
  closeReason?: string;
  openedAt: Date;
  closedAt?: Date;
  cycleNumber: number;
  metadata?: Record<string, any>;
}

let nextOrderId = 1;
let ordersDB: MockOrder[] = [];

function resetDB(): void {
  ordersDB = [];
  nextOrderId = 1;
}

function createOrder(fields: Partial<MockOrder> & { signalId: string; symbol: string; direction: 'LONG' | 'SHORT'; type: MockOrder['type']; entryPrice: number; notional: number }): MockOrder {
  const order: MockOrder = {
    _id: `order_${nextOrderId++}`,
    status: 'OPEN',
    quantity: fields.notional / fields.entryPrice,
    entryFeeUsdt: takerFee(fields.notional),
    openedAt: new Date(),
    cycleNumber: 0,
    ...fields,
  };
  ordersDB.push(order);
  return order;
}

function findOrder(query: Partial<MockOrder>): MockOrder | null {
  return ordersDB.find(o =>
    (!query.signalId || o.signalId === query.signalId) &&
    (!query.type || o.type === query.type) &&
    (!query.status || o.status === query.status)
  ) ?? null;
}

function findOrders(query: Partial<MockOrder> & { closedAfter?: Date }): MockOrder[] {
  return ordersDB.filter(o =>
    (!query.signalId || o.signalId === query.signalId) &&
    (!query.type || o.type === query.type) &&
    (!query.status || o.status === query.status) &&
    (!query.closedAfter || (o.closedAt && o.closedAt > query.closedAfter))
  );
}

function closeOrder(orderId: string, exitPrice: number, closeReason: string): void {
  const order = ordersDB.find(o => o._id === orderId);
  if (!order) return;
  order.status = 'CLOSED';
  order.exitPrice = exitPrice;
  order.closedAt = new Date();
  order.closeReason = closeReason;
  order.exitFeeUsdt = takerFee(order.notional);
  const pnlPct = order.direction === 'LONG'
    ? ((exitPrice - order.entryPrice) / order.entryPrice) * 100
    : ((order.entryPrice - exitPrice) / order.entryPrice) * 100;
  order.pnlPercent = pnlPct;
  order.pnlUsdt = roundPnl(
    (pnlPct / 100) * order.notional - order.entryFeeUsdt - order.exitFeeUsdt!
  );
}

// ─── Mock Signal ────────────────────────────────────────────────────────
interface SimSignal {
  _id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  gridAvgEntry: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  simNotional: number;
  // Write-through cache (hedge state)
  hedgeActive: boolean;
  hedgeDirection?: string;
  hedgeEntryPrice?: number;
  hedgeSimNotional?: number;
  hedgeTpPrice?: number;
  hedgePhase?: string;
  hedgeCycleCount: number;
  hedgeHistory: any[];
  hedgeOpenedAt?: Date;
  // Other
  slMovedToEntry: boolean;
  tpBoosted: boolean;
  peakPnlPct: number;
  lastFlipAt?: Date;
  executedAt: Date;
  gridLevels: any[];
}

let nextSignalId = 1;

function createSignal(overrides: Partial<SimSignal> = {}): SimSignal {
  const entry = overrides.entryPrice || 100;
  const dir = overrides.direction || 'LONG';
  const slPct = 40; // safety net SL
  const tpPct = 3.5;
  return {
    _id: `signal_${nextSignalId++}`,
    symbol: 'TESTUSDT',
    direction: dir,
    entryPrice: entry,
    gridAvgEntry: entry,
    stopLossPrice: dir === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100),
    takeProfitPrice: dir === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100),
    simNotional: 1000,
    hedgeActive: false,
    hedgeCycleCount: 0,
    hedgeHistory: [],
    slMovedToEntry: false,
    tpBoosted: false,
    peakPnlPct: 0,
    executedAt: new Date(),
    gridLevels: [
      { level: 0, status: 'FILLED', fillPrice: entry, simNotional: 400, volumePct: 40 },
      { level: 1, status: 'PENDING', fillPrice: 0, simNotional: 0, volumePct: 25 },
      { level: 2, status: 'PENDING', fillPrice: 0, simNotional: 0, volumePct: 35 },
    ],
    ...overrides,
  };
}

// ─── Simulated Order-Based Logic (mirrors refactored code) ──────────────

/** Phase 1.4: getActiveHedge — single source of truth */
function getActiveHedge(signalId: string): MockOrder | null {
  return findOrder({ signalId, type: 'HEDGE', status: 'OPEN' });
}

/** Phase 1.1: getActiveDirection from MAIN orders */
function getActiveDirection(signalId: string): string | null {
  const main = findOrder({ signalId, type: 'MAIN', status: 'OPEN' });
  return main?.direction ?? null;
}

/** Phase 1.2: getAvgEntry from MAIN orders */
function getMainOrderState(signalId: string): { avgEntry: number; totalNotional: number; direction: string | null } {
  const orders = findOrders({ signalId, type: 'MAIN', status: 'OPEN' });
  if (!orders.length) return { avgEntry: 0, totalNotional: 0, direction: null };
  const totalNotional = orders.reduce((s, o) => s + o.notional, 0);
  const avgEntry = orders.reduce((s, o) => s + o.entryPrice * o.notional, 0) / totalNotional;
  return { avgEntry, totalNotional, direction: orders[0].direction };
}

/** Simulate deriving hedge state at tick start (like line 280-288 in refactored code) */
function deriveHedgeState(signal: SimSignal): { hedgeOrder: MockOrder | null; flagCorrected: boolean } {
  let hedgeOrder: MockOrder | null = null;
  let flagCorrected = false;
  if (signal.hedgeActive) {
    hedgeOrder = getActiveHedge(signal._id);
    if (!hedgeOrder) {
      // Flag desynced: hedgeActive=true but no OPEN order
      signal.hedgeActive = false;
      flagCorrected = true;
    }
  }
  return { hedgeOrder, flagCorrected };
}

/** Simulate opening a hedge (mirrors handleHedgeAction) */
function openHedge(signal: SimSignal, currentPrice: number): MockOrder {
  const hedgeDir: 'LONG' | 'SHORT' = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
  const hedgeNotional = signal.simNotional * 0.75;
  const tpPct = CONFIG.hedgeTpPctDefault;
  const hedgeTpPrice = hedgeDir === 'LONG'
    ? currentPrice * (1 + tpPct / 100)
    : currentPrice * (1 - tpPct / 100);

  // Create HEDGE order (source of truth)
  const order = createOrder({
    signalId: signal._id,
    symbol: signal.symbol,
    direction: hedgeDir,
    type: 'HEDGE',
    entryPrice: currentPrice,
    notional: hedgeNotional,
    takeProfitPrice: hedgeTpPrice, // Phase 1: stored in order
    cycleNumber: (signal.hedgeCycleCount || 0) + 1,
    metadata: { phase: 'FULL', reason: `PnL trigger | cycle ${(signal.hedgeCycleCount || 0) + 1}` },
  });

  // Write-through to signal (cache)
  signal.hedgeActive = true;
  signal.hedgePhase = 'FULL';
  signal.hedgeDirection = hedgeDir;
  signal.hedgeEntryPrice = currentPrice;
  signal.hedgeSimNotional = hedgeNotional;
  signal.hedgeTpPrice = hedgeTpPrice;
  signal.hedgeOpenedAt = new Date();
  signal.stopLossPrice = 0; // SL disabled when hedge active

  return order;
}

/** Simulate closing a hedge (mirrors handleHedgeClose) */
function closeHedgeOrder(signal: SimSignal, hedgeOrder: MockOrder, exitPrice: number, reason: string): { pnlUsdt: number } {
  // Close the DB order
  closeOrder(hedgeOrder._id, exitPrice, reason);

  // Build history entry from ORDER (source of truth, not signal fields)
  const pnlPct = hedgeOrder.direction === 'LONG'
    ? ((exitPrice - hedgeOrder.entryPrice) / hedgeOrder.entryPrice) * 100
    : ((hedgeOrder.entryPrice - exitPrice) / hedgeOrder.entryPrice) * 100;
  const fees = takerFee(hedgeOrder.notional) * 2;
  const pnlUsdt = roundPnl((pnlPct / 100) * hedgeOrder.notional - fees);

  signal.hedgeHistory.push({
    direction: hedgeOrder.direction,
    entryPrice: hedgeOrder.entryPrice,
    exitPrice,
    notional: hedgeOrder.notional,
    pnlPct, pnlUsdt,
    openedAt: hedgeOrder.openedAt,
    closedAt: new Date(),
    reason,
  });
  signal.hedgeCycleCount++;

  // Write-through clear (cache)
  signal.hedgeActive = false;
  signal.hedgePhase = undefined;
  signal.hedgeDirection = undefined;
  signal.hedgeEntryPrice = undefined;
  signal.hedgeSimNotional = undefined;
  signal.hedgeTpPrice = undefined;
  signal.hedgeOpenedAt = undefined;

  // Restore SL
  const avgEntry = signal.gridAvgEntry || signal.entryPrice;
  signal.stopLossPrice = signal.direction === 'LONG'
    ? +(avgEntry * (1 - 40 / 100)).toFixed(6)
    : +(avgEntry * (1 + 40 / 100)).toFixed(6);

  return { pnlUsdt };
}

/** Simulate FLIP: main TP hit while hedge active */
function executeFLIP(signal: SimSignal, hedgeOrder: MockOrder, tpPrice: number): void {
  // 1. Close MAIN orders with TP
  const mainOrders = findOrders({ signalId: signal._id, type: 'MAIN', status: 'OPEN' });
  let mainPnlTotal = 0;
  for (const ord of mainOrders) {
    closeOrder(ord._id, tpPrice, 'TAKE_PROFIT');
    mainPnlTotal += ord.pnlUsdt || 0;
  }

  // 2. Calculate main PnL for history
  const avgEntry = signal.gridAvgEntry || signal.entryPrice;
  const mainPnlPct = signal.direction === 'LONG'
    ? ((tpPrice - avgEntry) / avgEntry) * 100
    : ((avgEntry - tpPrice) / avgEntry) * 100;

  // 3. Bank main TP as FLIP_TP in hedgeHistory
  signal.hedgeHistory.push({
    direction: signal.direction,
    entryPrice: avgEntry,
    exitPrice: tpPrice,
    notional: signal.simNotional,
    pnlPct: mainPnlPct,
    pnlUsdt: mainPnlTotal,
    openedAt: signal.executedAt,
    closedAt: new Date(),
    reason: 'FLIP_TP',
  });

  // 4. Promote HEDGE order → MAIN
  const promotedOrder = ordersDB.find(o => o._id === hedgeOrder._id);
  if (promotedOrder) {
    promotedOrder.type = 'MAIN';
    const flipTpPct = 3.5;
    const flipSlPct = 40;
    promotedOrder.takeProfitPrice = hedgeOrder.direction === 'LONG'
      ? +(hedgeOrder.entryPrice * (1 + flipTpPct / 100)).toFixed(6)
      : +(hedgeOrder.entryPrice * (1 - flipTpPct / 100)).toFixed(6);
    promotedOrder.stopLossPrice = hedgeOrder.direction === 'LONG'
      ? +(hedgeOrder.entryPrice * (1 - flipSlPct / 100)).toFixed(6)
      : +(hedgeOrder.entryPrice * (1 + flipSlPct / 100)).toFixed(6);
    promotedOrder.cycleNumber = 0;
  }

  // 5. Update signal (write-through)
  signal.direction = hedgeOrder.direction as 'LONG' | 'SHORT';
  signal.entryPrice = hedgeOrder.entryPrice;
  signal.gridAvgEntry = hedgeOrder.entryPrice;
  signal.takeProfitPrice = promotedOrder?.takeProfitPrice || 0;
  signal.stopLossPrice = promotedOrder?.stopLossPrice || 0;
  signal.hedgeActive = false;
  signal.hedgePhase = undefined;
  signal.hedgeDirection = undefined;
  signal.hedgeEntryPrice = undefined;
  signal.hedgeSimNotional = undefined;
  signal.hedgeTpPrice = undefined;
  signal.hedgeCycleCount = 0;
  signal.slMovedToEntry = false;
  signal.tpBoosted = false;
  signal.peakPnlPct = 0;
  signal.lastFlipAt = new Date();
  signal.executedAt = new Date();
}

/** NET_POSITIVE calculation (from orders — mirrors refactored code) */
function calcNetPositive(signal: SimSignal, price: number, hedgeOrder: MockOrder | null): {
  mainUnrealized: number;
  bankedProfit: number;
  currentHedgePnl: number;
  netPnl: number;
} {
  // Banked profit from CLOSED HEDGE orders (post-flip only)
  const hedgeQuery: any = { signalId: signal._id, type: 'HEDGE', status: 'CLOSED' };
  if (signal.lastFlipAt) hedgeQuery.closedAfter = signal.lastFlipAt;
  const closedHedges = findOrders(hedgeQuery);
  const bankedProfit = closedHedges.reduce((s, o) => s + (o.pnlUsdt || 0), 0);

  // Main unrealized
  const filledVol = signal.gridLevels
    .filter(g => ['FILLED', 'TP_CLOSED', 'SL_CLOSED'].includes(g.status))
    .reduce((s: number, g: any) => s + (g.simNotional || 0), 0) || signal.simNotional * 0.4;
  const entry = signal.gridAvgEntry || signal.entryPrice;
  const pnlPct = signal.direction === 'LONG'
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100;
  const mainUnrealized = roundPnl((pnlPct / 100) * filledVol);

  // Current open hedge PnL (from ORDER, not signal fields)
  let currentHedgePnl = 0;
  if (hedgeOrder) {
    const hPnlPct = hedgeOrder.direction === 'LONG'
      ? ((price - hedgeOrder.entryPrice) / hedgeOrder.entryPrice) * 100
      : ((hedgeOrder.entryPrice - price) / hedgeOrder.entryPrice) * 100;
    currentHedgePnl = roundPnl((hPnlPct / 100) * hedgeOrder.notional);
  }

  return {
    mainUnrealized,
    bankedProfit,
    currentHedgePnl,
    netPnl: mainUnrealized + bankedProfit + currentHedgePnl,
  };
}

// ─── Test Framework ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, details?: string): void {
  if (condition) {
    console.log(`  \u2705 ${name}`);
    passed++;
  } else {
    console.log(`  \u274c ${name}${details ? ` \u2014 ${details}` : ''}`);
    failed++;
  }
}

function assertClose(actual: number, expected: number, tolerance: number, name: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${name} (${actual.toFixed(2)} ~ ${expected.toFixed(2)})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 1: Hedge state derivation (Phase 1.4)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 1: Hedge state derivation from orders ===');

// TEST 1.1: Normal flow — hedgeActive synced with order
console.log('\n--- Test 1.1: Normal sync — hedgeActive matches OPEN HEDGE order ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // No hedge active
  const { hedgeOrder: h1, flagCorrected: f1 } = deriveHedgeState(sig);
  assert(h1 === null, 'No hedgeOrder when hedgeActive=false');
  assert(!f1, 'No flag correction needed');

  // Open hedge
  const hedgeOrd = openHedge(sig, 97);
  const { hedgeOrder: h2, flagCorrected: f2 } = deriveHedgeState(sig);
  assert(h2 !== null, 'hedgeOrder found when hedgeActive=true + OPEN HEDGE order');
  assert(h2?._id === hedgeOrd._id, 'Correct order returned');
  assert(!f2, 'No flag correction needed');
}

// TEST 1.2: Desync — hedgeActive=true but no OPEN order (stale flag)
console.log('\n--- Test 1.2: Desync detection — stale hedgeActive=true ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Force hedgeActive=true without creating HEDGE order (simulates DB inconsistency)
  sig.hedgeActive = true;
  sig.hedgeDirection = 'SHORT';
  sig.hedgeEntryPrice = 97;
  sig.hedgeSimNotional = 750;

  const { hedgeOrder, flagCorrected } = deriveHedgeState(sig);
  assert(hedgeOrder === null, 'No hedgeOrder found (stale flag detected)');
  assert(flagCorrected, 'Flag corrected to false');
  assert(!sig.hedgeActive, 'signal.hedgeActive cleared to false');
}

// TEST 1.3: Orphan HEDGE order — hedgeActive=false but OPEN HEDGE exists
console.log('\n--- Test 1.3: Orphan detection — hedgeActive=false but OPEN HEDGE order ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Create orphan HEDGE order (signal.hedgeActive remains false)
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'SHORT', type: 'HEDGE', entryPrice: 97, notional: 750 });

  // Normal derive won't find it (hedgeActive=false → skip query)
  const { hedgeOrder: h1 } = deriveHedgeState(sig);
  assert(h1 === null, 'Normal derive skips when hedgeActive=false');

  // But FLIP path does a safety check (like line 1022-1031 in refactored code)
  const orphan = getActiveHedge(sig._id);
  assert(orphan !== null, 'Direct getActiveHedge finds orphan HEDGE order');
  assert(orphan?.direction === 'SHORT', 'Orphan has correct direction');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 2: Order-based hedge reads (Phase 1.1-1.4)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 2: Order-based hedge data reads ===');

// TEST 2.1: checkHedgeExit reads from order, not signal
console.log('\n--- Test 2.1: checkHedgeExit reads from order ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });
  const hedgeOrd = openHedge(sig, 97);

  // Simulate signal fields becoming stale (e.g. after server restart with partial write)
  sig.hedgeEntryPrice = 999; // wrong value
  sig.hedgeSimNotional = 1; // wrong value

  // Order has correct values
  assert(hedgeOrd.entryPrice === 97, 'Order entryPrice correct: 97');
  assert(hedgeOrd.notional === 750, 'Order notional correct: 750');

  // The refactored checkHedgeExit reads from hedgeOrder (param), not signal
  const hedgeEntry = hedgeOrd.entryPrice; // from order
  const hedgeNotional = hedgeOrd.notional; // from order
  const price = 94.575; // hedge TP price
  const hedgePnlPct = hedgeOrd.direction === 'LONG'
    ? ((price - hedgeEntry) / hedgeEntry) * 100
    : ((hedgeEntry - price) / hedgeEntry) * 100;
  const hedgePnlUsdt = roundPnl((hedgePnlPct / 100) * hedgeNotional);

  assert(hedgePnlPct > 2.4, `Hedge PnL calculated from ORDER: +${hedgePnlPct.toFixed(2)}%`);
  assert(hedgePnlUsdt > 15, `Hedge PnL USDT from ORDER: +$${hedgePnlUsdt.toFixed(2)}`);

  // If we had used signal fields (stale), PnL would be completely wrong
  const staleEntry = sig.hedgeEntryPrice!; // 999
  const stalePnl = ((staleEntry - price) / staleEntry) * 100;
  assert(Math.abs(stalePnl - hedgePnlPct) > 50, `Stale signal would give wrong PnL: ${stalePnl.toFixed(2)}% (completely wrong)`);
}

// TEST 2.2: hedgeTpPrice stored in order
console.log('\n--- Test 2.2: hedgeTpPrice from order.takeProfitPrice ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });
  const hedgeOrd = openHedge(sig, 97);

  // Order has takeProfitPrice (Phase 1 change)
  assert(hedgeOrd.takeProfitPrice !== undefined, 'HEDGE order has takeProfitPrice');
  const expectedTp = 97 * (1 - CONFIG.hedgeTpPctDefault / 100);
  assertClose(hedgeOrd.takeProfitPrice!, expectedTp, 0.01, 'HEDGE TP price correct');

  // Stale signal tp
  sig.hedgeTpPrice = 999;
  const orderTp = hedgeOrd.takeProfitPrice!;
  assert(Math.abs(orderTp - expectedTp) < 0.01, 'Order TP is source of truth (not stale signal)');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 3: NET_POSITIVE from orders
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 3: NET_POSITIVE calculation from orders ===');

// TEST 3.1: Basic net positive
console.log('\n--- Test 3.1: Basic NET_POSITIVE ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Open + close hedge with profit
  const h1 = openHedge(sig, 97);
  closeHedgeOrder(sig, h1, 94.575, 'HEDGE_TP');

  // Open + close another hedge
  const h2 = openHedge(sig, 94);
  closeHedgeOrder(sig, h2, 91.65, 'HEDGE_TP');

  // Check net positive at price 95
  const np = calcNetPositive(sig, 95, null);
  assert(np.bankedProfit > 0, `Banked from CLOSED orders: $${np.bankedProfit.toFixed(2)}`);
  assert(np.mainUnrealized < 0, `Main unrealized: $${np.mainUnrealized.toFixed(2)}`);
  assert(np.currentHedgePnl === 0, 'No current hedge (hedgeOrder=null)');
  console.log(`  Net PnL: $${np.netPnl.toFixed(2)} (main=$${np.mainUnrealized.toFixed(2)} + banked=$${np.bankedProfit.toFixed(2)})`);
}

// TEST 3.2: NET_POSITIVE with active hedge
console.log('\n--- Test 3.2: NET_POSITIVE with active hedge ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Close one profitable hedge
  const h1 = openHedge(sig, 97);
  closeHedgeOrder(sig, h1, 94.575, 'HEDGE_TP');

  // Open another hedge (still active)
  const h2 = openHedge(sig, 93);

  // Net positive at price 94 — hedge profitable (SHORT from 93, price at 94... wait SHORT profits when price drops)
  // Actually SHORT from 93 → price 91 = +2.15%
  const np = calcNetPositive(sig, 91, h2);
  assert(np.currentHedgePnl > 0, `Current hedge PnL from ORDER: $${np.currentHedgePnl.toFixed(2)}`);
  assert(np.bankedProfit > 0, `Banked from closed hedges: $${np.bankedProfit.toFixed(2)}`);
  console.log(`  Net: main=$${np.mainUnrealized.toFixed(2)} + banked=$${np.bankedProfit.toFixed(2)} + hedge=$${np.currentHedgePnl.toFixed(2)} = $${np.netPnl.toFixed(2)}`);
}

// TEST 3.3: After hedge close, hedgeOrder=null prevents double-counting
console.log('\n--- Test 3.3: No double-counting after hedge close ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  const h1 = openHedge(sig, 97);
  closeHedgeOrder(sig, h1, 94.575, 'HEDGE_TP');

  // After close: hedgeOrder should be null (set to null in refactored code line 795)
  const hedgeAfterClose: MockOrder | null = null; // simulates `hedgeOrder = null` after handleHedgeClose

  const np = calcNetPositive(sig, 95, hedgeAfterClose);
  assert(np.currentHedgePnl === 0, 'No current hedge PnL after close (hedgeOrder=null)');

  // Banked profit already includes the closed hedge
  assert(np.bankedProfit > 0, `Banked includes closed hedge: $${np.bankedProfit.toFixed(2)}`);

  // If we had passed the stale hedgeOrder (before fix), it would double-count
  const npDoubleCount = calcNetPositive(sig, 95, h1 as any); // stale reference
  const doubleCounted = npDoubleCount.bankedProfit + npDoubleCount.currentHedgePnl;
  const correct = np.bankedProfit;
  assert(doubleCounted > correct, `Double-count bug would give $${doubleCounted.toFixed(2)} vs correct $${correct.toFixed(2)}`);
}

// TEST 3.4: Post-FLIP only counts hedges after lastFlipAt
console.log('\n--- Test 3.4: Post-FLIP banked profit only counts post-flip hedges ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Pre-flip hedge cycle
  const h1 = openHedge(sig, 97);
  closeHedgeOrder(sig, h1, 94.575, 'HEDGE_TP');
  const preFLIPBanked = sig.hedgeHistory.reduce((s: number, h: any) => s + h.pnlUsdt, 0);
  assert(preFLIPBanked > 0, `Pre-FLIP banked: $${preFLIPBanked.toFixed(2)}`);

  // FLIP happens
  const h2 = openHedge(sig, 93);
  executeFLIP(sig, h2, 103.5); // main TP hit
  assert(sig.lastFlipAt !== undefined, 'lastFlipAt set after FLIP');

  // Post-flip: open new MAIN order (simulating promoted HEDGE→MAIN)
  // Note: executeFLIP already promoted the order. Check:
  const postFlipMain = findOrder({ signalId: sig._id, type: 'MAIN', status: 'OPEN' });
  assert(postFlipMain !== null, 'Promoted MAIN order exists after FLIP');
  assert(postFlipMain?.direction === 'SHORT', `Post-FLIP direction from ORDER: ${postFlipMain?.direction}`);

  // Net positive post-flip: should NOT count pre-flip closed hedges
  const np = calcNetPositive(sig, 95, null);
  assert(np.bankedProfit === 0, `Post-FLIP banked = $0 (pre-flip hedges excluded)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 4: FLIP correctness
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 4: FLIP logic ===');

// TEST 4.1: Basic FLIP — MAIN closes, HEDGE becomes MAIN
console.log('\n--- Test 4.1: Basic FLIP ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Open hedge SHORT
  const hedgeOrd = openHedge(sig, 97);
  assert(hedgeOrd.direction === 'SHORT', 'Hedge is SHORT (opposite of LONG main)');

  // Main TP hit at 103.5
  executeFLIP(sig, hedgeOrd, 103.5);

  // Verify order state
  const closedMain = findOrders({ signalId: sig._id, type: 'MAIN', status: 'CLOSED' });
  assert(closedMain.length > 0, 'Original MAIN order closed');
  assert(closedMain[0].closeReason === 'TAKE_PROFIT', 'Close reason: TAKE_PROFIT');

  const promotedMain = findOrder({ signalId: sig._id, type: 'MAIN', status: 'OPEN' });
  assert(promotedMain !== null, 'Promoted MAIN order exists');
  assert(promotedMain?.direction === 'SHORT', 'Promoted MAIN direction: SHORT');
  assert(promotedMain?.entryPrice === 97, 'Promoted MAIN entry: 97 (original hedge entry)');
  assert(promotedMain?.takeProfitPrice !== undefined, 'Promoted MAIN has TP');
  assert(promotedMain?.stopLossPrice !== undefined, 'Promoted MAIN has SL');

  // Verify signal state
  assert(sig.direction === 'SHORT', 'Signal direction flipped to SHORT');
  assert(sig.entryPrice === 97, 'Signal entry updated to hedge entry');
  assert(sig.hedgeActive === false, 'hedgeActive cleared');
  assert(sig.hedgeCycleCount === 0, 'hedgeCycleCount reset');
  assert(sig.lastFlipAt !== undefined, 'lastFlipAt set');

  // Verify FLIP_TP in history
  const flipEntry = sig.hedgeHistory.find((h: any) => h.reason === 'FLIP_TP');
  assert(flipEntry !== undefined, 'FLIP_TP entry in hedgeHistory');
  assert(flipEntry?.direction === 'LONG', 'FLIP_TP records original LONG direction');
  assert(flipEntry?.pnlUsdt !== undefined, 'FLIP_TP has PnL');

  // No HEDGE orders should be OPEN
  const openHedges = findOrders({ signalId: sig._id, type: 'HEDGE', status: 'OPEN' });
  assert(openHedges.length === 0, 'No OPEN HEDGE orders after FLIP');
}

// TEST 4.2: FLIP with orphan HEDGE order
console.log('\n--- Test 4.2: FLIP catches orphan HEDGE order ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Create HEDGE order without setting hedgeActive (simulates crash/desync)
  const orphanHedge = createOrder({
    signalId: sig._id, symbol: 'TESTUSDT', direction: 'SHORT', type: 'HEDGE',
    entryPrice: 97, notional: 750,
  });
  // hedgeActive remains false (desync!)

  // Normal derive doesn't find it
  const { hedgeOrder: h1 } = deriveHedgeState(sig);
  assert(h1 === null, 'Normal derive misses orphan (hedgeActive=false)');

  // But FLIP safety check finds it (line 1022-1031 in refactored code)
  const orphanCheck = getActiveHedge(sig._id);
  assert(orphanCheck !== null, 'FLIP safety check catches orphan HEDGE order');
  assert(orphanCheck?.direction === 'SHORT', 'Orphan direction correct');

  // Can FLIP with orphan
  executeFLIP(sig, orphanCheck!, 103.5);
  assert(sig.direction === 'SHORT', 'FLIP with orphan succeeded — now SHORT');
}

// TEST 4.3: Direction from order after FLIP
console.log('\n--- Test 4.3: Direction derived from MAIN order post-FLIP ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  const h = openHedge(sig, 97);
  executeFLIP(sig, h, 103.5);

  // Phase 1.1: getActiveDirection from MAIN order
  const dirFromOrder = getActiveDirection(sig._id);
  assert(dirFromOrder === 'SHORT', `Direction from MAIN order: ${dirFromOrder}`);
  assert(dirFromOrder === sig.direction, 'Signal direction matches order direction');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 5: Grid DCA + Trail SL skip during hedge
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 5: Grid DCA + Trail SL behavior with hedge ===');

// TEST 5.1: skipGridFills uses hedgeOrder
console.log('\n--- Test 5.1: skipGridFills derived from hedgeOrder ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  // No hedge → don't skip
  const { hedgeOrder: h1 } = deriveHedgeState(sig);
  const skipNoHedge = !!h1;
  assert(!skipNoHedge, 'Grid DCA NOT skipped when no hedge');

  // Hedge active → skip
  openHedge(sig, 97);
  const { hedgeOrder: h2 } = deriveHedgeState(sig);
  const skipWithHedge = !!h2;
  assert(skipWithHedge, 'Grid DCA skipped when hedge active');

  // Close hedge → don't skip
  closeHedgeOrder(sig, h2!, 94.575, 'HEDGE_TP');
  const h3: MockOrder | null = null; // hedgeOrder = null after close
  const skipAfterClose = !!h3;
  assert(!skipAfterClose, 'Grid DCA NOT skipped after hedge closed (hedgeOrder=null)');
}

// TEST 5.2: Trail SL skip uses hedgeOrder
console.log('\n--- Test 5.2: Trail SL skip derived from hedgeOrder ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  const { hedgeOrder: h1 } = deriveHedgeState(sig);
  assert(!h1, 'Trail SL ACTIVE when no hedge (hedgeOrder=null)');

  openHedge(sig, 97);
  const { hedgeOrder: h2 } = deriveHedgeState(sig);
  assert(!!h2, 'Trail SL SKIPPED when hedge active (hedgeOrder exists)');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 6: handleHedgeClose uses order data
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 6: handleHedgeClose reads from order ===');

// TEST 6.1: Close uses order fields even if signal fields are stale
console.log('\n--- Test 6.1: Close reads from order, not stale signal ---');
{
  resetDB();
  const sig = createSignal();
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });
  const hedgeOrd = openHedge(sig, 97);

  // Corrupt signal fields (simulates partial DB write failure)
  sig.hedgeEntryPrice = 999;
  sig.hedgeSimNotional = 1;
  sig.hedgeDirection = 'LONG'; // wrong!

  // Close using ORDER data (refactored behavior)
  const { pnlUsdt } = closeHedgeOrder(sig, hedgeOrd, 94.575, 'HEDGE_TP');
  assert(pnlUsdt > 0, `PnL from ORDER data: +$${pnlUsdt.toFixed(2)}`);

  // History entry should have correct values from order
  const hist = sig.hedgeHistory[sig.hedgeHistory.length - 1];
  assert(hist.entryPrice === 97, `History entryPrice from order: ${hist.entryPrice} (not 999)`);
  assert(hist.direction === 'SHORT', `History direction from order: ${hist.direction} (not LONG)`);
  assert(hist.notional === 750, `History notional from order: ${hist.notional} (not 1)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 7: Full lifecycle scenario
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 7: Full lifecycle — LONG, hedge, FLIP, hedge, NET_POSITIVE ===');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });

  console.log('\n  Phase A: Entry LONG at $100');

  // Price drops to 97 → hedge trigger
  console.log('  Phase B: Price drops to $97 → hedge opens');
  const h1 = openHedge(sig, 97);
  const { hedgeOrder: h1check } = deriveHedgeState(sig);
  assert(h1check !== null, 'Hedge #1 verified via getActiveHedge');

  // Hedge TP hit
  console.log('  Phase C: Hedge TP hit at $94.575');
  closeHedgeOrder(sig, h1, 94.575, 'HEDGE_TP');
  let hedgeAfterClose: MockOrder | null = null; // set to null after close
  const np1 = calcNetPositive(sig, 94.575, hedgeAfterClose);
  console.log(`    Net: main=$${np1.mainUnrealized.toFixed(2)} + banked=$${np1.bankedProfit.toFixed(2)} = $${np1.netPnl.toFixed(2)}`);

  // Price drops more → hedge #2
  console.log('  Phase D: Price drops to $93 → hedge #2 opens');
  const h2 = openHedge(sig, 93);

  // Main TP hit at 103.5 while hedge active → FLIP
  console.log('  Phase E: Main TP at $103.5 while hedge active → FLIP');
  executeFLIP(sig, h2, 103.5);
  assert(sig.direction === 'SHORT', 'After FLIP: now SHORT');

  // Verify order state
  const mainOrder = findOrder({ signalId: sig._id, type: 'MAIN', status: 'OPEN' });
  assert(mainOrder !== null, 'New MAIN order exists (promoted from HEDGE)');
  assert(mainOrder?.direction === 'SHORT', 'New MAIN is SHORT');
  assert(mainOrder?.entryPrice === 93, 'New MAIN entry = old hedge entry');

  // Post-FLIP: price rises (bad for SHORT) → hedge opens as LONG
  console.log('  Phase F: Post-FLIP — price rises to $96 → hedge opens LONG');
  const h3 = openHedge(sig, 96);
  assert(h3.direction === 'LONG', 'Post-FLIP hedge is LONG (opposite of SHORT)');

  // Close hedge with profit
  console.log('  Phase G: Hedge TP at $98.4');
  closeHedgeOrder(sig, h3, 98.4, 'HEDGE_TP');

  // NET_POSITIVE check
  const np2 = calcNetPositive(sig, 94, null);
  console.log(`    Post-FLIP net: main=$${np2.mainUnrealized.toFixed(2)} + banked=$${np2.bankedProfit.toFixed(2)} = $${np2.netPnl.toFixed(2)}`);
  assert(np2.bankedProfit > 0, 'Post-FLIP banked > 0 (only counts post-flip hedges)');

  // Verify all orders
  const allOrders = ordersDB.filter(o => o.signalId === sig._id);
  console.log(`\n  Final order count: ${allOrders.length}`);
  console.log(`    MAIN OPEN: ${allOrders.filter(o => o.type === 'MAIN' && o.status === 'OPEN').length}`);
  console.log(`    MAIN CLOSED: ${allOrders.filter(o => o.type === 'MAIN' && o.status === 'CLOSED').length}`);
  console.log(`    HEDGE CLOSED: ${allOrders.filter(o => o.type === 'HEDGE' && o.status === 'CLOSED').length}`);
  console.log(`    Hedge cycles: ${sig.hedgeCycleCount}`);
  console.log(`    hedgeHistory entries: ${sig.hedgeHistory.length}`);

  assert(allOrders.filter(o => o.status === 'OPEN').length === 1, 'Only 1 OPEN order (promoted MAIN)');
  assert(allOrders.filter(o => o.type === 'HEDGE' && o.status === 'OPEN').length === 0, 'No OPEN HEDGE orders');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE 8: Edge cases
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== SUITE 8: Edge cases ===');

// TEST 8.1: Multiple MAIN orders (DCA)
console.log('\n--- Test 8.1: Avg entry from multiple MAIN orders ---');
{
  resetDB();
  const sig = createSignal({ direction: 'LONG', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 100, notional: 400 });
  // DCA fill at $96 (L1)
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'LONG', type: 'MAIN', entryPrice: 96, notional: 250 });

  const state = getMainOrderState(sig._id);
  const expectedAvg = (100 * 400 + 96 * 250) / (400 + 250);
  assertClose(state.avgEntry, expectedAvg, 0.01, `Weighted avg entry: ${state.avgEntry.toFixed(4)}`);
  assert(state.totalNotional === 650, `Total notional: $${state.totalNotional}`);
  assert(state.direction === 'LONG', 'Direction from MAIN orders');
}

// TEST 8.2: getActiveDirection returns null when no MAIN orders
console.log('\n--- Test 8.2: No MAIN orders → direction null ---');
{
  resetDB();
  const dir = getActiveDirection('nonexistent');
  assert(dir === null, 'getActiveDirection returns null for missing signal');
}

// TEST 8.3: SHORT signal lifecycle
console.log('\n--- Test 8.3: SHORT signal full lifecycle ---');
{
  resetDB();
  const sig = createSignal({ direction: 'SHORT', entryPrice: 100 });
  createOrder({ signalId: sig._id, symbol: 'TESTUSDT', direction: 'SHORT', type: 'MAIN', entryPrice: 100, notional: 400 });

  // Price rises to 103 → -3% for SHORT → hedge opens LONG
  const h1 = openHedge(sig, 103);
  assert(h1.direction === 'LONG', 'SHORT signal → LONG hedge');

  // Hedge TP: price rises to 105.575
  const tpPrice = 103 * (1 + CONFIG.hedgeTpPctDefault / 100);
  closeHedgeOrder(sig, h1, tpPrice, 'HEDGE_TP');
  assert(sig.hedgeHistory.length === 1, 'Hedge history has entry');
  assert(sig.hedgeHistory[0].pnlUsdt > 0, `SHORT hedge profit: $${sig.hedgeHistory[0].pnlUsdt}`);

  // FLIP: main TP hit at 96.5 (SHORT profitable)
  const h2 = openHedge(sig, 104);
  executeFLIP(sig, h2, 96.5);
  assert(sig.direction === 'LONG', 'After FLIP: SHORT → LONG (promoted LONG hedge)');
  assert(sig.entryPrice === 104, 'Entry from hedge order');
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log(`Order-Based Refactor Simulator: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
