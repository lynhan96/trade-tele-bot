import "dotenv/config"
import cron from "node-cron"
import { collectLogs, hasAnomalies } from "../monitors/logMonitor.js"
import { checkTradingHealth } from "../monitors/tradingMonitor.js"
import { runActiveTrader } from "./activeTrader.js"
import { restartBot, getCurrentCommit } from "../actions/executor.js"
import { runAllSkills } from "../actions/skills.js"
import { notifyAutoFixed, notifyTradingReport } from "../notifications/telegram.js"
import { logger } from "../utils/logger.js"

let lastReportHour = -1
let consecutiveCrashes = 0

// ═══ Main check cycle — every 5 min ═══
async function runCheck() {
  try {
    // ── 1. Auto-fix data issues (silent unless fixed something) ──
    const skillResults = await runAllSkills()
    const fixes = skillResults.dataFixes || []
    if (fixes.length) {
      logger.info(`[Skills] Fixed ${fixes.length} issues`)
      await notifyAutoFixed(["🔧 Auto-fix dữ liệu", ...fixes.slice(0, 3)])
    }

    // ── 2. Crash detection ──
    const logs = collectLogs()
    if (hasAnomalies(logs)) {
      consecutiveCrashes++
      restartBot()
      if (consecutiveCrashes >= 3) {
        await notifyAutoFixed(["🔴 Bot crash " + consecutiveCrashes + "x", "🔄 Restarted"])
        consecutiveCrashes = 0
      }
      return
    }
    consecutiveCrashes = 0

    // ── 3. Active Trader — Claude analyzes + decides ──
    const results = await runActiveTrader()
    const actions = results.filter(r => r.ok && !r.message.includes("Hold") && !r.message.includes("Learned"))
    if (actions.length) {
      await notifyAutoFixed([
        "🧠 AI Trader Decision",
        ...actions.map(r => `✅ ${r.message}`)
      ])
    }

    // ── 4. Trading report every 4h ──
    const hour = new Date().getUTCHours()
    if (hour % 4 === 0 && hour !== lastReportHour) {
      lastReportHour = hour
      const report = await checkTradingHealth()
      await notifyTradingReport(report)
      logger.info(`📊 Report | $${report.wallet} | WR: ${report.winRate}%`)
    }
  } catch (err) {
    logger.error(`Check failed: ${err.message}`)
  }
}

async function start() {
  logger.info("=".repeat(50))
  logger.info("🤖 AI Active Trader v6")
  logger.info(`Commit: ${JSON.stringify(getCurrentCommit())}`)
  logger.info("Trading: 5min | Skills: 5min | Report: 4h")
  logger.info("Claude Pro: decisions + close + hedge + flip")
  logger.info("=".repeat(50))

  await runCheck()
  // Every 5 minutes
  cron.schedule("*/5 * * * *", runCheck)
  logger.info("Agent running.")
}

start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1) })
