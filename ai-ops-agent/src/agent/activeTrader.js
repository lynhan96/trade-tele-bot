import { collectMarketContext } from "../utils/marketContext.js"
import { getPrices } from "../utils/redis.js"
import { getDb } from "../utils/db.js"
import { buildMemoryContext, saveDecision, saveLearning } from "../utils/memory.js"
import { updateTradingConfig, getTradingConfig } from "../actions/adminApi.js"
import { getLastSkillResults } from "../actions/skills.js"
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

  // ═══ 1. Collect FULL context ═══
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
      `${NVM}cat ${tmpFile} | claude --print --model claude-sonnet-4-6`,
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
  for (const d of (decisions || []).slice(0, 5)) {
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
  // ── Active signals with LIVE prices ──
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const symbols = active.map(s => s.symbol)
  const livePrices = await getPrices(symbols)

  const positions = active.map(s => {
    const livePrice = livePrices[s.symbol] || 0
    const entry = s.gridAvgEntry || s.entryPrice
    const mainPnlPct = livePrice && entry ? (
      s.direction === "LONG" ? ((livePrice - entry) / entry * 100) : ((entry - livePrice) / entry * 100)
    ) : 0
    const mainPnlUsdt = (mainPnlPct / 100) * (s.simNotional || 1000)

    let hedgePnlPct = 0, hedgePnlUsdt = 0
    if (s.hedgeActive && s.hedgeEntryPrice && livePrice) {
      hedgePnlPct = s.hedgeDirection === "LONG"
        ? ((livePrice - s.hedgeEntryPrice) / s.hedgeEntryPrice * 100)
        : ((s.hedgeEntryPrice - livePrice) / s.hedgeEntryPrice * 100)
      hedgePnlUsdt = (hedgePnlPct / 100) * (s.hedgeSimNotional || 750)
    }

    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
    const gridFilled = (s.gridLevels || []).filter(g => g.status === "FILLED").length
    const gridTotal = (s.gridLevels || []).length

    return {
      symbol: s.symbol, direction: s.direction, strategy: s.strategy,
      entry: +entry.toFixed(6), livePrice: +livePrice.toFixed(6), tp: s.takeProfitPrice,
      mainPnlPct: +mainPnlPct.toFixed(2), mainPnlUsdt: +mainPnlUsdt.toFixed(2),
      hedgeActive: s.hedgeActive || false, hedgeDirection: s.hedgeDirection,
      hedgeEntry: s.hedgeEntryPrice, hedgePnlPct: +hedgePnlPct.toFixed(2),
      hedgePnlUsdt: +hedgePnlUsdt.toFixed(2), hedgeCycles: s.hedgeCycleCount || 0,
      banked: +banked.toFixed(2), totalPnl: +(mainPnlUsdt + hedgePnlUsdt + banked).toFixed(2),
      confidence: s.aiConfidence, grid: `${gridFilled}/${gridTotal}`,
      openedAt: s.executedAt,
    }
  })

  // ── Real trades (for sim/real comparison) ──
  const realTrades = await db.collection("user_trades").find({ status: "OPEN" }).toArray()
  const realInfo = realTrades.map(t => ({
    symbol: t.symbol, direction: t.direction, isHedge: t.isHedge || false,
    entry: +t.entryPrice.toFixed(6), qty: t.quantity,
    notional: +(t.notionalUsdt || 0).toFixed(2),
    sl: t.slPrice || 0, tp: t.tpPrice || 0,
    grid: `${(t.gridLevels || []).filter(g => g.status === "FILLED").length}/${(t.gridLevels || []).length}`,
    hasSL: !!t.binanceSlAlgoId,
  }))

  // ── Recent closed (30 days, limit 20) ──
  const since30 = new Date(Date.now() - 30 * 86400000)
  const recentClosed = await db.collection("orders").find({ status: "CLOSED", closedAt: { $gte: since30 } })
    .sort({ closedAt: -1 }).limit(20).toArray()
  const recentInfo = recentClosed.map(o => ({
    symbol: o.symbol, type: o.type, direction: o.direction,
    pnl: +(o.pnlUsdt || 0).toFixed(2), reason: o.closeReason
  }))

  // ── Stats (30 days only) ──
  const allClosed30 = await db.collection("orders").find({ status: "CLOSED", closedAt: { $gte: since30 } }).toArray()
  let mainPnl = 0, hedgePnl = 0, wins = 0, losses = 0
  for (const o of allClosed30) {
    if (o.type === "HEDGE") hedgePnl += (o.pnlUsdt || 0)
    else { mainPnl += (o.pnlUsdt || 0); if ((o.pnlUsdt || 0) > 0) wins++; else losses++ }
  }

  // ── Real trade stats (7 days) ──
  const since7 = new Date(Date.now() - 7 * 86400000)
  const realClosed = await db.collection("user_trades").find({ status: "CLOSED", closedAt: { $gte: since7 } }).toArray()
  const realMainPnl = realClosed.filter(t => !t.isHedge).reduce((s, t) => s + (t.pnlUsdt || 0), 0)
  const realHedgePnl = realClosed.filter(t => t.isHedge).reduce((s, t) => s + (t.pnlUsdt || 0), 0)

  // ── Current config ──
  let currentConfig = {}
  try {
    const cfgRes = await getTradingConfig()
    currentConfig = cfgRes?.config || cfgRes || {}
  } catch {}

  // ── Cached skill findings (from last lightCheck — no double-run) ──
  const skillResults = getLastSkillResults()
  const skillFindings = Object.entries(skillResults)
    .flatMap(([k, v]) => Array.isArray(v) ? v.map(f => `[${k}] ${f}`) : [])
    .slice(0, 15)
    .join("\n")

  const memory = buildMemoryContext()
  const market = await collectMarketContext()

  return {
    activePositions: positions,
    realTrades: realInfo,
    recentClosed: recentInfo,
    skillFindings,
    currentConfig,
    stats: {
      wallet: +(1000 + mainPnl + hedgePnl).toFixed(2),
      mainPnl: +mainPnl.toFixed(2), hedgePnl: +hedgePnl.toFixed(2),
      winRate: wins + losses > 0 ? +((wins / (wins + losses)) * 100).toFixed(1) : 0,
      totalPositions: positions.length,
      unrealizedPnl: +positions.reduce((s, p) => s + p.totalPnl, 0).toFixed(2),
      real7d: { mainPnl: +realMainPnl.toFixed(2), hedgePnl: +realHedgePnl.toFixed(2), net: +(realMainPnl + realHedgePnl).toFixed(2) },
    },
    memory, market,
  }
}

function buildTraderPrompt(ctx) {
  const posText = ctx.activePositions.map(p =>
    `${p.symbol} ${p.direction} entry:${p.entry} price:${p.livePrice} pnl:${p.mainPnlPct}%($${p.mainPnlUsdt}) hedge:${p.hedgeActive}${p.hedgeActive ? ` hDir:${p.hedgeDirection} hEntry:${p.hedgeEntry} hPnl:${p.hedgePnlPct}%` : ''} cycles:${p.hedgeCycles} banked:$${p.banked} total:$${p.totalPnl} grid:${p.grid} strat:${p.strategy}`
  ).join("\n")

  const realText = ctx.realTrades.length > 0
    ? ctx.realTrades.map(t =>
        `${t.symbol} ${t.direction} ${t.isHedge ? 'HEDGE' : 'MAIN'} entry:${t.entry} notional:$${t.notional} sl:${t.sl} tp:${t.tp} grid:${t.grid} hasSL:${t.hasSL}`
      ).join("\n")
    : "No real trades"

  const cfgText = Object.entries(ctx.currentConfig)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "all defaults"

  const regime = ctx.market?.regime || "UNKNOWN"

  return `Bạn là SENIOR CRYPTO TRADER, quản lý portfolio trên Binance Futures.
ADVISOR ONLY — KHÔNG mở/đóng lệnh. Bot tự quản lý TP/SL/hedge/grid/FLIP. Bạn tối ưu CONFIG.

ALLOWED: UPDATE_CONFIG | LEARNING | NO_ACTION (max 5 actions)
Config fields: tpMax, tpMin, dcaTpPct, trailTrigger, trailKeepRatio, hedgePartialTriggerPct, hedgeFullTriggerPct, maxActiveSignals, maxDailySignals, confidenceFloor, confidenceFloorRanging, riskScoreThreshold, enabledStrategies (format: "disable:STRAT1,STRAT2")

FIELD LIMITS (agent auto-clamps): hedgeTrigger 2-8%, confidence 55-75%, maxSignals 3-30, tpMax 1.5-6%, tpMin 1-4%, slMax 1.5-5%, riskScore 40-80

═══ HỆ THỐNG HIỆN TẠI ═══

PROTECTION LAYERS (đã implement, KHÔNG cần adjust):
- Grid DCA: 4 levels cố định (0%/2%/4%/6%), weights 40/15/15/30%. DCA tiếp tục khi hedge active
- Hedge: trigger ${ctx.currentConfig.hedgePartialTriggerPct || 3}%, floor 2%. TP + trail (activate +2%, keep 70%)
- Progressive SL: cycle 1-2=40%, cycle 3=15%, cycle 4+=8% (chỉ khi recovery ratio <50%)
- Circuit breaker: 3+ cycles AND recovery<50% AND price beyond SL → close
- FLIP: khi main TP hit + hedge OPEN → giữ hedge làm main mới (không close cả hai)
- Trail SL: đặt thật trên Binance (backup nếu bot crash)
- NET_POSITIVE: close all khi total net PnL > 3% of filledVol
- SIM→Real: tất cả sim actions sync cho real (SL move, TP boost, close, FLIP)
- onTradeClose: filter by direction (hedge close không ảnh hưởng main)

═══ TƯ DUY TRADER ═══

1. REGIME: ${regime}
   - RANGE_BOUND/SIDEWAYS: TP chặt (1.5-2.5%), maxActive 3-5, confidence cao
   - MIXED: TP 2-3%, maxActive 5-8
   - STRONG_BULL/BEAR: TP rộng (3-5%), maxActive 8-10, follow trend

2. RISK: max 2% per trade. Drawdown >10% → tăng confidence, giảm maxActive

3. HEDGE: bảo hiểm, không trade. Coin hedge kém 3x → suggest disable. Vol cao → trigger rộng

4. STRATEGY: check WR per strategy. Disable strategy < 40% WR on 5+ trades

5. TP/TRAIL GAP: trail trigger vs tpMax gap quá lớn → trail chốt lời trước TP → giảm tpMax

CURRENT CONFIG: ${cfgText}

SKILLS FINDINGS:
${ctx.skillFindings || "None"}

SIM POSITIONS (${ctx.activePositions.length}):
${posText}

REAL TRADES (${ctx.realTrades.length}):
${realText}

SIM STATS (30d): ${JSON.stringify(ctx.stats)}
REAL 7d: ${JSON.stringify(ctx.stats.real7d)}
RECENT CLOSED: ${JSON.stringify(ctx.recentClosed)}
MARKET: ${JSON.stringify(ctx.market)}
MEMORY: ${ctx.memory || "None"}

Phân tích sâu, nhận diện pattern, đề xuất config adjustment.
JSON: {"analysis":"...","decisions":[{"action":"...","reason":"...","data":{"field":"...","value":"..."}}],"learnings":[{"key":"...","insight":"..."}]}`
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
