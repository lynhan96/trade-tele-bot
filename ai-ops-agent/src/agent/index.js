import "dotenv/config"
import cron from "node-cron"
import { collectLogs, hasAnomalies } from "../monitors/logMonitor.js"
import { checkTradingHealth, hasTradingIssues } from "../monitors/tradingMonitor.js"
import { makeDecisions } from "./decisionEngine.js"
import { restartBot, getCurrentCommit } from "../actions/executor.js"
import { autoFixWithClaude, buildAndDeploy } from "../actions/claudeFix.js"
import { runAllSkills } from "../actions/skills.js"
import { notifyAutoFixed, notifyTradingReport } from "../notifications/telegram.js"
import { logger } from "../utils/logger.js"

let lastReportHour = -1
let lastDecisionHour = -1
let consecutiveCrashes = 0

async function runCheck() {
  try {
    // ── 1. Auto-fix skills (data validation — silent) ──
    const skillResults = await runAllSkills()
    const fixes = skillResults.dataFixes || []
    if (fixes.length) {
      logger.info(`[Skills] Fixed ${fixes.length} issues`)
      // Only notify if actual data was fixed
      await notifyAutoFixed(["🔧 Auto-fix dữ liệu", ...fixes.slice(0, 5)])
    }

    // ── 2. Health check ──
    const logs = collectLogs()
    const report = await checkTradingHealth()

    // ── 3. Trading report every 4h ──
    const hour = new Date().getUTCHours()
    if (hour % 4 === 0 && hour !== lastReportHour) {
      lastReportHour = hour
      await notifyTradingReport(report)
    }

    // ── 4. Claude trading decisions every 1h ──
    if (hour !== lastDecisionHour) {
      lastDecisionHour = hour
      logger.info("[Decision] Hourly cycle...")
      const results = await makeDecisions(report, skillResults)
      // Only notify when Claude TOOK ACTION (not just analyzed)
      const actionResults = results.filter(r => r.ok && !r.message.includes("Skip") && !r.message.includes("Learned"))
      if (actionResults.length) {
        await notifyAutoFixed([
          "🧠 AI Trading Decision",
          ...actionResults.map(r => `✅ ${r.message}`)
        ])
      }
    }

    // ── 5. Crash detection — auto restart (silent unless repeated) ──
    if (hasAnomalies(logs)) {
      consecutiveCrashes++
      logger.warn(`Anomaly #${consecutiveCrashes}`)
      restartBot()
      // Only notify after 3+ consecutive crashes
      if (consecutiveCrashes >= 3) {
        await notifyAutoFixed(["🔴 Bot crash lặp lại " + consecutiveCrashes + " lần", "🔄 Auto-restarted"])
        consecutiveCrashes = 0
      }
    } else {
      consecutiveCrashes = 0
      logger.info(`✓ OK | $${report.wallet} | ${report.activeSignals} sig | x${report.exposure.leverage}`)
    }
  } catch (err) {
    logger.error(`Check failed: ${err.message}`)
  }
}

async function start() {
  logger.info("=".repeat(50))
  logger.info("🤖 AI Ops Agent v5 — Smart + Silent")
  logger.info(`Commit: ${JSON.stringify(getCurrentCommit())}`)
  logger.info("Decisions: hourly | Report: 4h | Poll: 15min")
  logger.info("Telegram: only on ACTION taken (no spam)")
  logger.info("=".repeat(50))
  await runCheck()
  cron.schedule("*/15 * * * *", runCheck)
  logger.info("Agent running.")
}

start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1) })
