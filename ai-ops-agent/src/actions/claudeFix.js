import { execSync } from "child_process"
import { writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { logger } from "../utils/logger.js"

const NVM = 'export NVM_DIR="/home/ubuntu/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const APP_ROOT = () => process.env.APP_ROOT || "/home/ubuntu/projects/binance-tele-bot"

export async function autoFixWithClaude(diagnosis, tradingReport) {
  const prompt = buildPrompt(diagnosis, tradingReport)
  logger.info(`[ClaudeFix] Triggering Claude Code...`)

  const tmpFile = join(tmpdir(), `claudefix-prompt-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, "utf8")
    const env = { ...process.env, HOME: "/home/ubuntu" }
    delete env.ANTHROPIC_API_KEY
    const output = execSync(
      `${NVM}cat ${tmpFile} | claude --print --allowedTools Edit,Read,Grep,Bash`,
      { cwd: APP_ROOT(), encoding: "utf8", timeout: 5 * 60 * 1000, env }
    )

    const hasChanges = output.includes("Edit") || output.includes("fixed") || output.includes("updated")
    logger.info(`[ClaudeFix] Done | Changes: ${hasChanges}`)
    return { ok: true, output: output.slice(0, 500), hasChanges }
  } catch (err) {
    const stderr = err.stderr ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString()) : ''
    logger.error(`[ClaudeFix] Failed: ${stderr.slice(0, 500) || err.message?.slice(0, 500)}`)
    return { ok: false, reason: err.message.slice(0, 500) }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

export async function buildAndDeploy() {
  logger.info("[ClaudeFix] Build + deploy...")
  try {
    execSync(`${NVM}cd ${APP_ROOT()} && npm run build`, { encoding: "utf8", timeout: 120000 })
    execSync(`${NVM}pm2 restart trade-tele-bot`, { encoding: "utf8", timeout: 30000 })
    logger.info("[ClaudeFix] Deploy OK")
    return { ok: true }
  } catch (err) {
    logger.error(`[ClaudeFix] Deploy failed: ${err.message.slice(0, 200)}`)
    return { ok: false, reason: err.message.slice(0, 200) }
  }
}

function buildPrompt(diagnosis, report) {
  return [
    "You are fixing a NestJS trading bot. Fix ONLY the specific issue below.",
    "Do NOT refactor. Do NOT add features. Minimal fix only.",
    "Run `npm run build` after fixing to verify.",
    "",
    `== ISSUE ==`,
    `Severity: ${diagnosis.severity}`,
    `Category: ${diagnosis.category}`,
    `Summary: ${diagnosis.summary}`,
    `Root cause: ${diagnosis.root_cause || "unknown"}`,
    diagnosis.trading_advice ? `Advice: ${diagnosis.trading_advice}` : "",
    "",
    `== STATUS ==`,
    `Wallet: $${report?.wallet || "?"} | WR: ${report?.winRate || "?"}%`,
    `Signals: ${report?.activeSignals || "?"} | Exposure: x${report?.exposure?.leverage || "?"}`,
    report?.activeIssues?.length ? `Issues:\n${report.activeIssues.map(i => `- ${i}`).join("\n")}` : ""
  ].filter(Boolean).join("\n")
}
