import { getDb } from "../utils/db.js"
import { getPrices } from "../utils/redis.js"
import { collectMarketContext } from "../utils/marketContext.js"
import { saveLearning } from "../utils/memory.js"
import { logger } from "../utils/logger.js"
import * as agentLog from "../utils/agentLogger.js"

// Silent mode: log to file only, no dashboard events (used on startup)
let _silent = false

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

  const newActions = filterNewFindings("hedge", actions)
  if (newActions.length) {
    logger.info(`[HedgeManager] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("position_manager", a)
  }
  return actions
}

// ══════════════════════════════════════════════════════════
// SKILL 3: STRATEGY REPORTER — info only, no disable recommendations
// Strategies are enabled/disabled based on market regime, not WR alone
// ══════════════════════════════════════════════════════════
export async function runStrategyTuner() {
  const db = await getDb()
  const actions = []

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

  for (const [name, s] of Object.entries(stratPerf)) {
    if (s.count < 3) continue
    const wr = (s.wins / s.count * 100)
    // Info only — report stats without recommending disable
    actions.push(`${name}: WR ${wr.toFixed(0)}% (${s.wins}/${s.count}) PnL $${s.pnl.toFixed(2)}`)
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

    // 3. Taker buy ratio — buying pressure vs selling pressure
    if (s.direction === "LONG" && coin.taker && coin.taker < 0.42) {
      actions.push(`⚠️ ${s.symbol} LONG but taker buy ratio ${coin.taker?.toFixed(2)} (sellers dominating)`)
    }
    if (s.direction === "SHORT" && coin.taker && coin.taker > 0.58) {
      actions.push(`⚠️ ${s.symbol} SHORT but taker buy ratio ${coin.taker?.toFixed(2)} (buyers dominating)`)
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
// SKILL 7: PORTFOLIO RISK MONITOR — correlation & concentration
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
  if ((sameDirAlts.LONG || 0) >= 4) {
    actions.push(`🔴 ${sameDirAlts.LONG} altcoins ALL LONG — highly correlated, BTC drop = cascade loss`)
  }
  if ((sameDirAlts.SHORT || 0) >= 4) {
    actions.push(`🔴 ${sameDirAlts.SHORT} altcoins ALL SHORT — highly correlated, BTC pump = cascade loss`)
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
  if (totalUnrealized < -100) {
    actions.push(`🔴 Portfolio unrealized: $${totalUnrealized.toFixed(2)} — consider reducing positions`)
  }
  if (totalUnrealized < -200) {
    actions.push(`🔴🔴 CRITICAL drawdown: $${totalUnrealized.toFixed(2)} — immediate risk management needed`)
  }

  // 3. Single coin over-exposure (multiple grid entries on one coin)
  const openOrders = await db.collection("orders").find({ status: "OPEN" }).toArray()
  const volByCoin = {}
  for (const o of openOrders) {
    volByCoin[o.symbol] = (volByCoin[o.symbol] || 0) + (o.notional || 0)
  }
  for (const [sym, vol] of Object.entries(volByCoin)) {
    const pct = (vol / 1000) * 100 // % of $1000 wallet
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

  // 6. Large position PnL swing (>3% move in either direction on active positions)
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

  const newActions = filterNewFindings("alerts", actions)
  if (newActions.length) {
    logger.info(`[SmartAlerts] ${newActions.join(" | ")}`)
    if (!_silent) for (const a of newActions) await agentLog.thought("smart_alert", a)
  }
  return actions
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
  }
  _silent = prevSilent

  const totalActions = Object.values(results).flat().length
  logger.info(`[Skills] Ran 9 skills — ${totalActions} total findings`)
  return results
}
