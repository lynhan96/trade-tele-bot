import axios from "axios"
import { execSync } from "child_process"
import http from "http"
import { getDb } from "../utils/db.js"
import { collectMarketContext } from "../utils/marketContext.js"
import { getPrices } from "../utils/redis.js"
import { closeSignal, forceOpenHedge, forceCloseHedge, updateTradingConfig } from "../actions/adminApi.js"
import { buildMemoryContext } from "../utils/memory.js"
import * as agentLog from "../utils/agentLogger.js"
import { logger } from "../utils/logger.js"

const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"
const TG_TOKEN = () => process.env.AGENT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID
const PORT = parseInt(process.env.TELEGRAM_WEBHOOK_PORT || "8443")
const MAX_HISTORY = 20

// Conversation history — persists across messages
const chatHistory = []

function addToHistory(role, content) {
  chatHistory.push({ role, content: content.slice(0, 500), ts: new Date().toISOString() })
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift()
}

function getHistoryContext() {
  if (!chatHistory.length) return "No conversation history"
  return chatHistory.map(h => `[${h.ts.slice(11, 16)}] ${h.role}: ${h.content}`).join("\n")
}

async function sendTg(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }, { timeout: 10000 })
  } catch (err) {
    // Retry without markdown
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
        chat_id: chatId,
        text: text.replace(/[_*`\[\]]/g, ""),
      }, { timeout: 10000 })
    } catch {}
  }
}

async function buildContext(userMessage) {
  const db = await getDb()
  const market = await collectMarketContext()

  // Active signals
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const symbols = active.map(s => s.symbol)
  const prices = await getPrices(symbols)

  const positions = active.map(s => {
    const entry = s.gridAvgEntry || s.entryPrice
    const price = prices[s.symbol] || 0
    const pnl = s.direction === "LONG"
      ? ((price - entry) / entry * 100)
      : ((entry - price) / entry * 100)
    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
    return {
      id: s._id.toString(), symbol: s.symbol, direction: s.direction,
      entry: +entry.toFixed(6), price: +price.toFixed(6),
      pnlPct: +pnl.toFixed(2), pnlUsdt: +(pnl / 100 * (s.simNotional || 1000)).toFixed(2),
      hedge: s.hedgeActive || false, hedgeCycles: s.hedgeCycleCount || 0,
      banked: +banked.toFixed(2), strategy: s.strategy,
    }
  })

  // Stats
  const closed = await db.collection("orders").find({ status: "CLOSED" }).toArray()
  let mainPnl = 0, hedgePnl = 0, wins = 0, losses = 0
  for (const o of closed) {
    if (o.type === "HEDGE") hedgePnl += (o.pnlUsdt || 0)
    else { mainPnl += (o.pnlUsdt || 0); if ((o.pnlUsdt || 0) > 0) wins++; else losses++ }
  }

  const memory = buildMemoryContext()

  return `You are an AI trading assistant. Answer the user's question using the data below.
You can also execute actions if the user asks:
- Close a winning signal: respond with ACTION:CLOSE_SIGNAL:signalId
- Open hedge: respond with ACTION:OPEN_HEDGE:signalId
- Close hedge: respond with ACTION:CLOSE_HEDGE:signalId
- Update config: respond with ACTION:UPDATE_CONFIG:field:value

IMPORTANT:
- Respond in Vietnamese
- Be concise (max 500 chars for Telegram)
- If user asks to close a LOSING position, REFUSE and explain hedge will manage
- Include signal IDs when referencing positions so user can act

== POSITIONS ==
${JSON.stringify(positions, null, 1)}

== STATS ==
Wallet: $${(1000 + mainPnl + hedgePnl).toFixed(2)} | WR: ${wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : 0}%
Main PnL: $${mainPnl.toFixed(2)} | Hedge PnL: $${hedgePnl.toFixed(2)}
Open: ${positions.length} signals | W: ${wins} L: ${losses}

== MARKET ==
${JSON.stringify(market, null, 1)}

== MEMORY ==
${memory || "Empty"}

== CONVERSATION HISTORY ==
${getHistoryContext()}

== USER MESSAGE ==
${userMessage}`
}

async function handleMessage(chatId, text) {
  if (String(chatId) !== String(CHAT_ID())) {
    logger.warn(`[TgChat] Unauthorized chat: ${chatId}`)
    return
  }

  addToHistory("user", text)
  await sendTg(chatId, "🤖 _Đang phân tích..._")
  await agentLog.thought("active_trader", `User hỏi: ${text.slice(0, 50)}`)

  try {
    const prompt = await buildContext(text)
    const output = execSync(
      `${NVM}claude --print ${JSON.stringify(prompt)}`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 90000, env: { ...process.env, HOME: "/home/ubuntu" } }
    )

    // Check for action commands in response
    const actions = output.match(/ACTION:(CLOSE_SIGNAL|OPEN_HEDGE|CLOSE_HEDGE|UPDATE_CONFIG):([^\n]+)/g) || []
    for (const action of actions) {
      const [, type, target] = action.match(/ACTION:(\w+):(.+)/) || []
      if (type === "CLOSE_SIGNAL") await closeSignal(target.trim())
      else if (type === "OPEN_HEDGE") await forceOpenHedge(target.trim())
      else if (type === "CLOSE_HEDGE") await forceCloseHedge(target.trim())
      else if (type === "UPDATE_CONFIG") {
        const [field, value] = target.split(":")
        await updateTradingConfig({ [field.trim()]: isNaN(value) ? value.trim() : parseFloat(value) })
      }
      await agentLog.action("active_trader", `Executed ${type} ${target}`, type)
    }

    // Clean response (remove ACTION lines)
    const cleanResponse = output.replace(/ACTION:[^\n]+\n?/g, "").trim().slice(0, 4000)
    addToHistory("agent", cleanResponse.slice(0, 500))
    await sendTg(chatId, cleanResponse || "Không có gì để báo cáo.")
    await agentLog.decision("active_trader", `Trả lời user: ${cleanResponse.slice(0, 100)}`)
  } catch (err) {
    logger.error(`[TgChat] Error: ${err.message?.slice(0, 200)}`)
    await sendTg(chatId, `❌ Lỗi: ${err.message?.slice(0, 100)}`)
  }
}

export function startTelegramChat() {
  // Use long polling instead of webhook (no HTTPS needed)
  let lastUpdateId = 0

  async function poll() {
    try {
      const { data } = await axios.get(
        `https://api.telegram.org/bot${TG_TOKEN()}/getUpdates`,
        { params: { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ["message", "callback_query"] }, timeout: 35000 }
      )

      for (const update of data.result || []) {
        lastUpdateId = update.update_id

        if (update.message?.text) {
          const chatId = update.message.chat.id
          const text = update.message.text
          // Only respond to admin chat + agent-relevant messages
          if (String(chatId) === String(CHAT_ID())) {
            handleMessage(chatId, text).catch(err =>
              logger.error(`[TgChat] Handle error: ${err.message}`)
            )
          }
        }

        if (update.callback_query) {
          const cb = update.callback_query
          await axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/answerCallbackQuery`, {
            callback_query_id: cb.id
          }).catch(() => {})
          if (cb.data === "restart") {
            execSync(`${NVM}pm2 restart trade-tele-bot`, { timeout: 30000 })
            await sendTg(cb.message.chat.id, "✅ Bot restarted")
          }
        }
      }
    } catch (err) {
      if (!err.message?.includes("timeout")) {
        logger.warn(`[TgChat] Poll error: ${err.message?.slice(0, 100)}`)
      }
    }
    // Continue polling
    setTimeout(poll, 1000)
  }

  // Delete any existing webhook first
  axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/deleteWebhook`)
    .then(() => {
      logger.info("[TgChat] Polling started — send any message to chat with agent")
      poll()
    })
    .catch(() => poll())
}
