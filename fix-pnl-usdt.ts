/**
 * Migration script: Fix pnlUsdt for all COMPLETED signals
 *
 * Problem: pnlUsdt was calculated from full simNotional instead of actual filled grid volume
 * Fix: recalculate pnlUsdt = sum of (per-grid PnL% × grid simNotional) for filled grids
 *
 * Usage: npx ts-node fix-pnl-usdt.ts
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://admin:admin123@localhost:27017/binance-tele-bot?authSource=admin";

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();
  const signals = db.collection("ai_signals");

  const completed = await signals.find({ status: "COMPLETED" }).toArray();
  console.log(`Found ${completed.length} COMPLETED signals`);

  let fixed = 0;
  let skipped = 0;

  for (const signal of completed) {
    const { direction, exitPrice, pnlPercent, pnlUsdt: oldPnlUsdt } = signal;
    if (pnlPercent == null || !exitPrice) { skipped++; continue; }

    const grids: any[] = signal.gridLevels || [];
    const simNotional = signal.simNotional || 1000;
    let newPnlUsdt: number;

    if (grids.length > 0) {
      // Sum per-grid PnL from filled grids
      let totalUsdt = 0;
      for (const g of grids) {
        if (g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED") {
          const vol = g.simNotional || simNotional * (g.volumePct / 100);
          const gPnl = direction === "LONG"
            ? ((exitPrice - g.fillPrice) / g.fillPrice) * 100
            : ((g.fillPrice - exitPrice) / g.fillPrice) * 100;
          totalUsdt += (gPnl / 100) * vol;
        }
      }
      newPnlUsdt = Math.round(totalUsdt * 100) / 100;
    } else {
      // No grids — use full simNotional (legacy signals)
      newPnlUsdt = Math.round((pnlPercent / 100) * simNotional * 100) / 100;
    }

    if (Math.abs((oldPnlUsdt ?? 0) - newPnlUsdt) > 0.01) {
      await signals.updateOne(
        { _id: signal._id },
        { $set: { pnlUsdt: newPnlUsdt } },
      );
      console.log(
        `  ${signal.symbol} ${direction} ${signal.closeReason}: old=${oldPnlUsdt?.toFixed(2)} → new=${newPnlUsdt.toFixed(2)} (pnl%=${pnlPercent.toFixed(2)}, grids=${grids.length}, filled=${grids.filter((g: any) => g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED").length})`,
      );
      fixed++;
    } else {
      skipped++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} skipped (already correct)`);
  await client.close();
}

main().catch(console.error);
