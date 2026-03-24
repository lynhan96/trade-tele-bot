import { execSync } from "child_process"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getDb } from "../utils/db.js"
import { buildMemoryContext, saveDecision, saveLearning } from "../utils/memory.js"
import { updateTradingConfig } from "../actions/adminApi.js"
import { logger } from "../utils/logger.js"

const NVM = 'export NVM_DIR="/home/ubuntu/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"

// ═══ ALLOWED ACTIONS — advisor only, no position execution ═══
const ALLOWED_ACTIONS = new Set(["UPDATE_CONFIG", "LEARNING", "NO_ACTION"])

export async function makeDecisions(tradingReport, skillResults) {
  const db = await getDb()
  const context = await buildFullContext(db, tradingReport, skillResults)
  const prompt = buildDecisionPrompt(context)
  logger.info("[Decision] Asking Claude...")

  let decisions
  const tmpFile = join(tmpdir(), `decision-prompt-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, "utf8")
    const env = { ...process.env, HOME: "/home/ubuntu" }
    delete env.ANTHROPIC_API_KEY
    const output = execSync(
      `${NVM}cat ${tmpFile} | claude --print`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 3 * 60 * 1000, env }
    )
    decisions = parseDecisions(output)
  } catch (err) {
    const stderr = err.stderr ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString()) : ''
    logger.error(`[Decision] Claude failed: ${stderr.slice(0, 500) || err.message?.slice(0, 500)}`)
    return []
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }

  if (!decisions?.length) { logger.info("[Decision] No actions"); return [] }

  const results = []
  for (const d of decisions.slice(0, 3)) {
    try {
      const result = await executeDecision(d)
      saveDecision({ ...d, outcome: result.ok ? "success" : "failed", details: result.message })
      results.push(result)
      logger.info(`[Decision] ${d.action}: ${result.message}`)
    } catch (err) {
      saveDecision({ ...d, outcome: "error", details: err.message })
      logger.error(`[Decision] ${d.action} failed: ${err.message}`)
    }
  }
  return results
}

async function buildFullContext(db, report, skills) {
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const activeInfo = []
  for (const s of active) {
    const orders = await db.collection("orders").find({ signalId: s._id }).toArray()
    const openHedge = orders.find(o => o.type === "HEDGE" && o.status === "OPEN")
    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
    activeInfo.push({
      id: s._id.toString(), symbol: s.symbol, direction: s.direction,
      entry: s.gridAvgEntry || s.entryPrice,
      tp: s.takeProfitPrice, sl: s.stopLossPrice,
      hedgeActive: s.hedgeActive || false, hedgeCycles: s.hedgeCycleCount || 0,
      banked: +banked.toFixed(2),
      hedgeEntry: openHedge?.entryPrice, hedgeVol: openHedge?.notional,
      strategy: s.strategy, confidence: s.aiConfidence
    })
  }

  let onchainData = null
  try {
    const snaps = await db.collection("onchain_snapshots").find().sort({ snapshotAt: -1 }).limit(10).toArray()
    if (snaps.length) onchainData = snaps.map(s => ({
      symbol: s.symbol, direction: s.direction, fr: s.fundingRatePct,
      longPct: s.longPercent, taker: s.takerBuyRatio
    }))
  } catch {}

  const recentClosed = await db.collection("orders").find({ status: "CLOSED" })
    .sort({ closedAt: -1 }).limit(20).toArray()
  const recentInfo = recentClosed.map(o => ({
    symbol: o.symbol, type: o.type, direction: o.direction,
    pnl: o.pnlUsdt, reason: o.closeReason
  }))

  const memory = buildMemoryContext()
  return { report, skills, activeInfo, recentClosed: recentInfo, onchainData, memory }
}

function buildDecisionPrompt(ctx) {
  return `You are an AI trading ADVISOR for a Binance Futures bot.
You are an ADVISOR — you CANNOT close, open, or modify any position directly.
The bot handles all execution automatically.

== YOUR ROLE ==
1. Analyze trading performance and market conditions
2. Adjust config parameters when performance degrades (UPDATE_CONFIG)
3. Enable/disable strategies based on WR (disable if WR < 35% on 5+ trades)
4. Record observations and patterns (LEARNING)
5. Be conservative — strong evidence only
6. Max 3 actions per cycle

== ALLOWED ACTIONS (ONLY these 3) ==
- UPDATE_CONFIG: Change trading config parameter
- LEARNING: Save insight for future reference
- NO_ACTION: No changes needed

== WHAT BOT HANDLES (DO NOT INTERFERE) ==
- Close signals (TP/trail/SL — automatic)
- Hedge open/close (automatic at -3%, TP/trail/NET_POSITIVE/FLIP)
- Grid entry/exit (automatic)

== RESPONSE (JSON only, no markdown fences) ==
{"analysis":"Vietnamese assessment","decisions":[{"action":"UPDATE_CONFIG|LEARNING|NO_ACTION","reason":"Vietnamese","data":{"field":"configField","value":"newValue"}}],"learnings":[{"key":"unique","insight":"what learned"}]}

== TRADING DATA ==
${JSON.stringify(ctx.report, null, 2)}

== ACTIVE SIGNALS ==
${JSON.stringify(ctx.activeInfo, null, 2)}

== RECENT CLOSED ==
${JSON.stringify(ctx.recentClosed, null, 2)}

== ON-CHAIN ==
${JSON.stringify(ctx.onchainData, null, 2)}

== SKILLS ==
${JSON.stringify(ctx.skills, null, 2)}

== MEMORY ==
${ctx.memory || "No history"}

Analyze and recommend config adjustments if needed:`
}

function parseDecisions(output) {
  try {
    const jsonMatch = output.match(/\{[\s\S]*"decisions"[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.learnings?.length) parsed.learnings.forEach(l => saveLearning(l))
    logger.info(`[Decision] ${parsed.analysis?.slice(0, 150)}`)
    // STRICT: only allow whitelisted actions
    const decisions = (parsed.decisions || []).filter(d => ALLOWED_ACTIONS.has(d.action))
    if (decisions.length < (parsed.decisions || []).length) {
      const rejected = (parsed.decisions || []).filter(d => !ALLOWED_ACTIONS.has(d.action))
      logger.warn(`[Decision] Filtered ${rejected.length} disallowed actions: ${rejected.map(d => d.action).join(", ")}`)
    }
    return decisions
  } catch (err) {
    logger.error(`[Decision] Parse: ${err.message}`)
    return []
  }
}

async function executeDecision(decision) {
  if (!ALLOWED_ACTIONS.has(decision.action)) {
    return { ok: false, message: `REJECTED: ${decision.action}` }
  }

  switch (decision.action) {
    case "UPDATE_CONFIG": {
      const field = decision.data?.field || decision.target
      const value = decision.data?.value
      if (!field) return { ok: false, message: "No field" }
      const result = await updateTradingConfig({ [field]: value })
      return { ok: !!result, message: `Config ${field}=${value}` }
    }
    case "LEARNING":
      return { ok: true, message: `Learned: ${decision.reason}` }
    case "NO_ACTION":
      return { ok: true, message: `Skip: ${decision.reason}` }
    default:
      return { ok: false, message: `REJECTED: ${decision.action}` }
  }
}
