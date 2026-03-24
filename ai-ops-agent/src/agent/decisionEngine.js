import { execSync } from "child_process"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getDb } from "../utils/db.js"
import { buildMemoryContext, saveDecision, saveLearning } from "../utils/memory.js"
import { closeSignal, updateTradingConfig } from "../actions/adminApi.js"
import { logger } from "../utils/logger.js"

const NVM = 'export NVM_DIR="/home/ubuntu/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"

export async function makeDecisions(tradingReport, skillResults) {
  const db = await getDb()
  const context = await buildFullContext(db, tradingReport, skillResults)
  const prompt = buildDecisionPrompt(context)
  logger.info("[Decision] Asking Claude...")

  let decisions
  const tmpFile = join(tmpdir(), `decision-prompt-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, "utf8")
    const output = execSync(
      `${NVM}cat ${tmpFile} | claude --print`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 3 * 60 * 1000, env: { ...process.env, HOME: "/home/ubuntu" } }
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
  for (const d of decisions) {
    try {
      const result = await executeDecision(d, db)
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
  return `You are an AI trading agent managing a Binance Futures bot.

== RULES ==
1. Close WINNING signals (PnL > 0) when reversal risk detected
2. Do NOT close losing signals — hedge system manages those
3. Enable/disable strategies based on WR (disable if WR < 35% on 5+ trades)
4. Adjust config when performance degrades
5. Learn from past decisions in memory
6. Be conservative — strong evidence only
7. Max 3 actions per cycle

== RESPONSE (JSON only, no markdown fences) ==
{"analysis":"Vietnamese assessment","decisions":[{"action":"CLOSE_SIGNAL|UPDATE_CONFIG|LEARNING|NO_ACTION","target":"id_or_field","reason":"Vietnamese","data":{}}],"learnings":[{"key":"unique","insight":"what learned"}]}

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

Decide:`
}

function parseDecisions(output) {
  try {
    const jsonMatch = output.match(/\{[\s\S]*"decisions"[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.learnings?.length) parsed.learnings.forEach(l => saveLearning(l))
    logger.info(`[Decision] ${parsed.analysis?.slice(0, 150)}`)
    return parsed.decisions || []
  } catch (err) {
    logger.error(`[Decision] Parse: ${err.message}`)
    return []
  }
}

async function executeDecision(decision) {
  switch (decision.action) {
    case "CLOSE_SIGNAL": {
      const id = decision.data?.signalId || decision.target
      if (!id) return { ok: false, message: "No signal ID" }
      const result = await closeSignal(id)
      return { ok: !!result, message: `Closed ${id}` }
    }
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
      return { ok: false, message: `Unknown: ${decision.action}` }
  }
}
