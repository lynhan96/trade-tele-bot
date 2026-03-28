/**
 * Fix 4USDT duplicate LONG records.
 *
 * Problem: sync script inserted a 2nd LONG MAIN record at 12:46.
 * The original LONG MAIN (12:41) should be reopened instead.
 *
 * This script:
 * 1. Finds all CLOSED 4USDT LONG MAIN records
 * 2. Deletes the duplicate (newer, from sync — has syncedFromBinance=true)
 * 3. Reopens the original (older) record with current Binance position data
 *
 * Usage:
 *   node scripts/fix-4usdt-duplicate.js
 *   node scripts/fix-4usdt-duplicate.js --dry-run
 */

const { MongoClient } = require("mongodb")
const crypto = require("crypto")
const https = require("https")
require("dotenv").config()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/binance-telebot"
const DRY_RUN = process.argv.includes("--dry-run")
const SYMBOL = "4USDT"

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex")
}

function binanceGet(path, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now()
    const qs = `timestamp=${timestamp}`
    const signature = sign(qs, apiSecret)
    const url = `https://fapi.binance.com${path}?${qs}&signature=${signature}`
    const options = { headers: { "X-MBX-APIKEY": apiKey } }
    https.get(url, options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.code && parsed.code < 0) reject(new Error(parsed.msg))
          else resolve(parsed)
        } catch (e) { reject(e) }
      })
    }).on("error", reject)
  })
}

async function main() {
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db()

  console.log(`\n=== Fix 4USDT Duplicate${DRY_RUN ? " (DRY RUN)" : ""} ===\n`)

  // 1. Find all 4USDT LONG records (both OPEN and CLOSED)
  const allLongs = await db.collection("user_trades")
    .find({ symbol: SYMBOL, direction: "LONG", isHedge: { $ne: true } })
    .sort({ createdAt: -1 })
    .toArray()

  console.log(`Found ${allLongs.length} 4USDT LONG MAIN record(s):`)
  for (const t of allLongs) {
    console.log(`  ${t._id} | status=${t.status} | entry=$${t.entryPrice} | qty=${t.quantity} | synced=${!!t.syncedFromBinance} | created=${t.createdAt} | closed=${t.closedAt || "—"}`)
  }
  console.log()

  if (allLongs.length < 2) {
    console.log("Only 1 record found — no duplicates to fix.")
    if (allLongs.length === 1 && allLongs[0].status === "CLOSED") {
      console.log("Single CLOSED record found — will reopen it.")
    } else if (allLongs.length === 1 && allLongs[0].status === "OPEN") {
      console.log("Already OPEN — nothing to do.")
      await client.close()
      return
    }
  }

  // 2. Separate: synced duplicates vs original
  const synced = allLongs.filter((t) => t.syncedFromBinance)
  const originals = allLongs.filter((t) => !t.syncedFromBinance)

  // The original is the one WITHOUT syncedFromBinance (or the oldest one)
  const original = originals.length > 0 ? originals[originals.length - 1] : allLongs[allLongs.length - 1]
  const duplicates = allLongs.filter((t) => t._id.toString() !== original._id.toString())

  console.log(`Original record: ${original._id} (status=${original.status}, created=${original.createdAt})`)
  console.log(`Duplicates to remove: ${duplicates.length}`)
  for (const d of duplicates) {
    console.log(`  DELETE: ${d._id} (status=${d.status}, synced=${!!d.syncedFromBinance}, created=${d.createdAt})`)
  }
  console.log()

  // 3. Get current Binance position data for 4USDT
  const sub = await db.collection("user_signal_subscriptions")
    .findOne({ realModeEnabled: true, isActive: true })
  if (!sub) {
    console.log("No real-mode subscriber found — cannot fetch Binance data.")
    await client.close()
    return
  }

  const settings = await db.collection("user_settings").findOne({ telegramId: sub.telegramId })
  if (!settings?.binance?.apiKey) {
    console.log("No Binance API keys — cannot verify position.")
    await client.close()
    return
  }

  let binancePos = null
  try {
    const positions = await binanceGet("/fapi/v2/positionRisk", settings.binance.apiKey, settings.binance.apiSecret)
    binancePos = positions.find((p) => p.symbol === SYMBOL && parseFloat(p.positionAmt) > 0)
  } catch (err) {
    console.log(`Binance API error: ${err.message}`)
  }

  if (!binancePos) {
    console.log(`⚠️  No LONG position found on Binance for ${SYMBOL}`)
    console.log("Position may have been closed. Will still clean up duplicates.\n")
  } else {
    const entry = parseFloat(binancePos.entryPrice)
    const qty = parseFloat(binancePos.positionAmt)
    const mark = parseFloat(binancePos.markPrice)
    const pnl = ((mark - entry) / entry) * 100
    console.log(`Binance LONG: entry=$${entry} qty=${qty} mark=$${mark} PnL=${pnl.toFixed(2)}%\n`)
  }

  // 4. Find the active signal for linking
  const activeSignal = await db.collection("ai_signals").findOne({ symbol: SYMBOL, status: "ACTIVE" })
  console.log(`Active signal: ${activeSignal ? activeSignal._id + " dir=" + activeSignal.direction : "none"}`)

  if (!DRY_RUN) {
    // 5. Delete duplicates
    for (const d of duplicates) {
      await db.collection("user_trades").deleteOne({ _id: d._id })
      console.log(`🗑️  Deleted duplicate ${d._id}`)
    }

    // 6. Reopen original record with current Binance data
    if (binancePos && original.status === "CLOSED") {
      const entry = parseFloat(binancePos.entryPrice)
      const qty = Math.abs(parseFloat(binancePos.positionAmt))
      const lev = parseInt(binancePos.leverage)
      const notional = qty * entry
      const slPrice = entry * 0.60 // 40% safety net

      await db.collection("user_trades").updateOne(
        { _id: original._id },
        {
          $set: {
            status: "OPEN",
            entryPrice: entry,
            quantity: qty,
            leverage: lev,
            notionalUsdt: notional,
            slPrice: slPrice,
            tpPrice: activeSignal?.takeProfitPrice || original.tpPrice || 0,
            aiSignalId: activeSignal?._id?.toString() || original.aiSignalId || null,
            syncedFromBinance: true,
            openedAt: new Date(),
            updatedAt: new Date(),
          },
          $unset: {
            closeReason: 1, exitPrice: 1, pnlPercent: 1, pnlUsdt: 1, closedAt: 1,
          },
        },
      )
      console.log(`✅ Reopened original ${original._id} — LONG $${entry} qty=${qty} lev=${lev}x SL=$${slPrice.toFixed(6)}`)
    } else if (original.status === "OPEN") {
      console.log(`✅ Original already OPEN — no update needed`)
    } else {
      console.log(`⚠️  Cannot reopen — no Binance position found`)
    }
  } else {
    console.log("\n[DRY RUN] No changes made.")
    for (const d of duplicates) {
      console.log(`  Would delete: ${d._id}`)
    }
    if (binancePos && original.status === "CLOSED") {
      console.log(`  Would reopen: ${original._id}`)
    }
  }

  console.log("\n=== Done ===")
  await client.close()
}

main().catch((err) => {
  console.error("Script error:", err)
  process.exit(1)
})
