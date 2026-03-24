import { getDb } from "../utils/db.js"
import { logger } from "../utils/logger.js"
import * as agentLog from "../utils/agentLogger.js"

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
    for (const f of fixes) await agentLog.action("bug_detector", f, "DATA_FIX")
  }
  return fixes
}

// ══════════════════════════════════════════════════════════
// SKILL 2: HEDGE MANAGER — auto-manage hedge positions
// ══════════════════════════════════════════════════════════
export async function runHedgeManager() {
  const db = await getDb()
  const actions = []

  const active = await db.collection("ai_signals").find({ status: "ACTIVE", hedgeActive: true }).toArray()

  for (const s of active) {
    const entry = s.gridAvgEntry || s.entryPrice
    const banked = (s.hedgeHistory || []).reduce((sum, h) => sum + (h.pnlUsdt || 0), 0)
    const mainNotional = s.simNotional || 1000

    // NET_POSITIVE check: banked hedge > estimated main loss
    if (banked > 0 && entry > 0 && s.hedgeEntryPrice > 0) {
      const hedgeOpenOrders = await db.collection("orders").find({ signalId: s._id, type: "HEDGE", status: "OPEN" }).toArray()
      const totalHedgeVol = hedgeOpenOrders.reduce((sum, o) => sum + (o.notional || 0), 0)

      // If banked is substantial and covers estimated loss
      if (banked > mainNotional * 0.05) {
        actions.push(`${s.symbol}: hedge banked $${banked.toFixed(2)} (${(banked / mainNotional * 100).toFixed(1)}% of vol) — monitoring for NET_POSITIVE`)
      }
    }

    // Hedge spam check: too many breakeven cycles
    const beCycles = (s.hedgeHistory || []).filter(h => Math.abs(h.pnlUsdt || 0) < 1).length
    if (beCycles >= 3 && s.hedgeCycleCount >= 5) {
      actions.push(`${s.symbol}: ${beCycles} breakeven cycles out of ${s.hedgeCycleCount} — hedge may be ineffective`)
    }
  }

  if (actions.length) {
    logger.info(`[HedgeManager] ${actions.join(" | ")}`)
    for (const a of actions) await agentLog.thought("position_manager", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 3: STRATEGY TUNER — auto-enable/disable strategies
// ══════════════════════════════════════════════════════════
export async function runStrategyTuner() {
  const db = await getDb()
  const actions = []

  const completed = await db.collection("ai_signals").find({ status: "COMPLETED" }).toArray()
  const stratPerf = {}

  for (const s of completed) {
    const st = s.strategy || "unknown"
    const base = st.split("+")[0] // handle confluence like "EMA_PULLBACK+SMC_FVG"
    if (!stratPerf[base]) stratPerf[base] = { count: 0, wins: 0, pnl: 0, recent: [] }
    stratPerf[base].count++
    if ((s.pnlUsdt || 0) > 0) stratPerf[base].wins++
    stratPerf[base].pnl += s.pnlUsdt || 0
    stratPerf[base].recent.push({ pnl: s.pnlUsdt || 0, date: s.positionClosedAt })
  }

  for (const [name, s] of Object.entries(stratPerf)) {
    if (s.count < 5) continue
    const wr = (s.wins / s.count * 100)

    // Recent 5 trades performance
    const recent5 = s.recent.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5)
    const recent5Pnl = recent5.reduce((sum, t) => sum + t.pnl, 0)
    const recent5WR = recent5.filter(t => t.pnl > 0).length / recent5.length * 100

    if (wr < 40) actions.push(`⚠️ ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)} — recommend DISABLE`)
    else if (wr >= 70) actions.push(`✅ ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)} — performing well`)
    if (recent5WR < 20 && s.count >= 8) actions.push(`🔴 ${name}: recent 5 WR ${recent5WR.toFixed(0)}% PnL $${recent5Pnl.toFixed(2)} — declining`)
  }

  if (actions.length) {
    logger.info(`[StrategyTuner] ${actions.join(" | ")}`)
    for (const a of actions) await agentLog.thought("strategy_tuner", a)
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

  if (actions.length) {
    logger.info(`[ExposureManager] ${actions.join(" | ")}`)
    for (const a of actions) await agentLog.thought("market_analyzer", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 5: PROFIT PROTECTOR — monitor winning positions
// ══════════════════════════════════════════════════════════
export async function runProfitProtector() {
  const db = await getDb()
  const actions = []

  // Check winning closed orders in last hour that could have been held longer
  const oneHourAgo = new Date(Date.now() - 3600000)
  const recentWins = await db.collection("orders").find({
    status: "CLOSED", type: "MAIN", pnlUsdt: { $gt: 0 }, closedAt: { $gte: oneHourAgo }
  }).toArray()

  for (const o of recentWins) {
    if (o.closeReason === "TRAIL_STOP" && o.pnlPercent < 1.5) {
      actions.push(`${o.symbol}: trail closed at +${o.pnlPercent?.toFixed(2)}% ($${o.pnlUsdt?.toFixed(2)}) — trail may be too tight`)
    }
  }

  // Check active signals with high unrealized profit (> 3%) — should have trail active
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  for (const s of active) {
    if (s.peakPnlPct && s.peakPnlPct > 3 && !s.slMovedToEntry) {
      actions.push(`${s.symbol}: peak ${s.peakPnlPct.toFixed(2)}% but SL not moved to entry — profit unprotected`)
    }
  }

  if (actions.length) {
    logger.info(`[ProfitProtector] ${actions.join(" | ")}`)
    for (const a of actions) await agentLog.thought("position_manager", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// RUN ALL SKILLS
// ══════════════════════════════════════════════════════════
export async function runAllSkills() {
  const results = {
    dataFixes: await runDataValidator(),
    hedgeActions: await runHedgeManager(),
    strategyAdvice: await runStrategyTuner(),
    exposureAlerts: await runExposureManager(),
    profitAlerts: await runProfitProtector()
  }

  const totalActions = Object.values(results).flat().length
  logger.info(`[Skills] Ran 5 skills — ${totalActions} total findings`)
  return results
}
