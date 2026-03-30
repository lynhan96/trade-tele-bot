/**
 * AI System Review — Claude analyzes full system health every 6h
 * Sends detailed report to Telegram
 */
import { collectMarketContext } from "../utils/marketContext.js"
import { getPrices } from "../utils/redis.js"
import { getDb } from "../utils/db.js"
import { getLastSkillResults } from "../actions/skills.js"
import { getTradingConfig } from "../actions/adminApi.js"
import { logger } from "../utils/logger.js"
import { execSync } from "child_process"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import axios from "axios"

const NVM = 'export NVM_DIR="/home/ubuntu/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '

const sendTelegram = (text) =>
  axios.post(`https://api.telegram.org/bot${process.env.AGENT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: "HTML",
    text,
  }).catch(e => logger.error(`Telegram: ${e.message}`))

export async function runAiReview() {
  try {
    const db = await getDb()
    const market = await collectMarketContext()
    const config = await getTradingConfig().catch(() => null)
    const skillResults = getLastSkillResults()

    // Gather data
    const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
    const completed = await db.collection("ai_signals").find({ status: "COMPLETED", pnlUsdt: { $exists: true } })
      .sort({ positionClosedAt: -1 }).limit(50).toArray()
    const prices = await getPrices(active.map(s => s.symbol))
    const closedTrades = await db.collection("user_trades").find({ status: "CLOSED" })
      .sort({ closedAt: -1 }).limit(50).toArray()
    const openTrades = await db.collection("user_trades").find({ status: "OPEN" }).toArray()

    // Calculate stats
    const simWins = completed.filter(s => (s.pnlUsdt || 0) > 0).length
    const simLosses = completed.filter(s => (s.pnlUsdt || 0) <= 0).length
    const simPnl = completed.reduce((s, x) => s + (x.pnlUsdt || 0), 0)
    const realWins = closedTrades.filter(t => (t.pnlUsdt || 0) > 0).length
    const realLosses = closedTrades.filter(t => (t.pnlUsdt || 0) <= 0).length
    const realPnl = closedTrades.reduce((s, t) => s + (t.pnlUsdt || 0), 0)

    // Active positions detail
    const posDetails = active.map(s => {
      const price = prices[s.symbol] || 0
      const entry = s.gridAvgEntry || s.entryPrice
      const pnlPct = s.direction === "LONG" ? ((price - entry) / entry * 100) : ((entry - price) / entry * 100)
      const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
      return `${s.symbol} ${s.direction}${s.hedgeActive ? "+HEDGE" : ""}: PnL ${pnlPct.toFixed(1)}% banked:$${banked.toFixed(0)} cycles:${s.hedgeCycleCount || 0}`
    }).join("\n")

    // Build prompt
    const prompt = `Bạn là SENIOR CRYPTO TRADING ANALYST. Phân tích hiệu suất hệ thống trading và đưa ra đánh giá.

=== MARKET ===
BTC: $${market.btcPrice || "?"} | Regime: ${market.regime || "?"} | Sentiment: ${market.sentiment || "?"}

=== PERFORMANCE (last 50) ===
SIM: ${completed.length} signals, ${simWins}W/${simLosses}L, WR: ${completed.length > 0 ? (simWins/completed.length*100).toFixed(0) : 0}%, PnL: $${simPnl.toFixed(0)}
REAL: ${closedTrades.length} trades, ${realWins}W/${realLosses}L, WR: ${closedTrades.length > 0 ? (realWins/closedTrades.length*100).toFixed(0) : 0}%, PnL: $${realPnl.toFixed(0)}

=== ACTIVE POSITIONS (${active.length}) ===
${posDetails || "None"}

=== REAL OPEN TRADES ===
${openTrades.map(t => `${t.symbol} ${t.direction} ${t.isHedge ? "HEDGE" : "MAIN"} entry:${t.entryPrice?.toFixed(5)}`).join("\n") || "None"}

=== CONFIG ===
${JSON.stringify(config?.config || config || {}, null, 0).slice(0, 500)}

=== SKILL FINDINGS ===
${(skillResults.allFindings || []).slice(0, 10).join("\n")}

Hãy viết BÁO CÁO NGẮN GỌN (max 500 chữ) bằng tiếng Việt:
1. 📊 HIỆU SUẤT: đánh giá WR, PnL, so sánh SIM vs REAL
2. 📈 VỊ THẾ: đánh giá các positions đang mở, risk level
3. 🏦 THỊ TRƯỜNG: nhận định BTC + altcoin, regime phù hợp chiến lược không
4. ⚠️ VẤN ĐỀ: nếu có issues cần chú ý
5. 💡 KHUYẾN NGHỊ: 2-3 actions cụ thể

Format ngắn gọn, dùng emoji, bullet points. KHÔNG dùng markdown bold/italic.`

    // Call Claude
    const tmpFile = join(tmpdir(), `review-${Date.now()}.txt`)
    let review = ""
    try {
      writeFileSync(tmpFile, prompt, "utf8")
      const env = { ...process.env, HOME: "/home/ubuntu" }
      delete env.ANTHROPIC_API_KEY
      review = execSync(
        `${NVM}cat ${tmpFile} | claude --print --model claude-sonnet-4-6`,
        { cwd: "/home/ubuntu/projects/binance-tele-bot", encoding: "utf8", timeout: 3 * 60 * 1000, env }
      ).trim()
    } catch (err) {
      logger.error(`[AIReview] Claude failed: ${err.message?.slice(0, 200)}`)
      review = "Claude analysis failed — check logs"
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }

    // Send to Telegram
    const header = `🤖 <b>AI System Review</b>\n${"━".repeat(20)}\n`
    const footer = `\n\n⏰ ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`
    const message = header + review.slice(0, 3500) + footer

    await sendTelegram(message)
    logger.info(`[AIReview] Sent to Telegram (${review.length} chars)`)

    return review
  } catch (err) {
    logger.error(`[AIReview] Error: ${err.message}`)
    return null
  }
}
