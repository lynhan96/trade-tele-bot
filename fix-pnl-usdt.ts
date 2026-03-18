/**
 * Migration script: Fix pnlUsdt for all COMPLETED signals
 *
 * Rule: pnlUsdt = pnlPercent × actual filled volume
 *   - With grids: sum of filled grid simNotionals
 *   - Without grids: L0 = 40% of simNotional (default $1000 × 40% = $400)
 *
 * Usage: MONGODB_URI=... npx ts-node fix-pnl-usdt.ts
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://admin:admin123@localhost:27017/binance-tele-bot?authSource=admin";

function getFilledVol(signal: any): number {
  const total = signal.simNotional || 1000;
  const grids: any[] = signal.gridLevels || [];
  if (!grids.length) return total * 0.4; // L0 = 40%
  const filled = grids.reduce((s: number, g: any) =>
    s + ((g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED")
      ? (g.simNotional || total * (g.volumePct / 100)) : 0), 0);
  return filled > 0 ? filled : total * 0.4;
}

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
    const { pnlPercent, pnlUsdt: oldPnlUsdt } = signal;
    if (pnlPercent == null) { skipped++; continue; }

    const filledVol = getFilledVol(signal);
    const newPnlUsdt = Math.round((pnlPercent / 100) * filledVol * 100) / 100;

    if (Math.abs((oldPnlUsdt ?? 0) - newPnlUsdt) > 0.01) {
      await signals.updateOne(
        { _id: signal._id },
        { $set: { pnlUsdt: newPnlUsdt } },
      );
      console.log(
        `  ${signal.symbol} ${signal.direction} ${signal.closeReason}: old=${oldPnlUsdt?.toFixed(2)} → new=${newPnlUsdt.toFixed(2)} (pnl%=${pnlPercent.toFixed(2)}, vol=${Math.round(filledVol)})`,
      );
      fixed++;
    } else {
      skipped++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} skipped`);
  await client.close();
}

main().catch(console.error);
