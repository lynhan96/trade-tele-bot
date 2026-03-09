import * as dotenv from "dotenv";
dotenv.config();
import * as mongoose from "mongoose";

async function main() {
  const conn = await mongoose.connect(process.env.MONGODB_URI!);
  const db = conn.connection.db!;
  const signals = await db.collection("ai_signals").find({ status: "COMPLETED" }).toArray();

  let neverReached = 0, neverReachedPnl = 0;
  let reachedBE = 0, reachedBEPnl = 0;

  for (const s of signals) {
    const pnl = s.pnlPercent || 0;
    if (s.slMovedToEntry) { reachedBE++; reachedBEPnl += pnl; }
    else { neverReached++; neverReachedPnl += pnl; }
  }

  console.log("Never reached 1.5%:", neverReached, "total PnL:", neverReachedPnl.toFixed(2) + "%");
  console.log("Reached 1.5%+ (BE):", reachedBE, "total PnL:", reachedBEPnl.toFixed(2) + "%",
    "avg:", reachedBE ? (reachedBEPnl / reachedBE).toFixed(2) + "%" : "N/A");

  console.log("\n=== AUTO-CLOSE PROFIT (closed early with small profit) ===");
  const acp = signals.filter(s => (s.closeReason || "").includes("AUTO_CLOSE_PROFIT"));
  for (const s of acp) {
    console.log(s.symbol?.padEnd(14), s.direction?.padEnd(6), "pnl:", (s.pnlPercent || 0).toFixed(2) + "%", s.strategy);
  }

  console.log("\n=== SL HITS WITH POSITIVE PNL (had profit, reversed) ===");
  const slPos = signals.filter(s => (s.closeReason || "").includes("STOP_LOSS") && (s.pnlPercent || 0) > 0);
  for (const s of slPos) {
    console.log(s.symbol?.padEnd(14), "pnl:", (s.pnlPercent || 0).toFixed(2) + "%",
      "slMoved:", Boolean(s.slMovedToEntry), "sl3:", Boolean(s.sl3PctRaised));
  }

  console.log("\n=== SL HITS WITH -3% (full SL, never recovered) ===");
  const slFull = signals.filter(s => (s.closeReason || "").includes("STOP_LOSS") && (s.pnlPercent || 0) <= -2.5);
  for (const s of slFull) {
    console.log(s.symbol?.padEnd(14), s.direction?.padEnd(6), "pnl:", (s.pnlPercent || 0).toFixed(2) + "%", s.strategy);
  }

  const active = await db.collection("ai_signals").find({ status: { $in: ["ACTIVE", "QUEUED"] } }).toArray();
  console.log("\n=== ACTIVE/QUEUED:", active.length, "===");
  for (const s of active) {
    console.log(s.symbol?.padEnd(14), s.status?.padEnd(8), s.direction?.padEnd(6),
      "entry:", s.entryPrice?.toFixed(4), "SL:", s.stopLossPrice?.toFixed(4),
      "TP:", s.takeProfitPrice?.toFixed(4), s.strategy);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
