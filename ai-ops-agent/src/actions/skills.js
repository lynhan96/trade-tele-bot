import axios from "axios"
import { getDb } from "../utils/db.js"
import { getPrices } from "../utils/redis.js"
import { collectMarketContext } from "../utils/marketContext.js"
import { saveLearning } from "../utils/memory.js"
import { logger } from "../utils/logger.js"
import * as agentLog from "../utils/agentLogger.js"
import { updateTradingConfig, getTradingConfig, getSignals } from "../actions/adminApi.js"

const BASE = process.env.HEALTH_URL?.replace("/admin/health", "") || "http://127.0.0.1:3001"

// Silent mode: log to file only, no dashboard events (used on startup)
let _silent = false

// ── Auto-config: skill can UPDATE_CONFIG with cooldown ──
const configCooldowns = new Map() // field → lastChangeTime
const CONFIG_COOLDOWN_MS = 30 * 60 * 1000 // 30 min cooldown per field
let _drawdownMode = "NORMAL" // NORMAL | CAUTIOUS | DEFENSIVE

// Hard limits per field — prevents agent from setting destructive values
const FIELD_LIMITS = {
  hedgePartialTriggerPct: { min: 2, max: 8 },
  hedgeFullTriggerPct:    { min: 2, max: 8 },
  confidenceFloor:        { min: 55, max: 75 },
  confidenceFloorRanging: { min: 60, max: 80 },
  maxActiveSignals:       { min: 3, max: 30 },
  riskScoreThreshold:     { min: 40, max: 80 },
  hedgeTpPct:             { min: 1, max: 6 },
  hedgeSafetySlPct:       { min: 5, max: 20 },
  hedgeMaxCycles:         { min: 3, max: 10 },
}

async function autoConfig(field, value, reason) {
  const lastChange = configCooldowns.get(field) || 0
  if (Date.now() - lastChange < CONFIG_COOLDOWN_MS) return null

  // Enforce hard limits — clamp value and warn if clamped
  const limits = FIELD_LIMITS[field]
  if (limits) {
    const original = value
    value = Math.max(limits.min, Math.min(limits.max, value))
    if (value !== original) {
      logger.warn(`[AutoConfig] ${field}=${original} CLAMPED to ${value} (limits: ${limits.min}-${limits.max})`)
    }
  }

  // Skip if value already matches current config (avoid redundant PATCHes)
  try {
    const current = await getTradingConfig()
    const currentVal = current?.config?.[field] ?? current?.[field]
    if (currentVal === value) return null // already set
  } catch {} // proceed if check fails
  const result = await updateTradingConfig({ [field]: value })
  if (result) {
    configCooldowns.set(field, Date.now())
    logger.info(`[AutoConfig] ${field}=${value} — ${reason}`)
    if (!_silent) await agentLog.action("auto_config", `${field}=${value} — ${reason}`, "UPDATE_CONFIG").catch(() => {})
  }
  return result
}

// Dedup: only log findings that are NEW (not seen in previous cycle)
const lastFindings = new Map() // skill → Set of finding keys
function filterNewFindings(skill, findings) {
  // Don't update cache during silent mode — otherwise first silent run
  // caches everything and subsequent non-silent run sees nothing new
  if (_silent) return findings
  const prev = lastFindings.get(skill) || new Set()
  const newOnes = findings.filter(f => !prev.has(f))
  lastFindings.set(skill, new Set(findings))
  return newOnes
}

// ══════════════════════════════════════════════════════════
// SKILL 1: DATA VALIDATOR — auto-fix corrupted data
// ══════════════════════════════════════════════════════════
export async function runDataValidator() {
  const db = await getDb()
  const fixes = []

  // 1a. SL = entry price (CRITICAL — causes instant close)
  const activeSignals = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  for (const s of activeSignals) {
    const entry = s.gridAvgEntry || s.entryPrice
    if (s.stopLossPrice > 0 && entry > 0) {
      const slDiff = Math.abs(s.stopLossPrice - entry) / entry * 100
      if (slDiff < 0.5) {
        await db.collection("ai_signals").updateOne({ _id: s._id }, { $set: { stopLossPrice: 0, stopLossPercent: 0 } })
        fixes.push(`${s.symbol}: SL=entry fixed → 0 (was instant-close bug)`)
      }
    }
    // 1b. REMOVED — SL=40% is the default safety net for ALL signals
    // Hedge system manages risk via hedge positions, NOT by removing SL
    // SL=0 only happens when hedge is actively open (set by hedge-manager)
  }

  // 2. Orders with entry price mismatch > 15%
  const openOrders = await db.collection("orders").find({ status: "OPEN" }).toArray()
  for (const o of openOrders) {
    const sig = await db.collection("ai_signals").findOne({ _id: o.signalId })
    if (!sig) continue
    const sigEntry = sig.gridAvgEntry || sig.entryPrice
    if (sigEntry > 0 && o.entryPrice > 0) {
      const diff = Math.abs(o.entryPrice - sigEntry) / sigEntry * 100
      if (diff > 15) {
        await db.collection("orders").updateOne({ _id: o._id }, { $set: { entryPrice: sigEntry } })
        fixes.push(`${o.symbol} order: entry ${o.entryPrice} → ${sigEntry} (${diff.toFixed(0)}% mismatch)`)
      }
    }
  }

  // 3. Completed signals with OPEN orders (orphaned)
  const completed = await db.collection("ai_signals").find({ status: "COMPLETED" }).toArray()
  for (const s of completed) {
    const orphaned = await db.collection("orders").find({ signalId: s._id, status: "OPEN" }).toArray()
    for (const o of orphaned) {
      const sigEntry = s.gridAvgEntry || s.entryPrice
      const exitP = s.exitPrice || sigEntry
      const pnlPct = s.direction === "LONG" ? ((exitP - o.entryPrice) / o.entryPrice * 100) : ((o.entryPrice - exitP) / o.entryPrice * 100)
      const fees = (o.entryFeeUsdt || 0) + (o.exitFeeUsdt || 0)
      const pnlUsdt = Math.round(((pnlPct / 100) * o.notional - fees) * 100) / 100
      await db.collection("orders").updateOne({ _id: o._id }, {
        $set: { status: "CLOSED", exitPrice: exitP, pnlPercent: pnlPct, pnlUsdt, closedAt: s.positionClosedAt || new Date(), closeReason: s.closeReason || "ORPHAN_CLOSE" }
      })
      fixes.push(`${o.symbol} orphan order closed: pnl=$${pnlUsdt}`)
    }
  }

  // 4. Completed signals missing orders
  for (const s of completed) {
    const count = await db.collection("orders").countDocuments({ signalId: s._id })
    if (count === 0) {
      const entry = s.gridAvgEntry || s.entryPrice
      const exitP = s.exitPrice || entry
      const vol = (s.simNotional || 1000) * 0.4
      const pnlPct = s.direction === "LONG" ? ((exitP - entry) / entry * 100) : ((entry - exitP) / entry * 100)
      const fees = vol * 0.05 / 100 * 2
      const pnlUsdt = Math.round(((pnlPct / 100) * vol - fees) * 100) / 100
      await db.collection("orders").insertOne({
        signalId: s._id, symbol: s.symbol, direction: s.direction, type: "MAIN", status: "CLOSED",
        entryPrice: entry, exitPrice: exitP, notional: vol, quantity: vol / (entry || 1),
        pnlPercent: pnlPct, pnlUsdt, closeReason: s.closeReason || "UNKNOWN",
        openedAt: s.executedAt, closedAt: s.positionClosedAt || new Date(), cycleNumber: 0,
        entryFeeUsdt: +(vol * 0.05 / 100).toFixed(4), exitFeeUsdt: +(vol * 0.05 / 100).toFixed(4), fundingFeeUsdt: 0,
        metadata: { migrated: true, autoCreated: true }, createdAt: new Date(), updatedAt: new Date()
      })
      fixes.push(`${s.symbol} missing order created: pnl=$${pnlUsdt}`)
    }
  }

  // 5. PnL > 50% on single trade = data corruption
  const badPnl = await db.collection("orders").find({
    status: "CLOSED", $or: [{ pnlPercent: { $gt: 50 } }, { pnlPercent: { $lt: -50 } }]
  }).toArray()
  for (const o of badPnl) {
    const sig = await db.collection("ai_signals").findOne({ _id: o.signalId })
    if (!sig) continue
    const entry = sig.gridAvgEntry || sig.entryPrice || o.exitPrice
    const pnlPct = o.direction === "LONG" ? ((o.exitPrice - entry) / entry * 100) : ((entry - o.exitPrice) / entry * 100)
    const fees = (o.entryFeeUsdt || 0) + (o.exitFeeUsdt || 0)
    const pnlUsdt = Math.round(((pnlPct / 100) * o.notional - fees) * 100) / 100
    if (Math.abs(pnlPct) < 50) {
      await db.collection("orders").updateOne({ _id: o._id }, { $set: { entryPrice: entry, pnlPercent: pnlPct, pnlUsdt } })
      fixes.push(`${o.symbol} bad PnL fixed: ${o.pnlPercent?.toFixed(1)}% → ${pnlPct.toFixed(1)}%`)
    }
  }

  if (fixes.length) {
    logger.info(`[DataValidator] ${fixes.length} fixes: ${fixes.join(" | ")}`)
    if (!_silent) for (const f of fixes) await agentLog.action("bug_detector", f, "DATA_FIX")
  }
  return fixes
}

// ══════════════════════════════════════════════════════════
// SKILL 2: HEDGE MANAGER + DYNAMIC PARAMS (#3) + PER-COIN MEMORY (#8)
// Tracks per-coin hedge effectiveness, adjusts thresholds based on volatility
// ══════════════════════════════════════════════════════════
const hedgeCoinStats = {} // symbol → { totalCycles, profitCycles, totalBanked, avgCyclePnl }
export async function runHedgeManager() {
  const db = await getDb()
  const actions = []

  const allActive = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()

  // ── Order-based hedge state (source of truth — not signal.hedgeActive flag) ──
  const openHedgeOrders = await db.collection("orders").find({ type: "HEDGE", status: "OPEN" }).toArray()
  const hedgeBySignalId = {}
  for (const o of openHedgeOrders) hedgeBySignalId[o.signalId.toString()] = o

  // Signals with OPEN HEDGE orders (not signal.hedgeActive flag which can desync)
  const hedgeActive = allActive.filter(s => hedgeBySignalId[s._id.toString()])

  for (const s of hedgeActive) {
    const hedgeOrder = hedgeBySignalId[s._id.toString()]

    // Get main order state (source of truth for avgEntry/notional)
    const mainOrders = await db.collection("orders").find({
      signalId: s._id, type: { $in: ["MAIN", "FLIP_MAIN"] }, status: "OPEN"
    }).toArray()
    const totalMainNotional = mainOrders.reduce((sum, o) => sum + (o.notional || 0), 0)
    const avgEntry = totalMainNotional > 0
      ? mainOrders.reduce((sum, o) => sum + o.entryPrice * o.notional, 0) / totalMainNotional
      : s.gridAvgEntry || s.entryPrice
    const mainNotional = s.simNotional || 1000

    // Banked profit from CLOSED HEDGE orders (source of truth — not signal.hedgeHistory)
    const closedHedges = await db.collection("orders").find({
      signalId: s._id, type: "HEDGE", status: "CLOSED"
    }).toArray()
    const banked = closedHedges.reduce((sum, o) => sum + (o.pnlUsdt || 0), 0)

    // NET_POSITIVE check (using order data)
    if (banked > 0 && avgEntry > 0 && hedgeOrder.entryPrice > 0) {
      if (banked > mainNotional * 0.05) {
        actions.push(`${s.symbol}: hedge banked $${banked.toFixed(2)} (${(banked / mainNotional * 100).toFixed(1)}% of vol) — monitoring for NET_POSITIVE`)
      }
    }

    // Hedge spam check (hedgeHistory still on signal for cycle tracking)
    const beCycles = (s.hedgeHistory || []).filter(h => Math.abs(h.pnlUsdt || 0) < 1).length
    if (beCycles >= 3 && s.hedgeCycleCount >= 5) {
      actions.push(`${s.symbol}: ${beCycles} breakeven cycles out of ${s.hedgeCycleCount} — hedge may be ineffective`)
    }

    // #8 Per-coin hedge effectiveness tracking
    const sym = s.symbol
    if (!hedgeCoinStats[sym]) hedgeCoinStats[sym] = { totalCycles: 0, profitCycles: 0, totalBanked: 0 }
    const stats = hedgeCoinStats[sym]
    stats.totalCycles = closedHedges.length
    stats.profitCycles = closedHedges.filter(o => (o.pnlUsdt || 0) > 1).length
    stats.totalBanked = banked
    stats.effectiveRate = stats.totalCycles > 0 ? (stats.profitCycles / stats.totalCycles * 100) : 0

    if (stats.totalCycles >= 5 && stats.effectiveRate < 30) {
      actions.push(`📉 ${sym}: hedge effectiveness ${stats.effectiveRate.toFixed(0)}% (${stats.profitCycles}/${stats.totalCycles} profitable) — consider higher threshold`)
      saveLearning({ key: `hedge_ineffective_${sym}`, insight: `${sym} hedge only ${stats.effectiveRate.toFixed(0)}% profitable after ${stats.totalCycles} cycles, banked $${banked.toFixed(2)} — may need higher activation threshold` })
    }
    if (stats.totalCycles >= 5 && stats.effectiveRate > 70) {
      actions.push(`✅ ${sym}: hedge effective ${stats.effectiveRate.toFixed(0)}% — well-suited for hedging`)
    }
  }

  // #3 Dynamic Hedge Parameters — based on portfolio-wide volatility
  // Use average absolute PnL% of active positions as volatility proxy
  // Use order avgEntry when available (source of truth after DCA/FLIP)
  const prices = await getPrices(allActive.map(s => s.symbol))
  let totalAbsPnl = 0, priceCount = 0
  for (const s of allActive) {
    // Get avgEntry from MAIN orders (source of truth)
    const mains = await db.collection("orders").find({
      signalId: s._id, type: { $in: ["MAIN", "FLIP_MAIN"] }, status: "OPEN"
    }).toArray()
    const mainNotional = mains.reduce((sum, o) => sum + (o.notional || 0), 0)
    const entry = mainNotional > 0
      ? mains.reduce((sum, o) => sum + o.entryPrice * o.notional, 0) / mainNotional
      : s.gridAvgEntry || s.entryPrice
    const price = prices[s.symbol] || 0
    if (!entry || !price) continue
    const pnlPct = Math.abs((price - entry) / entry * 100)
    totalAbsPnl += pnlPct
    priceCount++
  }
  const avgVolatility = priceCount > 0 ? totalAbsPnl / priceCount : 0

  // Auto-config hedgeTrigger based on volatility (with FIELD_LIMITS validation)
  // High vol → wider trigger (prevent breakeven cycles on noise)
  // Low vol → tighter trigger (capture smaller moves)
  if (avgVolatility > 6) {
    const trigger = Math.min(Math.round(avgVolatility * 0.7), 8)
    await autoConfig("hedgePartialTriggerPct", trigger, `High vol ${avgVolatility.toFixed(1)}% → trigger ${trigger}%`)
    await autoConfig("hedgeFullTriggerPct", trigger, `High vol ${avgVolatility.toFixed(1)}% → trigger ${trigger}%`)
    actions.push(`📊 High vol (${avgVolatility.toFixed(1)}%) → auto-set hedgeTrigger=${trigger}%`)
  } else if (avgVolatility > 3) {
    await autoConfig("hedgePartialTriggerPct", 4, `Medium vol ${avgVolatility.toFixed(1)}% → trigger 4%`)
    await autoConfig("hedgeFullTriggerPct", 4, `Medium vol ${avgVolatility.toFixed(1)}% → trigger 4%`)
    actions.push(`📊 Medium vol (${avgVolatility.toFixed(1)}%) → auto-set hedgeTrigger=4%`)
  } else if (avgVolatility >= 1) {
    await autoConfig("hedgePartialTriggerPct", 3, `Normal vol ${avgVolatility.toFixed(1)}% → trigger 3%`)
    await autoConfig("hedgeFullTriggerPct", 3, `Normal vol ${avgVolatility.toFixed(1)}% → trigger 3%`)
    actions.push(`📊 Normal vol (${avgVolatility.toFixed(1)}%) → hedgeTrigger=3% (default)`)
  } else {
    await autoConfig("hedgePartialTriggerPct", 2, `Low vol ${avgVolatility.toFixed(1)}% → trigger 2% (floor)`)
    await autoConfig("hedgeFullTriggerPct", 2, `Low vol ${avgVolatility.toFixed(1)}% → trigger 2% (floor)`)
    actions.push(`📊 Low vol (${avgVolatility.toFixed(1)}%) → hedgeTrigger=2% (floor)`)
  }

  const newActions = filterNewFindings("hedge", actions)
  if (newActions.length) {
    logger.info(`[HedgeManager] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("position_manager", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 3: STRATEGY REPORTER + REGIME-AWARE ROTATION (#1) + ENSEMBLE (#7)
// Auto-disables strategies with WR <35% on 6+ trades
// Tracks per-regime performance for smarter rotation
// ══════════════════════════════════════════════════════════
const regimeStrategyWR = {} // { regime: { strategy: { wins, total } } }
export async function runStrategyTuner() {
  const db = await getDb()
  const actions = []
  const market = await collectMarketContext()
  const regime = market.regime || "UNKNOWN"

  const completed = await db.collection("ai_signals").find({ status: "COMPLETED" }).toArray()
  const stratPerf = {}

  for (const s of completed) {
    const st = s.strategy || "unknown"
    const base = st.split("+")[0]
    if (!stratPerf[base]) stratPerf[base] = { count: 0, wins: 0, pnl: 0 }
    stratPerf[base].count++
    if ((s.pnlUsdt || 0) > 0) stratPerf[base].wins++
    stratPerf[base].pnl += s.pnlUsdt || 0
  }

  // #1 Regime-aware WR tracking (last 30 trades per regime)
  const recent = completed.slice(-100)
  for (const s of recent) {
    const r = s.marketRegime || "UNKNOWN"
    const st = (s.strategy || "unknown").split("+")[0]
    if (!regimeStrategyWR[r]) regimeStrategyWR[r] = {}
    if (!regimeStrategyWR[r][st]) regimeStrategyWR[r][st] = { wins: 0, total: 0 }
    regimeStrategyWR[r][st].total++
    if ((s.pnlUsdt || 0) > 0) regimeStrategyWR[r][st].wins++
  }

  // Report overall stats + regime-specific
  const weakStrategies = []
  for (const [name, s] of Object.entries(stratPerf)) {
    if (s.count < 3) continue
    const wr = (s.wins / s.count * 100)
    let note = ""
    // Check regime-specific WR
    const regimeData = regimeStrategyWR[regime]?.[name]
    if (regimeData && regimeData.total >= 3) {
      const regimeWR = (regimeData.wins / regimeData.total * 100)
      note = ` [${regime}: ${regimeWR.toFixed(0)}%/${regimeData.total}]`
    }
    if (wr >= 65) actions.push(`✅ ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)}${note} — performing well`)
    else if (wr < 35 && s.count >= 6) {
      actions.push(`🔴 ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)}${note} — AUTO DISABLE`)
      weakStrategies.push(name)
    }
    else actions.push(`${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)}${note}`)
  }

  // #1 Auto-disable weak strategies (WR <35% on 6+ trades)
  // Config format: "disable:STRAT1,STRAT2" (blacklist string)
  if (weakStrategies.length) {
    try {
      const config = await getTradingConfig()
      const currentVal = config?.config?.enabledStrategies || config?.enabledStrategies || ""
      const currentDisabled = typeof currentVal === "string" && currentVal.startsWith("disable:")
        ? currentVal.replace("disable:", "").split(",").filter(Boolean)
        : []
      const newDisabled = [...new Set([...currentDisabled, ...weakStrategies])]
      const newVal = `disable:${newDisabled.join(",")}`
      if (newVal !== currentVal) {
        await autoConfig("enabledStrategies", newVal, `Disabled weak: ${weakStrategies.join(",")} (WR<35% on 6+ trades)`)
        actions.push(`🔧 AUTO: Disabled ${weakStrategies.join(",")}`)
      }
    } catch (e) { logger.error(`[StrategyRotation] ${e.message}`) }
  }

  // #7 Strategy Ensemble Scoring — detect multi-strategy agreement on active signals
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const symbolDir = {} // symbol → { strategies: [], direction }
  for (const s of active) {
    const sym = s.symbol
    const st = (s.strategy || "unknown").split("+")[0]
    if (!symbolDir[sym]) symbolDir[sym] = { dir: s.direction, strategies: [] }
    symbolDir[sym].strategies.push(st)
  }
  for (const [sym, info] of Object.entries(symbolDir)) {
    if (info.strategies.length >= 2) {
      actions.push(`🎯 ${sym}: ${info.strategies.length} strategies agree ${info.dir} (${info.strategies.join("+")}) — high conviction`)
    }
  }

  const newActions = filterNewFindings("strategy", actions)
  if (newActions.length) {
    logger.info(`[StrategyReporter] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("strategy_tuner", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 4: EXPOSURE MANAGER — monitor risk levels
// ══════════════════════════════════════════════════════════
export async function runExposureManager() {
  const db = await getDb()
  const actions = []

  const openOrders = await db.collection("orders").find({ status: "OPEN" }).toArray()
  const totalVol = openOrders.reduce((s, o) => s + (o.notional || 0), 0)
  const leverage = totalVol / 1000

  if (leverage > 25) actions.push(`⚠️ Leverage x${leverage.toFixed(1)} > 25 — consider reducing positions`)
  if (leverage > 35) actions.push(`🔴 Leverage x${leverage.toFixed(1)} > 35 — HIGH RISK`)

  // Direction imbalance
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const longs = active.filter(s => s.direction === "LONG").length
  const shorts = active.filter(s => s.direction === "SHORT").length
  if (active.length >= 5 && shorts === 0) {
    actions.push(`⚠️ All ${longs} signals LONG, 0 SHORT — no diversification`)
  }

  const newActions = filterNewFindings("exposure", actions)
  if (newActions.length) {
    logger.info(`[ExposureManager] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("market_analyzer", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 5: PROFIT PROTECTOR + SMART TP OPTIMIZATION (#6)
// Analyzes TP hit rates and suggests dynamic TP adjustments
// ══════════════════════════════════════════════════════════
export async function runProfitProtector() {
  const db = await getDb()
  const actions = []

  // Check winning closed orders in last hour
  const oneHourAgo = new Date(Date.now() - 3600000)
  const recentWins = await db.collection("orders").find({
    status: "CLOSED", type: "MAIN", pnlUsdt: { $gt: 0 }, closedAt: { $gte: oneHourAgo }
  }).toArray()

  for (const o of recentWins) {
    if (o.closeReason === "TRAIL_STOP" && o.pnlPercent < 1.5) {
      actions.push(`${o.symbol}: trail closed at +${o.pnlPercent?.toFixed(2)}% ($${o.pnlUsdt?.toFixed(2)}) — trail may be too tight`)
    }
  }

  // Active signals with high unrealized profit
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  for (const s of active) {
    if (s.peakPnlPct && s.peakPnlPct > 3 && !s.slMovedToEntry) {
      actions.push(`${s.symbol}: peak ${s.peakPnlPct.toFixed(2)}% but SL not moved to entry — profit unprotected`)
    }
  }

  // #6 Smart TP Optimization — analyze where trades actually close vs configured TP
  const closedSignals = await db.collection("ai_signals").find({ status: "COMPLETED" })
    .sort({ positionClosedAt: -1 }).limit(50).toArray()

  if (closedSignals.length >= 15) {
    const tpHits = closedSignals.filter(s => s.closeReason === "TAKE_PROFIT" || s.closeReason === "TP")
    const trailHits = closedSignals.filter(s => s.closeReason === "TRAIL_STOP")
    const slHits = closedSignals.filter(s => s.closeReason === "STOP_LOSS" || s.closeReason === "SL")

    // Average PnL% for TP hits — shows if TP is set correctly
    if (tpHits.length >= 5) {
      const avgTpPnl = tpHits.reduce((s, t) => s + (t.pnlPercent || 0), 0) / tpHits.length
      actions.push(`📊 TP analysis: ${tpHits.length}/${closedSignals.length} hit TP (avg +${avgTpPnl.toFixed(1)}%)`)

      // If most trades close via trail BELOW TP → TP might be too high
      if (trailHits.length > tpHits.length * 2) {
        const avgTrailPnl = trailHits.reduce((s, t) => s + (t.pnlPercent || 0), 0) / trailHits.length
        actions.push(`⚠️ ${trailHits.length} trail stops vs ${tpHits.length} TP hits — TP may be too high (avg trail: +${avgTrailPnl.toFixed(1)}%)`)
        saveLearning({ key: "tp_too_high", insight: `Trail stops (${trailHits.length}) dominate TP hits (${tpHits.length}). Avg trail close: +${avgTrailPnl.toFixed(1)}%, avg TP: +${avgTpPnl.toFixed(1)}%. Consider lowering TP closer to ${avgTrailPnl.toFixed(1)}%` })
      }
    }

    // SL rate too high → signals entering too late or TP too ambitious
    if (slHits.length >= 5) {
      const slRate = (slHits.length / closedSignals.length * 100)
      if (slRate > 40) {
        actions.push(`🔴 SL rate ${slRate.toFixed(0)}% (${slHits.length}/${closedSignals.length}) — entry timing or TP needs review`)
        saveLearning({ key: "high_sl_rate", insight: `SL rate ${slRate.toFixed(0)}% over last ${closedSignals.length} trades — possible issues: entries too late, TP too ambitious, or wrong regime` })
      }
    }
  }

  const newActions = filterNewFindings("profit", actions)
  if (newActions.length) {
    logger.info(`[ProfitProtector] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("position_manager", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 6: SIGNAL QUALITY PRE-FILTER — local rules, no Claude
// Checks funding rate, momentum, volume anomalies to flag low-quality setups
// ══════════════════════════════════════════════════════════
export async function runSignalQualityFilter() {
  const db = await getDb()
  const actions = []

  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const market = await collectMarketContext()

  // 1. Funding rate extreme — signals against extreme funding are risky
  const onchain = market.onchain || []
  for (const s of active) {
    const coin = onchain.find(c => c.symbol === s.symbol?.replace("USDT", ""))
    if (!coin) continue

    // Extreme funding rate: LONG when funding > 0.06% = crowded long (risky)
    if (s.direction === "LONG" && coin.fr > 0.06) {
      actions.push(`⚠️ ${s.symbol} LONG but funding +${coin.fr?.toFixed(4)}% (crowded long) — higher reversal risk`)
    }
    if (s.direction === "SHORT" && coin.fr < -0.06) {
      actions.push(`⚠️ ${s.symbol} SHORT but funding ${coin.fr?.toFixed(4)}% (crowded short) — higher squeeze risk`)
    }

    // 2. Long/short ratio extreme — going against 70%+ crowd
    if (s.direction === "LONG" && coin.longPct > 70) {
      actions.push(`⚠️ ${s.symbol} LONG with ${coin.longPct}% longs — contrarian signal may be better`)
    }
    if (s.direction === "SHORT" && coin.longPct < 30) {
      actions.push(`⚠️ ${s.symbol} SHORT with only ${coin.longPct}% longs — contrarian signal may be better`)
    }

    // 3. Taker buy/sell ratio — >1 = more buying, <1 = more selling
    if (s.direction === "LONG" && coin.taker && coin.taker < 0.85) {
      actions.push(`⚠️ ${s.symbol} LONG nhưng taker ratio x${coin.taker?.toFixed(2)} (bên bán mạnh hơn)`)
    }
    if (s.direction === "SHORT" && coin.taker && coin.taker > 1.15) {
      actions.push(`⚠️ ${s.symbol} SHORT nhưng taker ratio x${coin.taker?.toFixed(2)} (bên mua mạnh hơn)`)
    }
  }

  // 4. Market-wide check: regime vs direction mismatch
  const regime = market.regime || "UNKNOWN"
  if (regime === "STRONG_BEAR" || regime === "BEAR") {
    const longs = active.filter(s => s.direction === "LONG")
    if (longs.length > 2) {
      actions.push(`⚠️ Regime ${regime} but ${longs.length} LONG signals active — reduce long exposure`)
    }
  }
  if (regime === "STRONG_BULL" || regime === "BULL") {
    const shorts = active.filter(s => s.direction === "SHORT")
    if (shorts.length > 2) {
      actions.push(`⚠️ Regime ${regime} but ${shorts.length} SHORT signals active — reduce short exposure`)
    }
  }

  // 5. Low confidence signals in bad market
  const guard = market.marketGuard
  if (guard?.riskLevel === "HIGH") {
    const lowConf = active.filter(s => (s.aiConfidence || 100) < 60)
    if (lowConf.length) {
      actions.push(`🔴 HIGH RISK market + ${lowConf.length} low-confidence signals (<60) — quality concern`)
    }
  }

  const newActions = filterNewFindings("signalQuality", actions)
  if (newActions.length) {
    logger.info(`[SignalQuality] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("signal_filter", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 7: PORTFOLIO RISK + DRAWDOWN RECOVERY (#2) + CORRELATION GUARD (#4)
// Auto-adjusts config when portfolio risk exceeds thresholds
// ══════════════════════════════════════════════════════════
export async function runPortfolioRisk() {
  const db = await getDb()
  const actions = []

  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  if (active.length < 2) return actions

  const symbols = active.map(s => s.symbol)
  const prices = await getPrices(symbols)

  // 1. Sector concentration — too many altcoins correlated with BTC
  const premiumCoins = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"])
  const altcoins = active.filter(s => !premiumCoins.has(s.symbol))
  const sameDirAlts = {}
  for (const s of altcoins) {
    const dir = s.direction
    sameDirAlts[dir] = (sameDirAlts[dir] || 0) + 1
  }

  // #4 Correlation Guard — auto-reduce maxActiveSignals when too concentrated
  const maxSameDir = Math.max(sameDirAlts.LONG || 0, sameDirAlts.SHORT || 0)
  const dominantDir = (sameDirAlts.LONG || 0) >= (sameDirAlts.SHORT || 0) ? "LONG" : "SHORT"
  if (maxSameDir >= 10) {
    actions.push(`🔴🔴 ${maxSameDir} altcoins ALL ${dominantDir} — extreme correlation risk`)
    await autoConfig("maxActiveSignals", 5, `Correlation guard: ${maxSameDir} same-dir positions`)
  } else if (maxSameDir >= 6) {
    actions.push(`🔴 ${maxSameDir} altcoins ALL ${dominantDir} — highly correlated, cascade risk`)
    await autoConfig("maxActiveSignals", 5, `Correlation guard: ${maxSameDir} same-dir positions`)
  } else if (maxSameDir >= 4) {
    actions.push(`⚠️ ${maxSameDir} altcoins ${dominantDir} — moderate correlation`)
  }

  // 2. Total unrealized PnL check — portfolio drawdown
  let totalUnrealized = 0
  for (const s of active) {
    const entry = s.gridAvgEntry || s.entryPrice
    const price = prices[s.symbol] || 0
    if (!entry || !price) continue
    const pnlPct = s.direction === "LONG"
      ? ((price - entry) / entry * 100)
      : ((entry - price) / entry * 100)
    totalUnrealized += (pnlPct / 100) * (s.simNotional || 1000)
  }

  // #2 Drawdown Recovery Mode — auto-adjust config based on drawdown severity
  const prevMode = _drawdownMode
  if (totalUnrealized < -300) {
    _drawdownMode = "DEFENSIVE"
    actions.push(`🔴🔴 DEFENSIVE MODE: drawdown $${totalUnrealized.toFixed(2)} — max protection`)
    await autoConfig("confidenceFloor", 72, `Defensive: drawdown $${totalUnrealized.toFixed(0)}`)
    await autoConfig("maxActiveSignals", 3, `Defensive: drawdown $${totalUnrealized.toFixed(0)}`)
    await autoConfig("riskScoreThreshold", 45, `Defensive: tighter risk filter`)
  } else if (totalUnrealized < -150) {
    _drawdownMode = "CAUTIOUS"
    actions.push(`🔴 CAUTIOUS MODE: drawdown $${totalUnrealized.toFixed(2)} — reduced risk`)
    await autoConfig("confidenceFloor", 70, `Cautious: drawdown $${totalUnrealized.toFixed(0)}`)
    await autoConfig("maxActiveSignals", 5, `Cautious: drawdown $${totalUnrealized.toFixed(0)}`)
    await autoConfig("riskScoreThreshold", 50, `Cautious: tighter risk filter`)
  } else if (totalUnrealized > -50 && prevMode !== "NORMAL") {
    _drawdownMode = "NORMAL"
    actions.push(`🟢 NORMAL MODE restored: unrealized $${totalUnrealized.toFixed(2)}`)
    await autoConfig("confidenceFloor", 68, `Recovery: normal mode restored`)
    await autoConfig("maxActiveSignals", 10, `Recovery: normal mode restored`)
    await autoConfig("riskScoreThreshold", 55, `Recovery: normal risk filter`)
  } else if (totalUnrealized < -100) {
    actions.push(`🔴 Portfolio unrealized: $${totalUnrealized.toFixed(2)} — monitoring (${_drawdownMode})`)
  }

  if (prevMode !== _drawdownMode) {
    actions.push(`📊 Mode: ${prevMode} → ${_drawdownMode}`)
    saveLearning({ key: "drawdown_mode_shift", insight: `Shifted ${prevMode}→${_drawdownMode} at unrealized $${totalUnrealized.toFixed(0)} with ${active.length} positions` })
  }

  // 3. Single coin over-exposure (multiple grid entries on one coin)
  const openOrders = await db.collection("orders").find({ status: "OPEN" }).toArray()
  const volByCoin = {}
  for (const o of openOrders) {
    volByCoin[o.symbol] = (volByCoin[o.symbol] || 0) + (o.notional || 0)
  }
  for (const [sym, vol] of Object.entries(volByCoin)) {
    const pct = (vol / 1000) * 100
    if (pct > 40) {
      actions.push(`⚠️ ${sym} exposure ${pct.toFixed(0)}% of wallet ($${vol.toFixed(0)}) — over-concentrated`)
    }
  }

  // 4. Win rate trend — recent 20 vs overall
  const allClosed = await db.collection("orders").find({ status: "CLOSED", type: "MAIN" }).sort({ closedAt: -1 }).toArray()
  if (allClosed.length >= 20) {
    const recent20 = allClosed.slice(0, 20)
    const recentWR = recent20.filter(o => (o.pnlUsdt || 0) > 0).length / 20 * 100
    const overallWR = allClosed.filter(o => (o.pnlUsdt || 0) > 0).length / allClosed.length * 100
    if (recentWR < overallWR - 15) {
      actions.push(`📉 WR declining: recent20 ${recentWR.toFixed(0)}% vs overall ${overallWR.toFixed(0)}% — performance degrading`)
    }
  }

  const newActions = filterNewFindings("portfolio", actions)
  if (newActions.length) {
    logger.info(`[PortfolioRisk] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("portfolio_risk", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 8: POST-TRADE LEARNING — analyze closed trades, build patterns
// ══════════════════════════════════════════════════════════
let lastLearnCheck = 0 // timestamp of last check
export async function runPostTradeLearning() {
  const db = await getDb()
  const actions = []

  // Only analyze trades closed since last check (or last 2h on first run)
  const since = lastLearnCheck || (Date.now() - 2 * 3600000)
  lastLearnCheck = Date.now()

  const recentClosed = await db.collection("ai_signals").find({
    status: "COMPLETED",
    positionClosedAt: { $gte: new Date(since) }
  }).toArray()

  if (!recentClosed.length) return actions

  for (const s of recentClosed) {
    const strategy = (s.strategy || "unknown").split("+")[0]
    const pnl = s.pnlUsdt || 0
    const won = pnl > 0
    const holdTime = s.positionClosedAt && s.executedAt
      ? Math.round((new Date(s.positionClosedAt) - new Date(s.executedAt)) / 3600000)
      : 0
    const hedgeCycles = s.hedgeCycleCount || 0
    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)

    // Build learning pattern
    const key = `trade_${s.symbol}_${strategy}_${won ? "win" : "loss"}`
    const insight = [
      `${s.symbol} ${s.direction} via ${strategy}:`,
      `PnL $${pnl.toFixed(2)} (${won ? "WIN" : "LOSS"})`,
      `Hold: ${holdTime}h`,
      hedgeCycles > 0 ? `Hedge: ${hedgeCycles} cycles, banked $${banked.toFixed(2)}` : "No hedge",
      `Confidence: ${s.aiConfidence || "?"}`,
      `Close: ${s.closeReason || "?"}`,
    ].join(" | ")

    saveLearning({ key, insight })
    actions.push(`📚 ${s.symbol}: ${won ? "WIN" : "LOSS"} $${pnl.toFixed(2)} (${strategy}, ${holdTime}h, hedge×${hedgeCycles})`)

    // Pattern detection: strategy + regime correlation
    if (!won && holdTime < 2) {
      saveLearning({
        key: `fast_loss_${strategy}`,
        insight: `${strategy} produced fast loss (<2h) on ${s.symbol} ${s.direction} — may need tighter entry conditions`
      })
    }
    if (won && banked > Math.abs(pnl) * 0.5) {
      saveLearning({
        key: `hedge_value_${strategy}`,
        insight: `Hedge added significant value on ${s.symbol}: banked $${banked.toFixed(2)} vs main PnL $${pnl.toFixed(2)}`
      })
    }
  }

  // Aggregate pattern: strategy win rates over recent trades
  const last50 = await db.collection("ai_signals").find({ status: "COMPLETED" })
    .sort({ positionClosedAt: -1 }).limit(50).toArray()
  const stratStats = {}
  for (const s of last50) {
    const st = (s.strategy || "unknown").split("+")[0]
    if (!stratStats[st]) stratStats[st] = { wins: 0, total: 0, pnl: 0 }
    stratStats[st].total++
    if ((s.pnlUsdt || 0) > 0) stratStats[st].wins++
    stratStats[st].pnl += s.pnlUsdt || 0
  }
  for (const [st, stats] of Object.entries(stratStats)) {
    if (stats.total >= 5) {
      const wr = (stats.wins / stats.total * 100).toFixed(0)
      saveLearning({
        key: `strategy_perf_${st}`,
        insight: `Last ${stats.total} trades: WR ${wr}% PnL $${stats.pnl.toFixed(2)} — ${wr >= 60 ? "strong" : wr >= 45 ? "average" : "weak"} performer`
      })
    }
  }

  // #5 Time-based Pattern Learning — WR by trading session
  if (last50.length >= 20) {
    const sessions = { ASIA: { wins: 0, total: 0 }, EU: { wins: 0, total: 0 }, US: { wins: 0, total: 0 } }
    for (const s of last50) {
      const hour = s.executedAt ? new Date(s.executedAt).getUTCHours() : -1
      if (hour < 0) continue
      const session = hour >= 0 && hour < 8 ? "ASIA" : hour >= 8 && hour < 16 ? "EU" : "US"
      sessions[session].total++
      if ((s.pnlUsdt || 0) > 0) sessions[session].wins++
    }
    for (const [sess, st] of Object.entries(sessions)) {
      if (st.total >= 5) {
        const wr = (st.wins / st.total * 100)
        saveLearning({ key: `session_wr_${sess}`, insight: `${sess} session WR: ${wr.toFixed(0)}% (${st.wins}/${st.total}) — ${wr >= 60 ? "good" : wr < 40 ? "poor, consider pausing" : "average"}` })
        if (wr < 35 && st.total >= 8) {
          actions.push(`📉 ${sess} session WR only ${wr.toFixed(0)}% (${st.total} trades) — consider reducing activity`)
        }
      }
    }

    // #5 Day-of-week pattern
    const dayStats = {}
    for (const s of last50) {
      const day = s.executedAt ? new Date(s.executedAt).getUTCDay() : -1
      if (day < 0) continue
      const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day]
      if (!dayStats[dayName]) dayStats[dayName] = { wins: 0, total: 0 }
      dayStats[dayName].total++
      if ((s.pnlUsdt || 0) > 0) dayStats[dayName].wins++
    }
    const bestDay = Object.entries(dayStats).filter(([,s]) => s.total >= 3).sort((a,b) => (b[1].wins/b[1].total) - (a[1].wins/a[1].total))[0]
    const worstDay = Object.entries(dayStats).filter(([,s]) => s.total >= 3).sort((a,b) => (a[1].wins/a[1].total) - (b[1].wins/b[1].total))[0]
    if (bestDay && worstDay && bestDay[0] !== worstDay[0]) {
      saveLearning({ key: "day_pattern", insight: `Best day: ${bestDay[0]} (WR ${(bestDay[1].wins/bestDay[1].total*100).toFixed(0)}%), Worst: ${worstDay[0]} (WR ${(worstDay[1].wins/worstDay[1].total*100).toFixed(0)}%)` })
    }
  }

  const newActions = filterNewFindings("learning", actions)
  if (newActions.length) {
    logger.info(`[PostTradeLearning] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.learning("post_trade", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 9: SMART ALERTS — event-driven anomaly detection
// ══════════════════════════════════════════════════════════
let prevFundingRates = {} // track previous FR for spike detection
let prevRegime = null
export async function runSmartAlerts() {
  const db = await getDb()
  const actions = []
  const market = await collectMarketContext()

  // 1. Funding rate spike detection (>0.03% change since last check)
  const onchain = market.onchain || []
  for (const coin of onchain) {
    const prev = prevFundingRates[coin.symbol] || 0
    const curr = coin.fr || 0
    const delta = Math.abs(curr - prev)
    if (prev !== 0 && delta > 0.03) {
      const dir = curr > prev ? "spiked UP" : "spiked DOWN"
      actions.push(`🚨 ${coin.symbol} funding ${dir}: ${prev.toFixed(4)}% → ${curr.toFixed(4)}% (Δ${delta.toFixed(4)}%)`)
    }
    prevFundingRates[coin.symbol] = curr
  }

  // 2. Regime change detection
  const regime = market.regime || "UNKNOWN"
  if (prevRegime && prevRegime !== regime && regime !== "UNKNOWN") {
    actions.push(`🔄 REGIME SHIFT: ${prevRegime} → ${regime} — review config alignment!`)
  }
  prevRegime = regime

  // 3. Extreme market conditions
  const fundingSummary = market.fundingSummary
  if (fundingSummary?.extreme === "HIGH_LONG") {
    actions.push(`🚨 Market-wide HIGH LONG funding (avg ${fundingSummary.avgFR?.toFixed(4)}%) — long squeeze risk`)
  }
  if (fundingSummary?.extreme === "HIGH_SHORT") {
    actions.push(`🚨 Market-wide HIGH SHORT funding (avg ${fundingSummary.avgFR?.toFixed(4)}%) — short squeeze risk`)
  }

  // 4. Alt pulse divergence — alts moving opposite to BTC
  const altPulse = market.altPulse
  if (altPulse) {
    if (altPulse.signal === "BEARISH" && regime === "BULL") {
      actions.push(`⚠️ Alt pulse BEARISH while regime BULL — altcoins lagging, possible rotation`)
    }
    if (altPulse.signal === "BULLISH" && regime === "BEAR") {
      actions.push(`⚠️ Alt pulse BULLISH while regime BEAR — possible alt rally forming`)
    }
    // Extreme alt move
    if (altPulse.avgChange4h && Math.abs(altPulse.avgChange4h) > 5) {
      const dir = altPulse.avgChange4h > 0 ? "pump" : "dump"
      actions.push(`🚨 Extreme alt ${dir}: avg 4h change ${altPulse.avgChange4h.toFixed(2)}% — high volatility`)
    }
  }

  // 5. Consecutive loss detection (last 5 trades all losses)
  const recentMain = await db.collection("orders").find({ status: "CLOSED", type: "MAIN" })
    .sort({ closedAt: -1 }).limit(5).toArray()
  if (recentMain.length === 5 && recentMain.every(o => (o.pnlUsdt || 0) < 0)) {
    const totalLoss = recentMain.reduce((s, o) => s + (o.pnlUsdt || 0), 0)
    actions.push(`🔴 5 consecutive losses ($${totalLoss.toFixed(2)}) — consider pausing or reducing size`)
  }

  // 6. Large position PnL swing (>8% move from entry on active positions)
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const livePrices = await getPrices(active.map(s => s.symbol))
  for (const s of active) {
    const entry = s.gridAvgEntry || s.entryPrice
    const price = livePrices[s.symbol] || 0
    if (!entry || !price) continue
    const movePct = Math.abs((price - entry) / entry * 100)
    if (movePct > 8) {
      const dir = price > entry ? "UP" : "DOWN"
      actions.push(`🚨 ${s.symbol} moved ${movePct.toFixed(1)}% ${dir} from entry — extreme position`)
    }
  }

  // #9 Market Microstructure Alerts

  // 9a. Funding rate divergence — funding going opposite to price trend
  for (const coin of onchain) {
    const matchingSignal = active.find(s => s.symbol === `${coin.symbol}USDT`)
    if (!matchingSignal) continue
    const entry = matchingSignal.gridAvgEntry || matchingSignal.entryPrice
    const price = livePrices[matchingSignal.symbol] || 0
    if (!entry || !price) continue
    const priceUp = price > entry
    // Divergence: price going up but funding extremely negative (shorts paying longs) = unusual
    if (priceUp && coin.fr < -0.04) {
      actions.push(`🔍 ${coin.symbol}: price UP but funding negative (${coin.fr?.toFixed(4)}%) — shorts still building, potential squeeze continuation`)
    }
    if (!priceUp && coin.fr > 0.04) {
      actions.push(`🔍 ${coin.symbol}: price DOWN but funding positive (${coin.fr?.toFixed(4)}%) — longs overleveraged, potential liquidation cascade`)
    }
  }

  // 9b. Volume spike detection — taker ratio extreme across multiple coins
  // Send to bot as market hints for strategy confidence boost
  // takerBuyRatio: >1 = more buying, <1 = more selling. 1.2+ = extreme buy, 0.8- = extreme sell
  const extremeTakers = onchain.filter(c => c.taker && (c.taker > 1.2 || c.taker < 0.8))
  if (extremeTakers.length >= 3) {
    const buyCoins = extremeTakers.filter(c => c.taker > 1.2).sort((a, b) => b.taker - a.taker)
    const sellCoins = extremeTakers.filter(c => c.taker < 0.8).sort((a, b) => a.taker - b.taker)
    if (buyCoins.length >= 3) {
      const topBuyers = buyCoins.slice(0, 8).map(c => `${c.symbol}(x${c.taker.toFixed(2)})`).join(", ")
      actions.push(`🚨 ${buyCoins.length} coins áp lực MUA cực mạnh: ${topBuyers}`)
    }
    if (sellCoins.length >= 3) {
      const topSellers = sellCoins.slice(0, 8).map(c => `${c.symbol}(x${c.taker.toFixed(2)})`).join(", ")
      actions.push(`🚨 ${sellCoins.length} coins áp lực BÁN cực mạnh: ${topSellers}`)
    }

    // Send hints to bot for strategy boost
    try {
      const takerDetails = {}
      for (const c of extremeTakers) takerDetails[c.symbol] = c.taker
      await axios.post(`${BASE}/admin/agent/market-hints`, {
        takerBuyCoins: buyCoins.map(c => c.symbol),
        takerSellCoins: sellCoins.map(c => c.symbol),
        takerDetails,
      }, { timeout: 5000 })
      logger.info(`[SmartAlerts] Đã gửi ${extremeTakers.length} market hints cho bot (buy=${buyCoins.length}, sell=${sellCoins.length})`)
    } catch (err) {
      logger.warn(`[SmartAlerts] Gửi market hints thất bại: ${err.message}`)
    }
  }

  // 9c. Funding rate clustering — when many coins have extreme same-direction funding
  const highFR = onchain.filter(c => (c.fr || 0) > 0.05)
  const lowFR = onchain.filter(c => (c.fr || 0) < -0.05)
  if (highFR.length >= 4) {
    const topFR = highFR.sort((a, b) => b.fr - a.fr).slice(0, 6).map(c => `${c.symbol}(${c.fr?.toFixed(3)}%)`).join(", ")
    actions.push(`🚨 ${highFR.length} coins FR dương cao: ${topFR} — long tập trung, rủi ro squeeze`)
  }
  if (lowFR.length >= 4) {
    const topFR = lowFR.sort((a, b) => a.fr - b.fr).slice(0, 6).map(c => `${c.symbol}(${c.fr?.toFixed(3)}%)`).join(", ")
    actions.push(`🚨 ${lowFR.length} coins FR âm cao: ${topFR} — short tập trung, rủi ro squeeze`)
  }

  const newActions = filterNewFindings("alerts", actions)
  if (newActions.length) {
    logger.info(`[SmartAlerts] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("smart_alert", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 10: DYNAMIC SL/TP per ATR — volatility-aware TP/SL recommendations
// ══════════════════════════════════════════════════════════
export async function runDynamicSlTp() {
  const findings = []
  try {
    const res = await getSignals({ status: "ACTIVE", limit: 50 })
    const signals = res?.data || res?.signals || []
    if (!Array.isArray(signals) || signals.length === 0) return findings

    for (const sig of signals) {
      const symbol = sig.symbol
      if (!symbol) continue
      try {
        // Fetch 4h candles for ATR calculation
        const candleRes = await axios.get(BASE + "/admin/market-data/candles", {
          params: { symbol, interval: "4h", limit: 15 },
          timeout: 5000,
        }).catch(() => null)

        let atrPct = 0
        if (candleRes?.data?.length >= 2) {
          const candles = candleRes.data
          // Calculate ATR% from candle high-low ranges
          let trSum = 0
          for (let i = 1; i < candles.length; i++) {
            const high = parseFloat(candles[i].high || candles[i].h || 0)
            const low = parseFloat(candles[i].low || candles[i].l || 0)
            const prevClose = parseFloat(candles[i - 1].close || candles[i - 1].c || 0)
            if (!prevClose) continue
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
            trSum += (tr / prevClose) * 100
          }
          atrPct = trSum / (candles.length - 1)
        } else {
          // Fallback: estimate from signal entry vs current price volatility
          continue
        }

        const tp = sig.takeProfitPercent || 2.5
        const sl = sig.stopLossPercent || 40

        if (atrPct > 3 && tp <= 2.5) {
          findings.push(`${symbol}: ATR=${atrPct.toFixed(1)}% but TP only ${tp}% → TP too conservative, suggest ${Math.min(atrPct * 1.2, 8).toFixed(1)}%`)
        }
        if (atrPct < 1 && sl >= 40) {
          findings.push(`${symbol}: ATR=${atrPct.toFixed(1)}% but SL=${sl}% → SL too wide for low-vol coin, suggest ${Math.max(atrPct * 5, 5).toFixed(0)}%`)
        }
        if (atrPct > 5 && tp < 4) {
          findings.push(`${symbol}: High ATR=${atrPct.toFixed(1)}% — consider widening TP to capture full move`)
        }
      } catch (err) {
        logger.debug(`[DynamicSlTp] ${symbol} candle fetch error: ${err.message}`)
      }
    }
  } catch (err) {
    logger.warn(`[DynamicSlTp] Failed to fetch active signals: ${err.message}`)
  }

  const newFindings = filterNewFindings("dynamicSlTp", findings)
  if (newFindings.length) {
    logger.info(`[DynamicSlTp] ${newFindings.join(" | ")}`)
    if (!_silent) for (const f of newFindings) await agentLog.thought("dynamic_sl_tp", f)
  }
  return findings
}

// ══════════════════════════════════════════════════════════
// SKILL 11: REGIME WATCH — BTC rapid move detector
// ══════════════════════════════════════════════════════════
let _lastBtcPrice = null
let _lastBtcPriceTime = 0
export async function runRegimeWatch() {
  const alerts = []
  try {
    const redis = (await import("redis")).createClient({
      url: `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}`,
      database: parseInt(process.env.REDIS_DB || "2"),
    })
    redis.on("error", () => {})
    await redis.connect()

    // Get current BTC price from bot's price cache
    const btcPriceRaw = await redis.get("binance-bot:price:BTCUSDT")
    const btcPrice = btcPriceRaw ? parseFloat(btcPriceRaw) : 0
    if (!btcPrice) {
      await redis.quit()
      return alerts
    }

    // Get stored 30min-ago price
    const storedKey = "binance-telebot:cache:agent:btc-price-30m"
    const storedRaw = await redis.get(storedKey)
    const stored = storedRaw ? JSON.parse(storedRaw) : null
    const now = Date.now()

    if (stored && stored.price > 0) {
      const elapsed = (now - stored.time) / 1000 / 60 // minutes
      if (elapsed >= 25) {
        // Compare with stored price (approx 30min ago)
        const movePct = Math.abs((btcPrice - stored.price) / stored.price * 100)
        const dir = btcPrice > stored.price ? "UP" : "DOWN"

        if (movePct > 3) {
          alerts.push(`🚨 CRITICAL: BTC moved ${movePct.toFixed(2)}% ${dir} in ~${Math.round(elapsed)}min ($${stored.price.toFixed(0)} → $${btcPrice.toFixed(0)}) — regime transition likely!`)
        } else if (movePct > 2) {
          alerts.push(`⚠️ BTC moved ${movePct.toFixed(2)}% ${dir} in ~${Math.round(elapsed)}min ($${stored.price.toFixed(0)} → $${btcPrice.toFixed(0)}) — regime transition risk`)
        }

        // Update stored price for next check
        await redis.set(storedKey, JSON.stringify({ price: btcPrice, time: now }))
      }
    } else {
      // First run or expired — store current price
      await redis.set(storedKey, JSON.stringify({ price: btcPrice, time: now }))
    }

    await redis.quit()
  } catch (err) {
    logger.warn(`[RegimeWatch] Error: ${err.message}`)
  }

  const newAlerts = filterNewFindings("regimeWatch", alerts)
  if (newAlerts.length) {
    logger.info(`[RegimeWatch] ${newAlerts.join(" | ")}`)
    if (!_silent) for (const a of newAlerts) await agentLog.thought("regime_watch", a)
  }
  return alerts
}

// ══════════════════════════════════════════════════════════
// SKILL 12: LIQUIDATION RISK MONITOR — leverage exposure tracking
// ══════════════════════════════════════════════════════════
export async function runLiquidationRisk() {
  const alerts = []
  try {
    const db = await getDb()
    const WALLET_BALANCE = 1000 // default assumed balance

    // Get all active signals
    const activeSignals = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
    if (activeSignals.length === 0) return alerts

    let totalNotional = 0
    for (const sig of activeSignals) {
      // Main position notional
      const mainNotional = sig.simNotional || 0
      totalNotional += mainNotional

      // Sum open orders (includes DCA grids + hedge)
      const openOrders = await db.collection("orders").find({
        signalId: sig._id, status: "OPEN",
      }).toArray()
      for (const o of openOrders) {
        totalNotional += (o.notional || 0)
      }
    }

    const effectiveLeverage = totalNotional / WALLET_BALANCE

    if (effectiveLeverage > 8) {
      alerts.push(`🚨 CRITICAL: Effective leverage ${effectiveLeverage.toFixed(1)}x ($${totalNotional.toFixed(0)} / $${WALLET_BALANCE}) — REDUCE exposure! Consider lowering maxActiveSignals`)
      // Auto-reduce maxActiveSignals if critically overleveraged
      const currentActive = activeSignals.length
      if (currentActive > 3) {
        await autoConfig("maxActiveSignals", Math.max(5, currentActive - 2), `leverage ${effectiveLeverage.toFixed(1)}x > 8x`)
      }
    } else if (effectiveLeverage > 5) {
      alerts.push(`⚠️ High leverage ${effectiveLeverage.toFixed(1)}x ($${totalNotional.toFixed(0)} / $${WALLET_BALANCE}) — monitor closely`)
    }

    // Per-signal concentration check
    for (const sig of activeSignals) {
      const sigNotional = sig.simNotional || 0
      const concentration = (sigNotional / totalNotional) * 100
      if (concentration > 40 && totalNotional > WALLET_BALANCE * 3) {
        alerts.push(`⚠️ ${sig.symbol}: ${concentration.toFixed(0)}% of total exposure — high concentration risk`)
      }
    }
  } catch (err) {
    logger.warn(`[LiquidationRisk] Error: ${err.message}`)
  }

  const newAlerts = filterNewFindings("liquidationRisk", alerts)
  if (newAlerts.length) {
    logger.info(`[LiquidationRisk] ${newAlerts.join(" | ")}`)
    if (!_silent) for (const a of newAlerts) await agentLog.thought("liquidation_risk", a)
  }
  return alerts
}

// ══════════════════════════════════════════════════════════
// RUN ALL SKILLS
// ══════════════════════════════════════════════════════════
export async function runAllSkills(silent = false) {
  const prevSilent = _silent
  _silent = silent
  const results = {
    dataFixes: await runDataValidator(),
    hedgeActions: await runHedgeManager(),
    strategyAdvice: await runStrategyTuner(),
    exposureAlerts: await runExposureManager(),
    profitAlerts: await runProfitProtector(),
    signalQuality: await runSignalQualityFilter(),
    portfolioRisk: await runPortfolioRisk(),
    tradeLearnings: await runPostTradeLearning(),
    smartAlerts: await runSmartAlerts(),
    dynamicSlTp: await runDynamicSlTp(),
    regimeWatch: await runRegimeWatch(),
    liquidationRisk: await runLiquidationRisk(),
  }
  _silent = prevSilent

  // ── Compile & send Agent Brain to bot ──
  try {
    await sendAgentBrain()
  } catch (err) {
    logger.warn(`[Skills] Gửi brain thất bại: ${err.message}`)
  }

  const totalActions = Object.values(results).flat().length
  logger.info(`[Skills] Ran 12 skills — ${totalActions} total findings`)
  return results
}

// ── Agent Brain: compile all insights into one payload for bot strategy ──
async function sendAgentBrain() {
  const db = await getDb()

  // 1. Session WR from recent 50 closed signals
  const last50 = await db.collection("ai_signals").find({ status: "COMPLETED" })
    .sort({ completedAt: -1 }).limit(50).toArray()
  const sessionWR = {}
  if (last50.length >= 10) {
    const sessions = { ASIA: { wins: 0, total: 0 }, EU: { wins: 0, total: 0 }, US: { wins: 0, total: 0 } }
    for (const s of last50) {
      const hour = s.executedAt ? new Date(s.executedAt).getUTCHours() : -1
      if (hour < 0) continue
      const sess = hour >= 0 && hour < 8 ? "ASIA" : hour >= 8 && hour < 16 ? "EU" : "US"
      sessions[sess].total++
      if ((s.pnlUsdt || 0) > 0) sessions[sess].wins++
    }
    for (const [sess, st] of Object.entries(sessions)) {
      if (st.total >= 3) {
        sessionWR[sess] = Math.round(st.wins / st.total * 100)
        sessionWR[`${sess}_total`] = st.total
      }
    }
  }

  // 2. Consecutive losses
  const recentMain = await db.collection("orders").find({ status: "CLOSED", type: { $in: ["MAIN", "FLIP_MAIN"] } })
    .sort({ closedAt: -1 }).limit(5).toArray()
  const consecutiveLosses = recentMain.length === 5 && recentMain.every(o => (o.pnlUsdt || 0) < 0) ? 5 : 0

  // 3. Cold coins — symbols with WR < 30% on 5+ trades
  const coldCoins = []
  const symbolStats = {}
  for (const s of last50) {
    const sym = s.symbol
    if (!symbolStats[sym]) symbolStats[sym] = { wins: 0, total: 0 }
    symbolStats[sym].total++
    if ((s.pnlUsdt || 0) > 0) symbolStats[sym].wins++
  }
  for (const [sym, st] of Object.entries(symbolStats)) {
    if (st.total >= 5 && (st.wins / st.total) < 0.30) coldCoins.push(sym)
  }

  // 4. Hot coins — from market hints (already sent separately, include here too)
  let takerBuyCoins = [], takerSellCoins = [], takerDetails = {}
  try {
    const hintsRes = await axios.get(`${BASE}/admin/agent/market-hints`, { timeout: 3000 })
    const hints = hintsRes.data || {}
    takerBuyCoins = hints.takerBuyCoins || []
    takerSellCoins = hints.takerSellCoins || []
    takerDetails = hints.takerDetails || {}
  } catch {}

  // 5. Market context
  const ctx = await collectMarketContext()
  const altPulse = ctx?.altPulse?.signal || null
  const fundingExtreme = ctx?.fundingSummary?.extreme || null
  const regime = ctx?.regime || "MIXED"

  // 6. Direction blocks based on regime + funding
  let blockLong = false, blockShort = false, blockLongReason = "", blockShortReason = ""
  if (regime === "STRONG_BEAR" || regime === "BEAR") {
    if (fundingExtreme === "HIGH_LONG") {
      blockLong = true
      blockLongReason = `${regime} regime + crowded long funding → rủi ro squeeze`
    }
  }
  if (regime === "STRONG_BULL" || regime === "BULL") {
    if (fundingExtreme === "HIGH_SHORT") {
      blockShort = true
      blockShortReason = `${regime} regime + crowded short funding → rủi ro squeeze`
    }
  }

  // 7. TP suggestion from profit protector analysis
  let tpSuggestion = null
  const tpHits = last50.filter(s => (s.closeReason || "").includes("TP"))
  const trailHits = last50.filter(s => (s.closeReason || "").includes("TRAIL"))
  if (trailHits.length > tpHits.length * 2 && trailHits.length >= 5) {
    const avgTrailPnl = trailHits.reduce((sum, s) => sum + (s.pnlPercent || 0), 0) / trailHits.length
    if (avgTrailPnl > 0 && avgTrailPnl < 3) tpSuggestion = Math.round(avgTrailPnl * 10) / 10
  }

  // 8. Hedge intelligence — per-coin effectiveness from order history
  const hedgeSkipCoins = [] // coins where hedge is ineffective (<30% profitable)
  const hedgeBoostCoins = [] // coins where hedge works great (>70% profitable)
  const activeSignals = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  for (const sig of activeSignals) {
    const closedHedges = await db.collection("orders").find({
      signalId: sig._id, type: "HEDGE", status: "CLOSED"
    }).toArray()
    if (closedHedges.length >= 5) {
      const profitCycles = closedHedges.filter(o => (o.pnlUsdt || 0) > 1).length
      const effectiveRate = profitCycles / closedHedges.length * 100
      if (effectiveRate < 30) hedgeSkipCoins.push(sig.symbol)
      if (effectiveRate > 70) hedgeBoostCoins.push(sig.symbol)
    }
  }

  // 9. Volatility-based hedge threshold suggestion
  const prices = await getPrices(activeSignals.map(s => s.symbol))
  let totalAbsPnl = 0, priceCount = 0
  for (const s of activeSignals) {
    const entry = s.gridAvgEntry || s.entryPrice
    const price = prices[s.symbol] || 0
    if (!entry || !price) continue
    totalAbsPnl += Math.abs((price - entry) / entry * 100)
    priceCount++
  }
  const avgVolatility = priceCount > 0 ? totalAbsPnl / priceCount : 0
  // High vol → suggest higher hedge trigger, low vol → suggest tighter
  let hedgeTriggerSuggestion = null
  if (avgVolatility > 6) hedgeTriggerSuggestion = 4 // don't trigger too early in high vol
  else if (avgVolatility < 2) hedgeTriggerSuggestion = 2 // tighter trigger in low vol

  const brain = {
    drawdownMode: _drawdownMode,
    blockLong,
    blockShort,
    blockLongReason,
    blockShortReason,
    riskLevel: _drawdownMode === "DEFENSIVE" ? "HIGH" : _drawdownMode === "CAUTIOUS" ? "MEDIUM" : "NORMAL",
    regime,
    sessionWR,
    hotCoins: takerBuyCoins.slice(0, 5),
    coldCoins,
    takerBuyCoins,
    takerSellCoins,
    takerDetails,
    fundingExtreme,
    altPulse,
    consecutiveLosses,
    tpSuggestion,
    // Hedge intelligence
    hedgeSkipCoins,
    hedgeBoostCoins,
    hedgeTriggerSuggestion,
    avgVolatility: Math.round(avgVolatility * 10) / 10,
  }

  await axios.post(`${BASE}/admin/agent/brain`, brain, { timeout: 5000 })
  logger.info(`[Brain] Đã gửi: mode=${_drawdownMode} blockL=${blockLong} blockS=${blockShort} cold=${coldCoins.length} sessions=${JSON.stringify(sessionWR)}`)
}
