/**
 * Migration: Update active grid signals from old per-grid TP logic to true DCA.
 *
 * Changes:
 * - DCA weights: old [10,15,20,25,30] → new [40,6,12,18,24] (L0=40% base)
 * - Recalculate simNotional/simQuantity per grid with new weights
 * - Dynamic grid step from signal's SL (gridStep = slPct / (5+1))
 * - Set gridGlobalSlPrice = signal's stopLossPrice (not fixed 3.5%)
 * - Recalculate gridAvgEntry from filled grids
 * - Remove old tpPrice from grid levels, add exitPrice where closed
 *
 * Usage: npx ts-node migrate-grid-dca.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";

const SIM_NOTIONAL = 1000; // $1000 per trade
const GRID_LEVEL_COUNT = 5;
const DCA_WEIGHTS = [40, 6, 12, 18, 24]; // L0=40%, L1-L4 = 6/12/18/24

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

  // Find all ACTIVE signals with gridLevels
  const activeGridSignals = await signals
    .find({
      status: "ACTIVE",
      "gridLevels.0": { $exists: true },
    })
    .toArray();

  console.log(`Found ${activeGridSignals.length} active grid signals to migrate`);

  let updated = 0;
  for (const sig of activeGridSignals) {
    const origEntry = sig.originalEntryPrice ?? sig.entryPrice;
    const stopLossPrice = sig.stopLossPrice;
    const direction = sig.direction;
    const grids = sig.gridLevels || [];

    if (!stopLossPrice || !origEntry) {
      console.log(`  SKIP ${sig.symbol}: missing stopLossPrice or entryPrice`);
      continue;
    }

    // Dynamic grid step from signal's SL
    const signalSlPct = Math.abs((stopLossPrice - origEntry) / origEntry) * 100;
    const gridStep = signalSlPct / (GRID_LEVEL_COUNT + 1);

    console.log(`\n  ${sig.symbol} (${direction}): origEntry=${origEntry}, SL=${stopLossPrice}, slPct=${signalSlPct.toFixed(2)}%, step=${gridStep.toFixed(3)}%`);
    console.log(`    Old grids: ${grids.map((g: any) => `L${g.level}:${g.status}(${g.volumePct}%)`).join(", ")}`);

    // Rebuild grid levels with new weights and dynamic step
    const newGrids: any[] = [];
    for (let i = 0; i < GRID_LEVEL_COUNT; i++) {
      const oldGrid = grids.find((g: any) => g.level === i);
      const dev = i * gridStep;
      const volPct = DCA_WEIGHTS[i];
      const gridNotional = SIM_NOTIONAL * (volPct / 100);

      // Calculate expected fill price for this level
      const expectedFillPrice =
        direction === "LONG"
          ? origEntry * (1 - dev / 100)
          : origEntry * (1 + dev / 100);

      if (oldGrid && (oldGrid.status === "FILLED" || oldGrid.status === "TP_CLOSED" || oldGrid.status === "SL_CLOSED")) {
        // Preserve filled/closed status, update weights and notional
        const fillPrice = oldGrid.fillPrice || expectedFillPrice;
        newGrids.push({
          level: i,
          deviationPct: parseFloat(dev.toFixed(3)),
          fillPrice,
          exitPrice: oldGrid.exitPrice || oldGrid.tpPrice || undefined,
          volumePct: volPct,
          status: oldGrid.status,
          filledAt: oldGrid.filledAt,
          closedAt: oldGrid.closedAt,
          pnlPct: oldGrid.pnlPct,
          pnlUsdt: oldGrid.pnlPct != null ? (oldGrid.pnlPct / 100) * gridNotional : undefined,
          simNotional: gridNotional,
          simQuantity: fillPrice > 0 ? gridNotional / fillPrice : 0,
        });
      } else {
        // PENDING or missing — reset with new weights
        newGrids.push({
          level: i,
          deviationPct: parseFloat(dev.toFixed(3)),
          fillPrice: 0,
          volumePct: volPct,
          status: "PENDING",
        });
      }
    }

    // Calculate avg entry from filled grids
    const filledGrids = newGrids.filter((g) => g.status === "FILLED");
    const filledCount = filledGrids.length;
    let avgEntry = origEntry;
    if (filledGrids.length > 0) {
      const totalNotional = filledGrids.reduce((s, g) => s + (g.simNotional || 0), 0);
      avgEntry = totalNotional > 0
        ? filledGrids.reduce((s, g) => s + g.fillPrice * (g.simNotional || 0), 0) / totalNotional
        : origEntry;
    }
    const closedCount = newGrids.filter((g) => g.status === "TP_CLOSED" || g.status === "SL_CLOSED").length;

    console.log(`    New grids: ${newGrids.map((g) => `L${g.level}:${g.status}(${g.volumePct}%)`).join(", ")}`);
    console.log(`    avgEntry=${avgEntry.toFixed(6)}, filled=${filledCount}, closed=${closedCount}`);

    await signals.updateOne({ _id: sig._id }, {
      $set: {
        gridLevels: newGrids,
        gridGlobalSlPrice: stopLossPrice,
        gridAvgEntry: avgEntry,
        gridFilledCount: filledCount,
        gridClosedCount: closedCount,
        entryPrice: avgEntry, // sync entryPrice to avg
        simNotional: SIM_NOTIONAL,
        simQuantity: SIM_NOTIONAL / origEntry,
      },
    });
    updated++;
  }

  console.log(`\nMigrated ${updated} signals`);

  await mongoose.disconnect();
  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
