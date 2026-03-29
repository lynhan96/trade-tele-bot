/**
 * Fix TAUSDT C11+C12 hedge PnL — wrong entry price (gridAvgEntry instead of market price)
 * Also recalc signal pnlUsdt with corrected banked profit
 * Run: MONGODB_URI=... npx ts-node scripts/fix-pnl-usdt.ts
 */
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://admin:admin123@localhost:27017/binance-tele-bot?authSource=admin";

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  const ta = await db.collection("ai_signals").findOne(
    { symbol: "TAUSDT", status: "COMPLETED" },
    { sort: { positionClosedAt: -1 } },
  );
  if (!ta) { console.log("No TAUSDT signal found"); process.exit(1); }
  console.log("Signal:", ta._id.toString());

  const history = [...ta.hedgeHistory];

  // C11 (index 10): real entry ~= C10 exit (0.05538)
  console.log("\nBefore C11:", JSON.stringify({ entry: history[10].entryPrice, pnl: history[10].pnlUsdt }));
  history[10].entryPrice = 0.05538;
  history[10].pnlPct = -0.74;
  history[10].pnlUsdt = -6.15;
  console.log("After  C11:", JSON.stringify({ entry: history[10].entryPrice, pnl: history[10].pnlUsdt }));

  // C12 (index 11): real entry ~= C11 exit (0.05497)
  console.log("\nBefore C12:", JSON.stringify({ entry: history[11].entryPrice, pnl: history[11].pnlUsdt }));
  history[11].entryPrice = 0.05497;
  history[11].pnlPct = -1.07;
  history[11].pnlUsdt = -8.65;
  console.log("After  C12:", JSON.stringify({ entry: history[11].entryPrice, pnl: history[11].pnlUsdt }));

  // Recalc total
  const totalBanked = history.reduce((s: number, h: any) => s + (h.pnlUsdt || 0), 0);
  const mainEntry = ta.gridAvgEntry || ta.entryPrice;
  const closePrice = history[11].exitPrice;
  const mainPnlPct = ((mainEntry - closePrice) / mainEntry) * 100; // SHORT
  const filledVol = 400;
  const mainPnlUsdt = (mainPnlPct / 100) * filledVol;
  const fees = filledVol * 0.0004 * 2;
  const netPnlUsdt = Math.round((mainPnlUsdt - fees + totalBanked) * 100) / 100;

  console.log("\n=== Corrected ===");
  console.log("Banked:", totalBanked.toFixed(2));
  console.log("Main:", mainPnlPct.toFixed(2) + "%", "=", mainPnlUsdt.toFixed(2));
  console.log("NET:", netPnlUsdt.toFixed(2), "(was:", ta.pnlUsdt, ")");

  await db.collection("ai_signals").updateOne(
    { _id: ta._id },
    { $set: { hedgeHistory: history, pnlUsdt: netPnlUsdt } },
  );

  // Verify
  const v = await db.collection("ai_signals").findOne({ _id: ta._id });
  console.log("\nVerified pnlUsdt:", v!.pnlUsdt);
  console.log("Verified C11:", v!.hedgeHistory[10].entryPrice, "pnl:", v!.hedgeHistory[10].pnlUsdt);
  console.log("Verified C12:", v!.hedgeHistory[11].entryPrice, "pnl:", v!.hedgeHistory[11].pnlUsdt);

  await client.close();
  console.log("\nDone!");
}

main().catch(console.error);
