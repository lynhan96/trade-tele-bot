/**
 * Revert signals incorrectly closed by AI agent.
 *
 * Usage: node scripts/revert-agent-closes.js
 *
 * Run on server after deploying safety fixes.
 * This script:
 * 1. Finds IRYSUSDT + AXSUSDT signals closed by ADMIN_CLOSE recently
 * 2. Reverts them to ACTIVE status
 * 3. Reopens their CLOSED orders back to OPEN
 * 4. Redis keys will be re-created by PositionMonitor on next poll
 */

import { MongoClient, ObjectId } from "mongodb"
import dotenv from "dotenv"
dotenv.config()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/binance-telebot"
const SYMBOLS_TO_REVERT = ["IRYSUSDT", "AXSUSDT"]

async function main() {
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db()

  console.log("=== Revert Agent Force-Closes ===\n")

  for (const symbol of SYMBOLS_TO_REVERT) {
    // Find the most recent COMPLETED signal with ADMIN_CLOSE
    const signal = await db.collection("ai_signals").findOne(
      { symbol, status: "COMPLETED", closeReason: "ADMIN_CLOSE" },
      { sort: { positionClosedAt: -1 } }
    )

    if (!signal) {
      console.log(`[${symbol}] No ADMIN_CLOSE signal found — skipping`)
      continue
    }

    console.log(`[${symbol}] Found signal ${signal._id}`)
    console.log(`  Direction: ${signal.direction}`)
    console.log(`  Entry: ${signal.gridAvgEntry || signal.entryPrice}`)
    console.log(`  Exit: ${signal.exitPrice}`)
    console.log(`  PnL: ${signal.pnlPercent?.toFixed(2)}% ($${signal.pnlUsdt})`)
    console.log(`  Closed at: ${signal.positionClosedAt}`)
    console.log(`  Hedge active: ${signal.hedgeActive}`)
    console.log(`  Hedge cycles: ${signal.hedgeCycleCount}`)

    // Revert signal to ACTIVE
    const result = await db.collection("ai_signals").updateOne(
      { _id: signal._id },
      {
        $set: { status: "ACTIVE" },
        $unset: {
          exitPrice: 1,
          pnlPercent: 1,
          pnlUsdt: 1,
          positionClosedAt: 1,
          closeReason: 1,
        },
      }
    )
    console.log(`  ✅ Signal reverted to ACTIVE (modified: ${result.modifiedCount})`)

    // Reopen CLOSED orders that were closed by ADMIN_CLOSE
    const closedOrders = await db.collection("orders").find({
      signalId: signal._id,
      status: "CLOSED",
      closeReason: "ADMIN_CLOSE",
    }).toArray()

    for (const order of closedOrders) {
      await db.collection("orders").updateOne(
        { _id: order._id },
        {
          $set: { status: "OPEN" },
          $unset: {
            exitPrice: 1,
            pnlPercent: 1,
            pnlUsdt: 1,
            closedAt: 1,
            closeReason: 1,
            exitFeeUsdt: 1,
          },
        }
      )
      console.log(`  ✅ Order ${order._id} (${order.type}) reopened`)
    }

    if (!closedOrders.length) {
      console.log(`  ⚠️ No ADMIN_CLOSE orders found — may need manual check`)
    }

    // Re-insert Redis active key
    // Note: PositionMonitor should auto-detect ACTIVE signals on next poll
    // but you can also manually set the Redis key:
    const signalKey = signal.symbol // or signal.symbol + ":" + signal.timeframeProfile for dual timeframe
    console.log(`  📝 Redis key needed: cache:ai-signal:active:${signalKey}`)
    console.log(`  (PositionMonitor should auto-detect on next poll)\n`)
  }

  console.log("=== Done ===")
  console.log("⚠️ Verify on Binance that positions are still open!")
  console.log("⚠️ PositionMonitor will pick up ACTIVE signals on next 30s poll")

  await client.close()
}

main().catch(err => {
  console.error("Error:", err)
  process.exit(1)
})
