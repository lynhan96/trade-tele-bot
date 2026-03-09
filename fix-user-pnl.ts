/**
 * Script to fix user trade PnL by fetching actual fill prices from Binance.
 *
 * Usage: npx ts-node fix-user-pnl.ts [--dry-run]
 *
 * --dry-run: Show what would change without updating DB (default)
 * --apply:   Actually update the database
 */
import * as dotenv from "dotenv";
dotenv.config();

import * as mongoose from "mongoose";
import Binance from "binance-api-node";

const TELEGRAM_ID = 1027556045;
const BINANCE_FEE_PCT = 0.08; // 0.04% taker × 2 (open + close)
const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN (use --apply to update DB) ===" : "=== APPLYING CHANGES ===");
  console.log("");

  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;

  // Get user API keys
  const userSettings = await db.collection("user_settings").findOne({ telegramId: TELEGRAM_ID });
  if (!userSettings?.binanceApiKey || !userSettings?.binanceApiSecret) {
    console.error("No Binance API keys found for user", TELEGRAM_ID);
    process.exit(1);
  }

  const client = Binance({
    apiKey: userSettings.binanceApiKey,
    apiSecret: userSettings.binanceApiSecret,
  });

  // Get all closed trades
  const trades = await db.collection("user_trades")
    .find({ telegramId: TELEGRAM_ID, status: "CLOSED" })
    .sort({ closedAt: -1 })
    .toArray();

  console.log(`Found ${trades.length} closed trades\n`);

  let oldTotal = 0;
  let newTotal = 0;
  let fixedCount = 0;

  for (const trade of trades) {
    const oldPnlUsdt = trade.pnlUsdt || 0;
    oldTotal += oldPnlUsdt;

    try {
      // Fetch recent trades from Binance for this symbol around the close time
      const closedAt = trade.closedAt ? new Date(trade.closedAt).getTime() : Date.now();
      const startTime = closedAt - 5 * 60 * 1000; // 5 min before close
      const endTime = closedAt + 5 * 60 * 1000;   // 5 min after close

      const binanceTrades = await (client as any).futuresUserTrades({
        symbol: trade.symbol,
        startTime,
        endTime,
        limit: 20,
      });

      if (!binanceTrades || binanceTrades.length === 0) {
        // No trades found — try wider window
        const widerTrades = await (client as any).futuresUserTrades({
          symbol: trade.symbol,
          startTime: closedAt - 30 * 60 * 1000,
          endTime: closedAt + 5 * 60 * 1000,
          limit: 50,
        });

        if (!widerTrades || widerTrades.length === 0) {
          console.log(`${trade.symbol.padEnd(14)} | NO BINANCE TRADES FOUND | keeping old PnL: ${oldPnlUsdt.toFixed(3)}`);
          newTotal += oldPnlUsdt;
          continue;
        }
        binanceTrades.push(...widerTrades);
      }

      // Find the closing trade(s) — look for SELL if LONG, BUY if SHORT
      const closeSide = trade.direction === "LONG" ? "SELL" : "BUY";
      const closingTrades = binanceTrades.filter((bt: any) => bt.side === closeSide && bt.realizedPnl !== "0");

      if (closingTrades.length === 0) {
        // Fallback: any trade with realized PnL
        const anyPnl = binanceTrades.filter((bt: any) => parseFloat(bt.realizedPnl) !== 0);
        if (anyPnl.length > 0) {
          closingTrades.push(...anyPnl);
        }
      }

      if (closingTrades.length === 0) {
        console.log(`${trade.symbol.padEnd(14)} | No closing trades found | keeping old PnL: ${oldPnlUsdt.toFixed(3)}`);
        newTotal += oldPnlUsdt;
        continue;
      }

      // Calculate actual PnL from Binance realized PnL + commission
      let realizedPnl = 0;
      let totalCommission = 0;
      let weightedPrice = 0;
      let totalQty = 0;

      for (const ct of closingTrades) {
        realizedPnl += parseFloat(ct.realizedPnl);
        totalCommission += parseFloat(ct.commission);
        const qty = parseFloat(ct.qty);
        weightedPrice += parseFloat(ct.price) * qty;
        totalQty += qty;
      }

      const actualExitPrice = totalQty > 0 ? weightedPrice / totalQty : trade.exitPrice;
      const actualPnlUsdt = realizedPnl - totalCommission; // Binance realizedPnl already includes entry-exit diff, commission is separate
      const actualPnlPct = trade.notionalUsdt ? (actualPnlUsdt / trade.notionalUsdt) * 100 : 0;

      const diff = actualPnlUsdt - oldPnlUsdt;
      const changed = Math.abs(diff) > 0.01;

      if (changed) {
        fixedCount++;
        console.log(
          `${trade.symbol.padEnd(14)} | ${trade.direction.padEnd(6)} | ` +
          `exit: ${trade.exitPrice?.toFixed(4)} → ${actualExitPrice.toFixed(4)} | ` +
          `pnl$: ${oldPnlUsdt.toFixed(3)} → ${actualPnlUsdt.toFixed(3)} (${diff >= 0 ? "+" : ""}${diff.toFixed(3)}) | ` +
          `fee: ${totalCommission.toFixed(4)} | ${trade.closeReason}`
        );

        if (!DRY_RUN) {
          await db.collection("user_trades").updateOne(
            { _id: trade._id },
            {
              $set: {
                exitPrice: actualExitPrice,
                pnlPercent: actualPnlPct,
                pnlUsdt: actualPnlUsdt,
              },
            },
          );
        }
      } else {
        console.log(`${trade.symbol.padEnd(14)} | ${trade.direction.padEnd(6)} | OK (diff: ${diff.toFixed(3)})`);
      }

      newTotal += changed ? actualPnlUsdt : oldPnlUsdt;

      // Rate limit: small delay between API calls
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.error(`${trade.symbol.padEnd(14)} | ERROR: ${err.message}`);
      newTotal += oldPnlUsdt;
    }
  }

  console.log("\n════════════════════════════════════════");
  console.log(`Old total PnL: ${oldTotal.toFixed(2)} USDT`);
  console.log(`New total PnL: ${newTotal.toFixed(2)} USDT`);
  console.log(`Difference:    ${(newTotal - oldTotal).toFixed(2)} USDT`);
  console.log(`Trades fixed:  ${fixedCount} / ${trades.length}`);
  console.log(DRY_RUN ? "\n(Dry run — no changes made. Use --apply to update.)" : "\n✅ Changes applied to database.");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
