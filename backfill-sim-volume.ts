/**
 * Backfill simNotional, simQuantity, pnlUsdt for existing ai_signals.
 *
 * Usage: npx ts-node backfill-sim-volume.ts
 *
 * - Active/Queued test signals: set simNotional + simQuantity
 * - Completed test signals: set simNotional + simQuantity + pnlUsdt
 * - Grid levels: set per-grid simNotional/simQuantity/pnlUsdt
 * - Also backfills completed non-test signals that have pnlPercent but no pnlUsdt
 */

import * as dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const SIM_BALANCE = 1000;
const SIM_LEVERAGE = 10;
const SIM_NOTIONAL = SIM_BALANCE * SIM_LEVERAGE; // $10,000

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const signals = db.collection("ai_signals");

  // 1. Backfill ALL test signals that don't have simNotional
  const testSignals = await signals
    .find({ isTestMode: true, $or: [{ simNotional: null }, { simNotional: { $exists: false } }] })
    .toArray();

  console.log(`Found ${testSignals.length} test signals without simNotional`);

  let updated = 0;
  for (const sig of testSignals) {
    const simNotional = SIM_NOTIONAL;
    const simQuantity = simNotional / sig.entryPrice;

    const update: any = { simNotional, simQuantity };

    // Calculate pnlUsdt for completed signals
    if (sig.status === "COMPLETED" && sig.pnlPercent != null) {
      update.pnlUsdt = (sig.pnlPercent / 100) * simNotional;
    }

    // Backfill grid levels if present
    if (sig.gridLevels?.length > 0) {
      const gridCount = sig.gridLevels.length;
      const gridNotional = simNotional / gridCount;
      const updatedGrids = sig.gridLevels.map((g: any) => {
        const gridUpdate = { ...g };
        if (g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED") {
          gridUpdate.simNotional = gridNotional;
          gridUpdate.simQuantity = g.fillPrice > 0 ? gridNotional / g.fillPrice : 0;
          if (g.pnlPct != null) {
            gridUpdate.pnlUsdt = (g.pnlPct / 100) * gridNotional;
          }
        }
        return gridUpdate;
      });
      update.gridLevels = updatedGrids;
    }

    await signals.updateOne({ _id: sig._id }, { $set: update });
    updated++;
  }

  console.log(`Updated ${updated} test signals with simulated volume`);

  // 2. Also backfill completed signals (test mode) that have pnlPercent but no pnlUsdt
  const completedNoUsdt = await signals
    .find({
      isTestMode: true,
      status: "COMPLETED",
      pnlPercent: { $ne: null },
      $or: [{ pnlUsdt: null }, { pnlUsdt: { $exists: false } }],
    })
    .toArray();

  console.log(`Found ${completedNoUsdt.length} completed test signals without pnlUsdt`);

  let updatedPnl = 0;
  for (const sig of completedNoUsdt) {
    const simNotional = sig.simNotional || SIM_NOTIONAL;
    const pnlUsdt = (sig.pnlPercent / 100) * simNotional;
    await signals.updateOne({ _id: sig._id }, { $set: { pnlUsdt } });
    updatedPnl++;
  }

  console.log(`Updated ${updatedPnl} signals with pnlUsdt`);

  await mongoose.disconnect();
  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
