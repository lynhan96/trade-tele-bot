/**
 * Migration: Create HEDGE orders from signal.hedgeHistory + add grid metadata to MAIN orders
 * Run: npx ts-node migrate-orders.ts
 */
import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://root:tradingbot2024@127.0.0.1:27017/binance-tele-bot?authSource=admin';
const TAKER_FEE_PCT = 0.05 / 100;

async function main() {
  const client = await MongoClient.connect(MONGO_URI);
  const db = client.db();
  const signals = db.collection('ai_signals');
  const orders = db.collection('orders');

  console.log('=== Order Migration ===\n');

  // 1. Stats
  const totalOrders = await orders.countDocuments();
  const mainOrders = await orders.countDocuments({ type: { $in: ['MAIN', 'FLIP_MAIN'] } });
  const hedgeOrders = await orders.countDocuments({ type: 'HEDGE' });
  console.log(`Current: ${totalOrders} orders (${mainOrders} MAIN, ${hedgeOrders} HEDGE)\n`);

  // 2. Find signals with hedgeHistory but missing HEDGE orders
  const withHedge = await signals.find({
    'hedgeHistory.0': { $exists: true },
  }).toArray();

  let createdHedgeOrders = 0;
  let skippedHedgeOrders = 0;

  for (const sig of withHedge) {
    const history: any[] = sig.hedgeHistory || [];
    const existingHedges = await orders.countDocuments({ signalId: sig._id, type: 'HEDGE' });

    // Skip if already has enough HEDGE orders
    if (existingHedges >= history.length) {
      skippedHedgeOrders += history.length;
      continue;
    }

    // Create missing HEDGE orders from hedgeHistory
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      // Check if this cycle already has an order
      const exists = await orders.findOne({
        signalId: sig._id,
        type: 'HEDGE',
        entryPrice: h.entryPrice,
        cycleNumber: h.cycle || i + 1,
      });
      if (exists) { skippedHedgeOrders++; continue; }

      const notional = h.notional || (sig.simNotional || 1000) * 0.75;
      const entryFee = +(notional * TAKER_FEE_PCT).toFixed(4);
      const exitFee = +(notional * TAKER_FEE_PCT).toFixed(4);
      const direction = h.direction || (sig.direction === 'LONG' ? 'SHORT' : 'LONG');

      await orders.insertOne({
        signalId: sig._id,
        symbol: sig.symbol,
        direction,
        type: 'HEDGE',
        status: 'CLOSED',
        entryPrice: h.entryPrice,
        exitPrice: h.exitPrice,
        notional,
        quantity: notional / (h.entryPrice || 1),
        pnlPercent: h.pnlPct || 0,
        pnlUsdt: h.pnlUsdt || 0,
        entryFeeUsdt: entryFee,
        exitFeeUsdt: exitFee,
        fundingFeeUsdt: 0,
        stopLossPrice: 0,
        takeProfitPrice: 0,
        closeReason: h.reason || 'HEDGE_CLOSE',
        openedAt: h.openedAt ? new Date(h.openedAt) : sig.executedAt,
        closedAt: h.closedAt ? new Date(h.closedAt) : sig.positionClosedAt || new Date(),
        cycleNumber: h.cycle || i + 1,
        metadata: {
          migrated: true,
          phase: h.phase || 'FULL',
          reason: h.entryReason || h.reason || '',
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      createdHedgeOrders++;
    }
  }

  console.log(`HEDGE orders: created ${createdHedgeOrders}, skipped ${skippedHedgeOrders}`);

  // 3. Add grid metadata to MAIN orders that don't have it
  const mainOrdersNoMeta = await orders.find({
    type: { $in: ['MAIN', 'FLIP_MAIN'] },
    'metadata.gridLevels': { $exists: false },
  }).toArray();

  let updatedMainOrders = 0;
  for (const ord of mainOrdersNoMeta) {
    const sig = await signals.findOne({ _id: ord.signalId });
    if (!sig) continue;

    const gridLevels = sig.gridLevels || [];
    const updates: any = {
      'metadata.migrated': true,
      'metadata.originalEntryPrice': sig.originalEntryPrice || sig.entryPrice,
      'metadata.originalSlPrice': sig.originalSlPrice || sig.stopLossPrice,
      'metadata.simNotional': sig.simNotional || 1000,
      'metadata.peakPnlPct': sig.peakPnlPct || 0,
      'metadata.slMovedToEntry': sig.slMovedToEntry || false,
      'metadata.tpBoosted': sig.tpBoosted || false,
    };

    if (gridLevels.length > 0) {
      updates['metadata.gridLevels'] = gridLevels;
      updates['metadata.gridFilledCount'] = sig.gridFilledCount || gridLevels.filter((g: any) => g.status === 'FILLED').length;
      updates['metadata.gridClosedCount'] = sig.gridClosedCount || 0;
    }

    // Also sync SL/TP if not set on order
    if (!ord.stopLossPrice && sig.stopLossPrice) {
      updates.stopLossPrice = sig.stopLossPrice;
    }
    if (!ord.takeProfitPrice && sig.takeProfitPrice) {
      updates.takeProfitPrice = sig.takeProfitPrice;
    }

    await orders.updateOne({ _id: ord._id }, { $set: updates });
    updatedMainOrders++;
  }

  console.log(`MAIN orders: added grid metadata to ${updatedMainOrders} (${mainOrdersNoMeta.length} without)`);

  // 4. Summary
  const finalOrders = await orders.countDocuments();
  const finalHedge = await orders.countDocuments({ type: 'HEDGE' });
  const finalWithMeta = await orders.countDocuments({ 'metadata.gridLevels': { $exists: true } });

  console.log(`\n=== After Migration ===`);
  console.log(`Total orders: ${finalOrders} (was ${totalOrders})`);
  console.log(`HEDGE orders: ${finalHedge} (was ${hedgeOrders})`);
  console.log(`Orders with grid metadata: ${finalWithMeta}`);

  await client.close();
  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
