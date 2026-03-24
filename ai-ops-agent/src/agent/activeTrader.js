import { collectMarketContext } from "../utils/marketContext.js"
import { getPrices } from "../utils/redis.js"
import { getDb } from "../utils/db.js"
import { buildMemoryContext, saveDecision, saveLearning } from "../utils/memory.js"
import { updateTradingConfig } from "../actions/adminApi.js"
import { logger } from "../utils/logger.js"
import * as agentLog from "../utils/agentLogger.js"
import { execSync } from "child_process"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const NVM = 'export NVM_DIR="/home/ubuntu/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"

// ═══ ALLOWED ACTIONS — agent is ADVISOR only, no position execution ═══
const ALLOWED_ACTIONS = new Set(["UPDATE_CONFIG", "LEARNING", "NO_ACTION"])

export async function runActiveTrader() {
  const db = await getDb()

  // ═══ 1. Collect FULL context (prices from Redis, signals, orders, on-chain) ═══
  const context = await collectFullContext(db)
  if (!context.activePositions.length) {
    logger.info("[Trader] No active positions")
    return []
  }

  // ═══ 2. Claude analyzes ═══
  const prompt = buildTraderPrompt(context)
  logger.info(`[Trader] ${context.activePositions.length} positions | Asking Claude...`)
  await agentLog.thought("active_trader", `Phân tích ${context.activePositions.length} vị thế | Wallet: $${context.stats.wallet}`, context.stats)

  let decisions
  const tmpFile = join(tmpdir(), `trader-prompt-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, "utf8")
    const env = { ...process.env, HOME: "/home/ubuntu" }
    delete env.ANTHROPIC_API_KEY
    const output = execSync(
      `${NVM}cat ${tmpFile} | claude --print`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 3 * 60 * 1000, env }
    )
    decisions = parseResponse(output)
  } catch (err) {
    const stderr = err.stderr ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString()) : ''
    const stdout = err.stdout ? (typeof err.stdout === 'string' ? err.stdout : err.stdout.toString()) : ''
    logger.error(`[Trader] Claude failed (exit ${err.status}): ${stderr.slice(0, 300) || stdout.slice(0, 300) || err.message?.slice(0, 300)}`)
    return []
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }

  // ═══ 3. Execute decisions (config + learning ONLY) ═══
  const results = []
  for (const d of (decisions || []).slice(0, 3)) {
    // STRICT WHITELIST — reject any position execution attempts
    if (!ALLOWED_ACTIONS.has(d.action)) {
      logger.warn(`[Trader] REJECTED action: ${d.action} (not in whitelist)`)
      saveDecision({ ...d, outcome: "rejected", details: `Action ${d.action} not allowed` })
      await agentLog.action("active_trader", `REJECTED: ${d.action} — agent cannot execute trades`, "REJECTED", d.data?.symbol, { ok: false })
      continue
    }

    if (d.action === "NO_ACTION") {
      logger.info(`[Trader] Hold: ${d.reason}`)
      saveDecision({ ...d, outcome: "hold" })
      continue
    }

    try {
      const result = await executeAction(d)
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
  const market = await collectMarketContext()

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
    memory,
    market
  }
}

function buildTraderPrompt(ctx) {
  // Compact position format (saves ~65% tokens vs JSON.stringify pretty-print)
  const posText = ctx.activePositions.map(p =>
    `${p.symbol} ${p.direction} entry:${p.entry} price:${p.livePrice} pnl:${p.mainPnlPct}%($${p.mainPnlUsdt}) hedge:${p.hedgeActive}${p.hedgeActive ? ` hDir:${p.hedgeDirection} hEntry:${p.hedgeEntry} hPnl:${p.hedgePnlPct}%` : ''} cycles:${p.hedgeCycles} banked:$${p.banked} total:$${p.totalPnl} conf:${p.confidence} strat:${p.strategy}`
  ).join("\n")

  return `AI trading ADVISOR. CANNOT close/open positions. Bot handles TP/SL/hedge/grid automatically.
ALLOWED: UPDATE_CONFIG | LEARNING | NO_ACTION (max 3 actions)
Config fields: takeProfitPercent, stopLossPercent, hedgeThreshold, trailStopPercent, maxActiveSignals, maxExposureLeverage, minConfidence, enabledStrategies
Analyze: regime, strategy WR (<40% on 5+ → disable), hedge effectiveness, exposure, loss streaks.

POSITIONS (${ctx.activePositions.length}):
${posText}

STATS: ${JSON.stringify(ctx.stats)}
RECENT CLOSED: ${JSON.stringify(ctx.recentClosed)}
ON-CHAIN: ${JSON.stringify(ctx.onchain)}
MARKET: ${JSON.stringify(ctx.market)}
MEMORY: ${ctx.memory || "None"}

JSON response: {"analysis":"Vietnamese","decisions":[{"action":"...","reason":"...","data":{"field":"...","value":"..."}}],"learnings":[{"key":"...","insight":"..."}]}`
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
    // STRICT: only allow whitelisted actions
    const decisions = (parsed.decisions || []).filter(d => ALLOWED_ACTIONS.has(d.action))
    if (decisions.length < (parsed.decisions || []).length) {
      const rejected = (parsed.decisions || []).filter(d => !ALLOWED_ACTIONS.has(d.action))
      logger.warn(`[Trader] Filtered ${rejected.length} disallowed actions: ${rejected.map(d => d.action).join(", ")}`)
    }
    return decisions
  } catch (err) {
    logger.error(`[Trader] Parse failed: ${err.message}`)
    return []
  }
}

async function executeAction(decision) {
  switch (decision.action) {
    case "UPDATE_CONFIG": {
      const field = decision.data?.field
      const value = decision.data?.value
      if (!field) return { ok: false, message: "No field specified" }
      const result = await updateTradingConfig({ [field]: value })
      return { ok: !!result, message: `Config ${field}=${value}` }
    }

    case "LEARNING":
      return { ok: true, message: `Learned: ${decision.reason}` }

    case "NO_ACTION":
      return { ok: true, message: `Hold: ${decision.reason}` }

    default:
      return { ok: false, message: `REJECTED: ${decision.action}` }
  }
}
