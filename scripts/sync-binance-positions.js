/**
 * Sync open Binance positions → UserTrade DB records.
 *
 * Use when a position is OPEN on Binance but CLOSED/missing in our DB
 * (e.g. bot crash, manual close error, DB desync).
 *
 * What it does:
 * 1. Finds all real-mode users with Binance API keys
 * 2. Fetches their open positions from Binance
 * 3. Compares with OPEN UserTrade records in DB
 * 4. Creates missing records (so protectOpenTrades + checkOrphanHedges can manage them)
 * 5. Links to active signal (aiSignalId) if found
 *
 * Usage:
 *   node scripts/sync-binance-positions.js
 *   node scripts/sync-binance-positions.js --dry-run     (preview only)
 *   node scripts/sync-binance-positions.js --symbol 4USDT  (filter symbol)
 */

const { MongoClient } = require("mongodb")
const crypto = require("crypto")
const https = require("https")
require("dotenv").config()

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/binance-telebot"
const DRY_RUN = process.argv.includes("--dry-run")
const SYMBOL_FILTER = (() => {
  const idx = process.argv.indexOf("--symbol")
  if (idx !== -1 && process.argv[idx + 1]) {
    const s = process.argv[idx + 1].toUpperCase()
    return s.endsWith("USDT") ? s : s + "USDT"
  }
  return null
})()

// ─── Binance API helpers ────────────────────────────────────────────────────

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex")
}

function binanceGet(path, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now()
    const qs = `timestamp=${timestamp}`
    const signature = sign(qs, apiSecret)
    const url = `https://fapi.binance.com${path}?${qs}&signature=${signature}`

    const options = {
      headers: { "X-MBX-APIKEY": apiKey },
    }

    https.get(url, options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.code && parsed.code < 0) reject(new Error(parsed.msg))
          else resolve(parsed)
        } catch (e) {
          reject(e)
        }
      })
    }).on("error", reject)
  })
}

async function getOpenPositions(apiKey, apiSecret) {
  const positions = await binanceGet("/fapi/v2/positionRisk", apiKey, apiSecret)
  return positions
    .filter((p) => Math.abs(parseFloat(p.positionAmt)) > 0)
    .map((p) => ({
      symbol: p.symbol,
      direction: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
      quantity: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      leverage: parseInt(p.leverage),
      notionalUsdt: Math.abs(parseFloat(p.positionAmt)) * parseFloat(p.entryPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
    }))
}

async function getAlgoOrders(apiKey, apiSecret) {
  try {
    const orders = await binanceGet("/fapi/v1/openAlgoOrders", apiKey, apiSecret)
    return orders.orders || []
  } catch {
    return []
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db()

  console.log(`\n=== Binance Position Sync${DRY_RUN ? " (DRY RUN)" : ""} ===`)
  if (SYMBOL_FILTER) console.log(`Filter: ${SYMBOL_FILTER}`)
  console.log()

  // Get all real-mode subscriptions
  const subs = await db.collection("user_signal_subscriptions")
    .find({ realModeEnabled: true, isActive: true })
    .toArray()

  if (subs.length === 0) {
    console.log("No real-mode subscribers found.")
    await client.close()
    return
  }
  console.log(`Found ${subs.length} real-mode subscriber(s).\n`)

  for (const sub of subs) {
    const { telegramId, chatId } = sub
    console.log(`─── User ${telegramId} ─────────────────────────────`)

    // Get API keys
    const settings = await db.collection("user_settings").findOne({ telegramId })
    if (!settings?.binance?.apiKey) {
      console.log(`  No Binance API keys — skip\n`)
      continue
    }
    const { apiKey, apiSecret } = settings.binance

    // Fetch open positions from Binance
    let binancePositions
    try {
      binancePositions = await getOpenPositions(apiKey, apiSecret)
    } catch (err) {
      console.log(`  Binance API error: ${err.message} — skip\n`)
      continue
    }

    if (SYMBOL_FILTER) {
      binancePositions = binancePositions.filter((p) => p.symbol === SYMBOL_FILTER)
    }

    if (binancePositions.length === 0) {
      console.log(`  No open positions on Binance\n`)
      continue
    }

    // Fetch algo orders (for SL/TP IDs)
    const algoOrders = await getAlgoOrders(apiKey, apiSecret)
    const slBySymbol = {}
    const tpBySymbol = {}
    for (const o of algoOrders) {
      const sym = o.symbol
      const isStop = o.algoType === "VP" || o.side === "SELL" && o.type?.includes("STOP")
      if (o.algoType === "STOP" || o.type?.includes("STOP_MARKET")) {
        slBySymbol[sym] = slBySymbol[sym] || []
        slBySymbol[sym].push(o.algoId?.toString() || o.orderId?.toString())
      }
      if (o.algoType === "TP" || o.type?.includes("TAKE_PROFIT")) {
        tpBySymbol[sym] = tpBySymbol[sym] || []
        tpBySymbol[sym].push(o.algoId?.toString() || o.orderId?.toString())
      }
    }

    // Get existing OPEN UserTrade records for this user
    const existingTrades = await db.collection("user_trades")
      .find({ telegramId, status: "OPEN" })
      .toArray()
    const existingKeys = new Set(existingTrades.map((t) => `${t.symbol}:${t.direction}`))

    for (const pos of binancePositions) {
      const posKey = `${pos.symbol}:${pos.direction}`
      const isHedgePos = existingTrades.some(
        (t) => t.symbol === pos.symbol && t.direction === pos.direction && t.isHedge === true,
      )

      if (existingKeys.has(posKey)) {
        const existing = existingTrades.find((t) => t.symbol === pos.symbol && t.direction === pos.direction)
        const pnlPct = pos.direction === "LONG"
          ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100
        console.log(
          `  ✅ ${pos.symbol} ${pos.direction}: already in DB (qty=${pos.quantity}, PnL=${pnlPct.toFixed(2)}%)`,
        )
        continue
      }

      // Missing from DB — find associated active signal
      const activeSignal = await db.collection("ai_signals").findOne({
        symbol: pos.symbol, status: "ACTIVE",
      })

      const pnlPct = pos.direction === "LONG"
        ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100

      // Compute SL price (40% safety net from entry)
      const slPrice = pos.direction === "LONG"
        ? pos.entryPrice * 0.60
        : pos.entryPrice * 1.40

      const slAlgoId = slBySymbol[pos.symbol]?.[0] || null
      const tpAlgoId = tpBySymbol[pos.symbol]?.[0] || null

      // Detect if this is a hedge: same symbol, opposite direction also missing from DB,
      // and this direction is opposite to the active signal direction
      const signalDir = activeSignal?.direction
      const isHedge = signalDir && pos.direction !== signalDir
      // If both directions missing for same symbol, main = matches signal dir, hedge = opposite
      const oppositeDir = pos.direction === "LONG" ? "SHORT" : "LONG"
      const oppositeExistsOnBinance = binancePositions.some(
        (p) => p.symbol === pos.symbol && p.direction === oppositeDir,
      )
      const oppositeAlreadyInDb = existingKeys.has(`${pos.symbol}:${oppositeDir}`)

      console.log(
        `  🆕 ${pos.symbol} ${pos.direction}${isHedge ? " [HEDGE]" : " [MAIN]"}: MISSING from DB — creating trade record`,
      )
      console.log(
        `     Entry: $${pos.entryPrice} | Qty: ${pos.quantity} | Notional: $${pos.notionalUsdt.toFixed(2)} | Lev: ${pos.leverage}x`,
      )
      console.log(
        `     PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | SL: $${slPrice.toFixed(4)} (40% safety)`,
      )
      console.log(`     Signal: ${activeSignal ? activeSignal._id + " dir=" + activeSignal.direction : "none (orphan)"}`)

      if (!DRY_RUN) {
        let parentTradeId = null
        if (isHedge) {
          const mainTrade = await db.collection("user_trades").findOne({
            telegramId, symbol: pos.symbol, direction: signalDir, status: "OPEN",
          })
          parentTradeId = mainTrade?._id?.toString() || null
        }

        // Try to find an existing CLOSED record to reopen (prevents duplicates)
        const existingClosed = await db.collection("user_trades").findOne(
          { telegramId, symbol: pos.symbol, direction: pos.direction, status: "CLOSED" },
          { sort: { closedAt: -1 } },
        )

        if (existingClosed) {
          // Reopen existing CLOSED record — update with current Binance state
          await db.collection("user_trades").updateOne(
            { _id: existingClosed._id },
            {
              $set: {
                status: "OPEN",
                entryPrice: pos.entryPrice,
                quantity: pos.quantity,
                leverage: pos.leverage,
                notionalUsdt: pos.notionalUsdt,
                slPrice: isHedge ? 0 : slPrice,
                tpPrice: isHedge ? (activeSignal?.takeProfitPrice ? pos.entryPrice * (signalDir === "LONG" ? 0.97 : 1.03) : 0) : (activeSignal?.takeProfitPrice || 0),
                binanceSlAlgoId: isHedge ? null : slAlgoId,
                binanceTpAlgoId: tpAlgoId,
                aiSignalId: activeSignal?._id?.toString() || existingClosed.aiSignalId || null,
                isHedge: !!isHedge,
                parentTradeId,
                syncedFromBinance: true,
                openedAt: new Date(),
                updatedAt: new Date(),
              },
              $unset: {
                closeReason: 1, exitPrice: 1, pnlPercent: 1, pnlUsdt: 1, closedAt: 1,
              },
            },
          )
          console.log(`     ✅ Reopened existing CLOSED record ${existingClosed._id} (isHedge=${!!isHedge})`)
        } else {
          // No existing record — insert new
          const tradeDoc = {
            telegramId,
            chatId,
            symbol: pos.symbol,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            quantity: pos.quantity,
            leverage: pos.leverage,
            notionalUsdt: pos.notionalUsdt,
            slPrice: isHedge ? 0 : slPrice,
            tpPrice: isHedge ? (activeSignal?.takeProfitPrice ? pos.entryPrice * (signalDir === "LONG" ? 0.97 : 1.03) : 0) : (activeSignal?.takeProfitPrice || 0),
            binanceSlAlgoId: isHedge ? null : slAlgoId,
            binanceTpAlgoId: tpAlgoId,
            status: "OPEN",
            openedAt: new Date(),
            aiSignalId: activeSignal?._id?.toString() || null,
            isHedge: !!isHedge,
            parentTradeId,
            hedgeCycle: isHedge ? 1 : undefined,
            syncedFromBinance: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          await db.collection("user_trades").insertOne(tradeDoc)
          console.log(`     ✅ Inserted new UserTrade record (isHedge=${!!isHedge})`)
        }

        if (!isHedge && !slAlgoId) {
          console.log(
            `     ⚠️  No SL algo order found on Binance — protectOpenTrades will place one within 1 min`,
          )
        }
      } else {
        console.log(`     [DRY RUN] Would ${existingKeys.has ? "reopen" : "insert"} UserTrade record (isHedge=${!!isHedge})`)
      }
    }

    // Also check: any DB OPEN trades for this user that are NOT on Binance
    for (const trade of existingTrades) {
      const onBinance = binancePositions.some(
        (p) => p.symbol === trade.symbol && p.direction === trade.direction,
      )
      if (!onBinance && !SYMBOL_FILTER) {
        console.log(
          `  ⚠️  ${trade.symbol} ${trade.direction}: in DB as OPEN but NOT on Binance — protectOpenTrades will close it`,
        )
      }
    }

    console.log()
  }

  console.log("=== Done ===")
  if (DRY_RUN) console.log("(Dry run — no changes made. Remove --dry-run to apply.)")
  await client.close()
}

main().catch((err) => {
  console.error("Script error:", err)
  process.exit(1)
})
