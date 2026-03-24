import { getDb } from "../utils/db.js"
import { logger } from "../utils/logger.js"

export async function checkTradingHealth() {
  const db = await getDb()
  const report = {}

  // ══════════════════════════════════════════════════════
  // 1. DATA INTEGRITY — check corrupted/mismatched data
  // ══════════════════════════════════════════════════════
  const dataIssues = []

  // Orders with impossible PnL (> 50% on single trade)
  const badPnl = await db.collection("orders").find({
    status: "CLOSED", $or: [{ pnlPercent: { $gt: 50 } }, { pnlPercent: { $lt: -50 } }]
  }).toArray()
  if (badPnl.length) dataIssues.push(`${badPnl.length} orders with impossible PnL (>50%)`)

  // Orders with entry price vastly different from signal entry
  const openOrders = await db.collection("orders").find({ status: "OPEN" }).toArray()
  for (const o of openOrders) {
    const sig = await db.collection("ai_signals").findOne({ _id: o.signalId })
    if (sig && o.entryPrice > 0 && sig.entryPrice > 0) {
      const diff = Math.abs(o.entryPrice - sig.entryPrice) / sig.entryPrice * 100
      if (diff > 20) dataIssues.push(`${o.symbol} order entry $${o.entryPrice} vs signal $${sig.entryPrice} (${diff.toFixed(0)}% diff)`)
    }
  }

  // Signals COMPLETED but orders still OPEN
  const completedSigs = await db.collection("ai_signals").find({ status: "COMPLETED" }).toArray()
  for (const s of completedSigs) {
    const openOrd = await db.collection("orders").countDocuments({ signalId: s._id, status: "OPEN" })
    if (openOrd > 0) dataIssues.push(`${s.symbol} completed but has ${openOrd} OPEN orders`)
  }

  report.dataIssues = dataIssues

  // ══════════════════════════════════════════════════════
  // 2. ACTIVE SIGNALS HEALTH
  // ══════════════════════════════════════════════════════
  const active = await db.collection("ai_signals").find({ status: "ACTIVE" }).toArray()
  const activeIssues = []

  for (const s of active) {
    const orders = await db.collection("orders").countDocuments({ signalId: s._id })
    const grids = (s.gridLevels || []).length
    if (grids === 0) activeIssues.push(`${s.symbol}: NO GRIDS`)
    if (orders === 0) activeIssues.push(`${s.symbol}: NO ORDERS`)
    if (s.stopLossPrice > 0 && !s.hedgeActive) activeIssues.push(`${s.symbol}: SL=${s.stopLossPrice} should be 0`)
  }
  report.activeSignals = active.length
  report.activeIssues = activeIssues

  // Orphaned orders
  let orphaned = 0
  for (const o of openOrders) {
    const sig = await db.collection("ai_signals").findOne({ _id: o.signalId, status: "ACTIVE" })
    if (!sig) orphaned++
  }
  report.orphanedOrders = orphaned

  // ══════════════════════════════════════════════════════
  // 3. TRADING PERFORMANCE
  // ══════════════════════════════════════════════════════
  const closed = await db.collection("orders").find({ status: "CLOSED" }).toArray()
  let mainPnl = 0, hedgePnl = 0, mainW = 0, mainL = 0, totalFees = 0
  for (const o of closed) {
    const pnl = o.pnlUsdt || 0
    const fees = (o.entryFeeUsdt || 0) + (o.exitFeeUsdt || 0) + (o.fundingFeeUsdt || 0)
    totalFees += fees
    if (o.type === "HEDGE") hedgePnl += pnl
    else { mainPnl += pnl; if (pnl > 0) mainW++; else mainL++ }
  }
  report.pnl = { main: +mainPnl.toFixed(2), hedge: +hedgePnl.toFixed(2), net: +(mainPnl + hedgePnl).toFixed(2), fees: +totalFees.toFixed(2) }
  report.winRate = mainW + mainL > 0 ? +((mainW / (mainW + mainL)) * 100).toFixed(1) : 0
  report.wallet = +(1000 + mainPnl + hedgePnl).toFixed(2)

  // ══════════════════════════════════════════════════════
  // 4. STRATEGY PERFORMANCE — enable/disable recommendations
  // ══════════════════════════════════════════════════════
  const stratPerf = {}
  for (const s of completedSigs) {
    const st = s.strategy || "unknown"
    if (!stratPerf[st]) stratPerf[st] = { count: 0, wins: 0, pnl: 0 }
    stratPerf[st].count++
    if ((s.pnlUsdt || 0) > 0) stratPerf[st].wins++
    stratPerf[st].pnl += s.pnlUsdt || 0
  }
  const stratRecommendations = []
  for (const [name, s] of Object.entries(stratPerf)) {
    const wr = s.count > 0 ? (s.wins / s.count * 100) : 0
    if (s.count >= 5 && wr < 40) stratRecommendations.push(`DISABLE ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}), PnL $${s.pnl.toFixed(2)}`)
    if (s.count >= 5 && wr >= 70) stratRecommendations.push(`BOOST ${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}), PnL $${s.pnl.toFixed(2)}`)
  }
  report.strategyPerformance = stratPerf
  report.strategyRecommendations = stratRecommendations

  // ══════════════════════════════════════════════════════
  // 5. HEDGE EFFECTIVENESS
  // ══════════════════════════════════════════════════════
  const hedgeOrders = closed.filter(o => o.type === "HEDGE")
  const byReason = {}
  for (const h of hedgeOrders) {
    const r = h.closeReason || "UNKNOWN"
    if (!byReason[r]) byReason[r] = { count: 0, pnl: 0 }
    byReason[r].count++
    byReason[r].pnl += h.pnlUsdt || 0
  }
  report.hedgeByReason = byReason
  const hedgeRecovery = mainPnl < 0 ? +(hedgePnl / Math.abs(mainPnl) * 100).toFixed(1) : null
  report.hedgeRecoveryPct = hedgeRecovery

  // ══════════════════════════════════════════════════════
  // 6. EXPOSURE & RISK
  // ══════════════════════════════════════════════════════
  const totalVol = openOrders.reduce((s, o) => s + (o.notional || 0), 0)
  const mainVol = openOrders.filter(o => o.type !== "HEDGE").reduce((s, o) => s + (o.notional || 0), 0)
  const hedgeVol = openOrders.filter(o => o.type === "HEDGE").reduce((s, o) => s + (o.notional || 0), 0)
  report.exposure = {
    openOrders: openOrders.length,
    totalVol, mainVol, hedgeVol,
    leverage: +(totalVol / 1000).toFixed(1)
  }

  // ══════════════════════════════════════════════════════
  // 7. RECENT PERFORMANCE TREND
  // ══════════════════════════════════════════════════════
  const recentMain = closed.filter(o => o.type === "MAIN").sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0, 10)
  const recentLosses = recentMain.filter(o => (o.pnlUsdt || 0) < 0).length
  const recentPnl = recentMain.reduce((s, o) => s + (o.pnlUsdt || 0), 0)
  report.recentLossStreak = recentLosses
  report.recent10Pnl = +recentPnl.toFixed(2)

  // R:R ratio
  const avgWin = mainW > 0 ? closed.filter(o => o.type !== "HEDGE" && (o.pnlUsdt || 0) > 0).reduce((s, o) => s + (o.pnlUsdt || 0), 0) / mainW : 0
  const avgLoss = mainL > 0 ? Math.abs(closed.filter(o => o.type !== "HEDGE" && (o.pnlUsdt || 0) <= 0).reduce((s, o) => s + (o.pnlUsdt || 0), 0) / mainL) : 0
  report.riskReward = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : null
  report.avgWin = +avgWin.toFixed(2)
  report.avgLoss = +avgLoss.toFixed(2)

  // ══════════════════════════════════════════════════════
  // 8. DIRECTION BALANCE
  // ══════════════════════════════════════════════════════
  const longActive = active.filter(s => s.direction === "LONG").length
  const shortActive = active.filter(s => s.direction === "SHORT").length
  report.directionBalance = { long: longActive, short: shortActive }
  if (longActive > 0 && shortActive === 0 && active.length >= 5) {
    activeIssues.push(`All ${longActive} signals LONG — no diversification`)
  }

  // Missing orders for completed signals
  let missingOrders = 0
  for (const s of completedSigs) {
    if (await db.collection("orders").countDocuments({ signalId: s._id }) === 0) missingOrders++
  }
  report.completedMissingOrders = missingOrders

  return report
}

export function hasTradingIssues(report) {
  return (
    report.dataIssues.length > 0 ||
    report.activeIssues.length > 0 ||
    report.orphanedOrders > 0 ||
    report.completedMissingOrders > 0 ||
    report.recentLossStreak >= 4 ||
    report.exposure.leverage > 30 ||
    report.strategyRecommendations.length > 0
  )
}
