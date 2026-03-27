import { getPrices } from "../utils/redis.js"
import { getDb } from "../utils/db.js"
import { logger } from "../utils/logger.js"
import { createClient } from "redis"

let redisClient = null

async function getRedis() {
  if (redisClient?.isOpen) return redisClient
  redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`,
    database: parseInt(process.env.REDIS_DB || "2")
  })
  redisClient.on("error", () => {})
  await redisClient.connect()
  return redisClient
}

async function getRedisJSON(key) {
  try {
    const redis = await getRedis()
    const val = await redis.get(`binance-bot:${key}`)
    return val ? JSON.parse(val) : null
  } catch { return null }
}

async function getRedisVal(key) {
  try {
    const redis = await getRedis()
    return await redis.get(`binance-bot:${key}`)
  } catch { return null }
}

export async function collectMarketContext() {
  const ctx = {}

  // 1. BTC price + trend
  const btcPrice = await getRedisVal("price:BTCUSDT")
  const ethPrice = await getRedisVal("price:ETHUSDT")
  ctx.btc = { price: btcPrice ? parseFloat(btcPrice) : 0 }
  ctx.eth = { price: ethPrice ? parseFloat(ethPrice) : 0 }

  // 2. Market regime (stored as plain string in Redis, e.g. "STRONG_BEAR")
  const regimeRaw = await getRedisJSON("cache:ai:regime")
  ctx.regime = typeof regimeRaw === "string" ? regimeRaw : (regimeRaw?.regime || "UNKNOWN")
  ctx.regimeBias = typeof regimeRaw === "object" ? (regimeRaw?.bias || "NEUTRAL") : "NEUTRAL"

  // 3. Market analysis (alt pulse, sentiment)
  const analysis = await getRedisJSON("cache:ai:market-analysis")
  if (analysis) {
    ctx.altPulse = {
      green4h: analysis.altPulse?.green4hPct,
      green1h: analysis.altPulse?.green1hPct,
      avgChange4h: analysis.altPulse?.avgChange4h,
      signal: analysis.altPulse?.signal, // BULLISH, BEARISH, NEUTRAL
    }
    ctx.marketSummary = analysis.summary?.slice(0, 200)
  }

  // 4. Market guard (confidence floor, risk level)
  const guard = await getRedisJSON("cache:ai:market-guard")
  if (guard) {
    ctx.marketGuard = {
      confidenceFloor: guard.confidenceFloor,
      riskLevel: guard.riskLevel, // LOW, MODERATE, HIGH
      maxActiveSignals: guard.maxActiveSignals,
    }
  }

  // 5. On-chain latest (from MongoDB)
  try {
    const db = await getDb()
    const snaps = await db.collection("onchain_snapshots").find()
      .sort({ snapshotAt: -1 }).limit(10).toArray()
    ctx.onchain = snaps.map(s => ({
      symbol: s.symbol?.replace("USDT", ""),
      signal: s.direction, // LONG_BIAS, SHORT_BIAS, NEUTRAL
      score: s.score,
      fr: s.fundingRatePct,
      longPct: s.longPercent,
      taker: s.takerBuyRatio,
    }))

    // Market-wide sentiment
    const bullish = snaps.filter(s => s.score > 15).length
    const bearish = snaps.filter(s => s.score < -15).length
    ctx.onchainSentiment = bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL"
    ctx.onchainDetail = `${bullish} bull, ${bearish} bear, ${snaps.length - bullish - bearish} neutral`
  } catch {}

  // 6. Funding rate summary
  if (ctx.onchain?.length) {
    const avgFR = ctx.onchain.reduce((s, c) => s + (c.fr || 0), 0) / ctx.onchain.length
    const avgLongPct = ctx.onchain.reduce((s, c) => s + (c.longPct || 50), 0) / ctx.onchain.length
    ctx.fundingSummary = {
      avgFR: +avgFR.toFixed(4),
      avgLongPct: +avgLongPct.toFixed(1),
      extreme: avgFR > 0.05 ? "HIGH_LONG" : avgFR < -0.05 ? "HIGH_SHORT" : "NORMAL",
    }
  }

  // 7. Trading config current state
  const tradingCfg = await getRedisJSON("cache:ai:trading-config")
  if (tradingCfg) {
    ctx.tradingConfig = {
      hedgeEnabled: tradingCfg.hedgeEnabled,
      slMin: tradingCfg.slMin,
      slMax: tradingCfg.slMax,
      tpMin: tradingCfg.tpMin,
      tpMax: tradingCfg.tpMax,
      trailTrigger: tradingCfg.trailTrigger,
    }
  }

  logger.info(`[Market] BTC: $${ctx.btc.price} | Regime: ${ctx.regime} | Sentiment: ${ctx.onchainSentiment || "?"}`)
  return ctx
}
