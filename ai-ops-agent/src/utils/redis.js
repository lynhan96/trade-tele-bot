import { createClient } from "redis"
import { logger } from "./logger.js"

let client = null

async function getRedis() {
  if (client?.isOpen) return client
  client = createClient({
    url: `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`,
    database: parseInt(process.env.REDIS_DB || "2")
  })
  client.on("error", () => {})
  await client.connect()
  return client
}

export async function getPrice(symbol) {
  try {
    const redis = await getRedis()
    const val = await redis.get(`binance-bot:price:${symbol}`)
    return val ? parseFloat(val) : 0
  } catch {
    return 0
  }
}

export async function getPrices(symbols) {
  const prices = {}
  try {
    const redis = await getRedis()
    for (const sym of symbols) {
      const val = await redis.get(`binance-bot:price:${sym}`)
      if (val) prices[sym] = parseFloat(val)
    }
  } catch {}
  return prices
}
