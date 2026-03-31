/**
 * Reset signals (OPNUSDT, SOLUSDT, ROBOUSDT) that had old per-grid TP logic.
 * Resets to: L0=FILLED (40%), L1-L4=PENDING with new DCA weights.
 * Clears old TP_CLOSED/realized PnL from invalid per-grid TP.
 *
 * Usage: npx ts-node reset-grid-signals.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const SIM_NOTIONAL = 1000;
const GRID_LEVEL_COUNT = 5;
const DCA_WEIGHTS = [40, 6, 12, 18, 24];
const SYMBOLS_TO_RESET = ["OPNUSDT", "SOLUSDT", "ROBOUSDT"];

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

  const toReset = await signals
    .find({
      status: "ACTIVE",
      symbol: { $in: SYMBOLS_TO_RESET },
      "gridLevels.0": { $exists: true },
    })
    .toArray();

  console.log(`Found ${toReset.length} signals to reset`);

  for (const sig of toReset) {
    const origEntry = sig.originalEntryPrice ?? sig.entryPrice;
    const stopLossPrice = sig.stopLossPrice;
    const direction = sig.direction;

    if (!stopLossPrice || !origEntry) {
      console.log(`  SKIP ${sig.symbol}: missing data`);
      continue;
    }

    const signalSlPct = Math.abs((stopLossPrice - origEntry) / origEntry) * 100;
    const gridStep = signalSlPct / (GRID_LEVEL_COUNT + 1);

    console.log(`\n  ${sig.symbol} (${direction}): origEntry=${origEntry}, SL=${stopLossPrice}, step=${gridStep.toFixed(3)}%`);
    console.log(`    Old: ${sig.gridLevels.map((g: any) => `L${g.level}:${g.status}`).join(", ")}`);

    // Build fresh grids: L0=FILLED, L1-L4=PENDING
    const newGrids: any[] = [];
    for (let i = 0; i < GRID_LEVEL_COUNT; i++) {
      const dev = i * gridStep;
      const volPct = DCA_WEIGHTS[i];
      const gridNotional = SIM_NOTIONAL * (volPct / 100);

      if (i === 0) {
        newGrids.push({
          level: 0,
          deviationPct: 0,
          fillPrice: origEntry,
          volumePct: volPct,
          status: "FILLED",
          filledAt: sig.executedAt || sig.createdAt,
          simNotional: gridNotional,
          simQuantity: gridNotional / origEntry,
        });
      } else {
        newGrids.push({
          level: i,
          deviationPct: parseFloat(dev.toFixed(3)),
          fillPrice: 0,
          volumePct: volPct,
          status: "PENDING",
        });
      }
    }

    console.log(`    New: ${newGrids.map((g) => `L${g.level}:${g.status}(${g.volumePct}%)`).join(", ")}`);

    await signals.updateOne({ _id: sig._id }, {
      $set: {
        gridLevels: newGrids,
        gridGlobalSlPrice: stopLossPrice,
        gridAvgEntry: origEntry,
        gridFilledCount: 1,
        gridClosedCount: 0,
        entryPrice: origEntry,
        simNotional: SIM_NOTIONAL,
        simQuantity: SIM_NOTIONAL / origEntry,
        slMovedToEntry: false,
        tpBoosted: false,
      },
      $unset: {
        peakPnlPct: "",
      },
    });
    console.log(`    RESET OK`);
  }

  console.log(`\nDone`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
