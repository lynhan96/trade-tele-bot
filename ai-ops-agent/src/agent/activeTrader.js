import { getPrices } from "../utils/redis.js"
import { getDb } from "../utils/db.js"
import { buildMemoryContext, saveDecision, saveLearning } from "../utils/memory.js"
import { closeSignal, updateSignal, updateTradingConfig, getDashboard } from "../actions/adminApi.js"
import { logger } from "../utils/logger.js"
import * as agentLog from "../utils/agentLogger.js"
import { execSync } from "child_process"

const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"

export async function runActiveTrader() {
  const db = await getDb()

  // ═══ 1. Collect FULL context (prices from Redis, signals, orders, on-chain) ═══
  const context = await collectFullContext(db)
  if (!context.activePositions.length) {
    logger.info("[Trader] No active positions")
    return []
  }

  // ═══ 2. Claude decides ═══
  const prompt = buildTraderPrompt(context)
  logger.info(`[Trader] ${context.activePositions.length} positions | Asking Claude...`)
  await agentLog.thought("active_trader", `Phân tích ${context.activePositions.length} vị thế | Wallet: $${context.stats.wallet}`, context.stats)

  let decisions
  try {
    // Remove ANTHROPIC_API_KEY from env so Claude CLI uses OAuth (Pro plan) instead of expired API key
    const cleanEnv = { ...process.env, HOME: "/home/ubuntu" }
    delete cleanEnv.ANTHROPIC_API_KEY
    const output = execSync(
      `${NVM}claude --print ${JSON.stringify(prompt)}`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 3 * 60 * 1000, env: cleanEnv }
    )
    decisions = parseResponse(output)
  } catch (err) {
    const stderr = err.stderr?.toString?.()?.slice(0, 300) || ""
    const stdout = err.stdout?.toString?.()?.slice(0, 300) || ""
    logger.error(`[Trader] Claude failed: ${err.message?.slice(0, 200)}`)
    if (stderr) logger.error(`[Trader] stderr: ${stderr}`)
    if (stdout) logger.error(`[Trader] stdout: ${stdout}`)
    return []
  }

  // ═══ 3. Execute decisions ═══
  const results = []
  for (const d of (decisions || [])) {
    if (d.action === "NO_ACTION") {
      logger.info(`[Trader] Hold: ${d.reason}`)
      saveDecision({ ...d, outcome: "hold" })
      continue
    }
    try {
      const result = await executeTradeAction(d, db)
      saveDecision({ ...d, outcome: result.ok ? "success" : "failed", details: result.message })
      results.push(result)
      logger.info(`[Trader] ✅ ${d.action}: ${result.message}`)
      await agentLog.action("active_trader", result.message, d.action, d.data?.symbol, { ok: result.ok })
    } catch (err) {
      saveDecision({ ...d, outcome: "error", details: err.message })
      logger.error(`[Trader] ❌ ${d.action}: ${err.message}`)
    }
  }

  return results
}

async function collectFullContext(db) {
  // ── Active signals with LIVE prices from Redis ──
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const positions = []

  // Batch get all prices from Redis
  const symbols = active.map(s => s.symbol)
  const livePrices = await getPrices(symbols)

  for (const s of active) {
    const livePrice = livePrices[s.symbol] || 0
    const entry = s.gridAvgEntry || s.entryPrice
    const mainPnlPct = livePrice && entry ? (
      s.direction === "LONG"
        ? ((livePrice - entry) / entry * 100)
        : ((entry - livePrice) / entry * 100)
    ) : 0
    const mainPnlUsdt = (mainPnlPct / 100) * (s.simNotional || 1000)

    // Hedge info
    let hedgePnlPct = 0, hedgePnlUsdt = 0
    if (s.hedgeActive && s.hedgeEntryPrice && livePrice) {
      hedgePnlPct = s.hedgeDirection === "LONG"
        ? ((livePrice - s.hedgeEntryPrice) / s.hedgeEntryPrice * 100)
        : ((s.hedgeEntryPrice - livePrice) / s.hedgeEntryPrice * 100)
      hedgePnlUsdt = (hedgePnlPct / 100) * (s.hedgeSimNotional || 750)
    }

    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
    const totalPnl = mainPnlUsdt + hedgePnlUsdt + banked

    positions.push({
      id: s._id.toString(),
      symbol: s.symbol,
      direction: s.direction,
      strategy: s.strategy,
      entry: +entry.toFixed(6),
      livePrice: +livePrice.toFixed(6),
      tp: s.takeProfitPrice,
      mainPnlPct: +mainPnlPct.toFixed(2),
      mainPnlUsdt: +mainPnlUsdt.toFixed(2),
      hedgeActive: s.hedgeActive || false,
      hedgeDirection: s.hedgeDirection,
      hedgeEntry: s.hedgeEntryPrice,
      hedgePnlPct: +hedgePnlPct.toFixed(2),
      hedgePnlUsdt: +hedgePnlUsdt.toFixed(2),
      hedgeCycles: s.hedgeCycleCount || 0,
      banked: +banked.toFixed(2),
      totalPnl: +totalPnl.toFixed(2),
      confidence: s.aiConfidence,
      openedAt: s.executedAt
    })
  }

  // ── Recent closed orders (last 10) ──
  const recentClosed = await db.collection("orders").find({ status: "CLOSED" })
    .sort({ closedAt: -1 }).limit(10).toArray()
  const recentInfo = recentClosed.map(o => ({
    symbol: o.symbol, type: o.type, direction: o.direction,
    pnl: +(o.pnlUsdt || 0).toFixed(2), reason: o.closeReason
  }))

  // ── On-chain latest ──
  const onchain = await db.collection("onchain_snapshots").find()
    .sort({ snapshotAt: -1 }).limit(10).toArray()
  const onchainInfo = onchain.map(s => ({
    symbol: s.symbol?.replace("USDT", ""),
    signal: s.direction, score: s.score,
    fr: s.fundingRatePct, longPct: s.longPercent, taker: s.takerBuyRatio
  }))

  // ── Overall stats ──
  const allClosed = await db.collection("orders").find({ status: "CLOSED" }).toArray()
  let mainPnl = 0, hedgePnl = 0, wins = 0, losses = 0
  for (const o of allClosed) {
    if (o.type === "HEDGE") hedgePnl += (o.pnlUsdt || 0)
    else { mainPnl += (o.pnlUsdt || 0); if ((o.pnlUsdt || 0) > 0) wins++; else losses++ }
  }

  // ── Memory ──
  const memory = buildMemoryContext()

  return {
    activePositions: positions,
    recentClosed: recentInfo,
    onchain: onchainInfo,
    stats: {
      wallet: +(1000 + mainPnl + hedgePnl).toFixed(2),
      mainPnl: +mainPnl.toFixed(2),
      hedgePnl: +hedgePnl.toFixed(2),
      winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
      totalPositions: positions.length,
      unrealizedPnl: +positions.reduce((s, p) => s + p.totalPnl, 0).toFixed(2)
    },
    memory
  }
}

function buildTraderPrompt(ctx) {
  return `You are an autonomous AI trader managing live Binance Futures positions.
You have FULL authority to close signals and manage hedges via API.

═══ RULES ═══
1. TAKE PROFIT: Close winning positions when:
   - PnL > +3% and on-chain shows reversal (opposing taker flow, extreme L/S)
   - PnL > +5% regardless (lock in profit)
   - Hedge is winning but main is recovering → close hedge to bank profit

2. MANAGE HEDGE:
   - If main losing > -3% and no hedge → hedge should auto-trigger (system handles)
   - If hedge profitable > +2% and main recovering → recommend close hedge via API
   - If banked > main loss → NET_POSITIVE, close all

3. FLIP DECISION:
   - If main near TP and hedge active → let system FLIP automatically
   - If market reversed strongly → recommend closing main, keeping hedge

4. DO NOT CLOSE losing positions — hedge system manages those
5. Max 3 actions per cycle. Be conservative.
6. Learn from past decisions in memory.

═══ RESPONSE (JSON only, no markdown) ═══
{"analysis":"Vietnamese market assessment","decisions":[{"action":"CLOSE_SIGNAL|CLOSE_HEDGE|UPDATE_CONFIG|LEARNING|NO_ACTION","signalId":"xxx","reason":"Vietnamese explanation","data":{}}],"learnings":[{"key":"unique_key","insight":"pattern observed"}]}

═══ ACTIONS ═══
- CLOSE_SIGNAL: Close signal by ID (takes profit or cuts position)
- CLOSE_HEDGE: Close hedge for signal (bank hedge profit, keep main)
- UPDATE_CONFIG: Change trading config parameter
- LEARNING: Save insight for future reference
- NO_ACTION: Hold all positions, explain why

═══ LIVE POSITIONS ═══
${JSON.stringify(ctx.activePositions, null, 2)}

═══ STATS ═══
${JSON.stringify(ctx.stats)}

═══ RECENT CLOSED ═══
${JSON.stringify(ctx.recentClosed)}

═══ ON-CHAIN ═══
${JSON.stringify(ctx.onchain)}

═══ MEMORY ═══
${ctx.memory || "No history yet — first cycle"}

Analyze each position and decide:`
}

function parseResponse(output) {
  try {
    const jsonMatch = output.match(/\{[\s\S]*"decisions"[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn("[Trader] No JSON in Claude response")
      return []
    }
    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.learnings?.length) {
      parsed.learnings.forEach(l => saveLearning(l))
    }
    if (parsed.analysis) {
      logger.info(`[Trader] Analysis: ${parsed.analysis.slice(0, 200)}`)
      agentLog.decision("active_trader", parsed.analysis)
    }
    return parsed.decisions || []
  } catch (err) {
    logger.error(`[Trader] Parse failed: ${err.message}`)
    return []
  }
}

async function executeTradeAction(decision, db) {
  switch (decision.action) {
    case "CLOSE_SIGNAL": {
      const id = decision.signalId || decision.data?.signalId
      if (!id) return { ok: false, message: "No signal ID" }
      const result = await closeSignal(id)
      return { ok: !!result, message: `Closed signal ${decision.data?.symbol || id}` }
    }

    case "CLOSE_HEDGE": {
      // Close hedge by updating signal to force hedge close on next tick
      const id = decision.signalId || decision.data?.signalId
      if (!id) return { ok: false, message: "No signal ID" }
      // Set hedgeTpPrice to current price to trigger TP on next tick
      const sig = await db.collection("ai_signals").findOne({ _id: new (await import("mongodb")).ObjectId(id) })
      if (!sig || !sig.hedgeActive) return { ok: false, message: "No active hedge" }
      // Force hedge close by setting TP to current hedge price
      await db.collection("ai_signals").updateOne(
        { _id: sig._id },
        { $set: { hedgeTpPrice: sig.hedgeDirection === "LONG" ? 0 : 999999 } }
      )
      return { ok: true, message: `Hedge close triggered for ${sig.symbol}` }
    }

    case "UPDATE_CONFIG": {
      const field = decision.data?.field
      const value = decision.data?.value
      if (!field) return { ok: false, message: "No field" }
      const result = await updateTradingConfig({ [field]: value })
      return { ok: !!result, message: `Config ${field}=${value}` }
    }

    case "LEARNING":
      return { ok: true, message: `Learned: ${decision.reason}` }

    case "NO_ACTION":
      return { ok: true, message: `Hold: ${decision.reason}` }

    default:
      return { ok: false, message: `Unknown action: ${decision.action}` }
  }
}
