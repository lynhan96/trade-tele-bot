import "dotenv/config"
import cron from "node-cron"
import { collectLogs, hasAnomalies } from "../monitors/logMonitor.js"
import { checkTradingHealth } from "../monitors/tradingMonitor.js"
import { runActiveTrader } from "./activeTrader.js"
import { restartBot, getCurrentCommit } from "../actions/executor.js"
import { runAllSkills } from "../actions/skills.js"
import { notifyAutoFixed, notifyTradingReport, notifySmartAlert } from "../notifications/telegram.js"
import { logger } from "../utils/logger.js"

let lastReportHour = -1
let consecutiveCrashes = 0
let isFirstRun = true

// ═══ Lightweight check — every 15 min (no Claude, DB only) ═══
// silent=true on startup: logs to file only, no dashboard events (prevents spam on restart)
async function runLightCheck(silent = false) {
  try {
    // ── 1. Auto-fix data issues (DB queries only, no tokens) ──
    const skillResults = await runAllSkills(silent)
    const fixes = skillResults.dataFixes || []
    if (fixes.length) {
      logger.info(`[Skills] Fixed ${fixes.length} issues`)
      if (!silent) await notifyAutoFixed(["🔧 Auto-fix dữ liệu", ...fixes.slice(0, 3)])
    }

    // ── 2. Smart alerts — event-driven notifications (immediate) ──
    const alerts = skillResults.smartAlerts || []
    const critical = alerts.filter(a => a.startsWith("🚨") || a.startsWith("🔴"))
    if (critical.length && !silent) {
      await notifySmartAlert(critical)
    }

    // ── 3. Portfolio risk alerts ──
    const riskAlerts = (skillResults.portfolioRisk || []).filter(a => a.startsWith("🔴"))
    if (riskAlerts.length && !silent) {
      await notifySmartAlert(riskAlerts)
    }

    // ── 4. Crash detection (skip first run — stale logs cause false positives) ──
    const logs = collectLogs()
    if (isFirstRun) {
      isFirstRun = false
      logger.info("[CrashDetect] First run — skipped (baseline set)")
    } else if (hasAnomalies(logs)) {
      consecutiveCrashes++
      restartBot()
      if (consecutiveCrashes >= 3) {
        await notifyAutoFixed(["🔴 Bot crash " + consecutiveCrashes + "x", "🔄 Restarted"])
        consecutiveCrashes = 0
      }
      return
    }
    consecutiveCrashes = 0

    // ── 5. Trading report every 4h ──
    const hour = new Date().getUTCHours()
    if (hour % 4 === 0 && hour !== lastReportHour) {
      lastReportHour = hour
      const report = await checkTradingHealth()
      await notifyTradingReport(report)
      logger.info(`📊 Report | $${report.wallet} | WR: ${report.winRate}%`)
    }
  } catch (err) {
    logger.error(`Light check failed: ${err.message}`)
  }
}

// ═══ Claude analysis — every 4h (uses Claude Sonnet tokens) ═══
// Adaptive config tuning: Claude reviews regime, positions, skill findings
// and adjusts config parameters to optimize for current market conditions
async function runAnalysis() {
  try {
    const results = await runActiveTrader()
    const actions = results.filter(r => r.ok && !r.message.includes("Hold") && !r.message.includes("Learned"))
    if (actions.length) {
      await notifyAutoFixed([
        "🧠 AI Advisor (Sonnet 4.6)",
        ...actions.map(r => `✅ ${r.message}`)
      ])
    }
  } catch (err) {
    logger.error(`Analysis failed: ${err.message}`)
  }
}

async function start() {
  logger.info("=".repeat(50))
  logger.info("🤖 AI Trading Advisor v8")
  logger.info(`Commit: ${JSON.stringify(getCurrentCommit())}`)
  logger.info("9 skills/15min | Claude Sonnet analysis/4h | Report/4h | Smart alerts/15min")
  logger.info("Role: ADVISOR — adaptive config + learning + anomaly detection")
  logger.info("=".repeat(50))

  // Run light check on start — silent mode (log to file only, no dashboard events)
  // This prevents dashboard spam on every restart
  await runLightCheck(true)

  // 9 skills + crash detection + smart alerts: every 15 min (cheap — no Claude)
  // Wrap in arrow fn to prevent cron passing Date as silent arg
  cron.schedule("*/15 * * * *", () => runLightCheck())

  // Claude analysis: every 4h (0:00, 4:00, 8:00, 12:00, 16:00, 20:00 UTC)
  // ~6 calls/day using Sonnet 4.6 — fits within Max plan quota
  cron.schedule("0 */4 * * *", () => runAnalysis())

  logger.info("Agent running.")
}

start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1) })
