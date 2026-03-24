#!/usr/bin/env bash
# =============================================================================
# AI Ops Agent — Customized for Trading Bot (NestJS + PM2)
# Run this ONCE on VPS: bash bootstrap.sh
# =============================================================================
set -e

AGENT_DIR="$HOME/ai-ops-agent"
echo ""
echo "🤖 AI Ops Agent — Trading Bot Monitor"
echo "Installing to: $AGENT_DIR"
echo "============================================="

mkdir -p "$AGENT_DIR"/{src/{agent,monitors,actions,notifications,utils},scripts,logs}
cd "$AGENT_DIR"

# —— package.json ——
cat > package.json << 'HEREDOC'
{
  "name": "ai-ops-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/agent/index.js",
    "dev": "node --watch src/agent/index.js",
    "setup": "node scripts/setup.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "node-cron": "^3.0.3",
    "axios": "^1.7.0",
    "dotenv": "^16.4.5",
    "mongodb": "^6.12.0",
    "winston": "^3.14.0"
  }
}
HEREDOC

# —— .env (auto-populated from trading bot) ——
TRADING_ENV="$HOME/projects/binance-tele-bot/.env"
TG_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$TRADING_ENV" 2>/dev/null | cut -d= -f2-)
TG_CHAT=$(grep '^AI_ADMIN_TELEGRAM_ID=' "$TRADING_ENV" 2>/dev/null | cut -d= -f2-)
ANTHROPIC=$(grep '^ANTHROPIC_API_KEY=' "$TRADING_ENV" 2>/dev/null | cut -d= -f2-)
MONGO=$(grep '^MONGODB_URI=' "$TRADING_ENV" 2>/dev/null | cut -d= -f2-)

cat > .env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC}
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT}
MONGODB_URI=${MONGO}
APP_ROOT=$HOME/projects/binance-tele-bot
PM2_PROCESS_NAME=trade-tele-bot
PM2_LOGS_DIR=$HOME/.pm2/logs
HEALTH_URL=http://localhost:3001/admin/health
AGENT_POLL_INTERVAL=120
LOG_LINES_TO_SCAN=300
NOTIFY_ON_AUTO_FIX=true
NOTIFY_ON_MEDIUM=true
NOTIFY_ON_HIGH=true
EOF

# —— .gitignore ——
cat > .gitignore << 'HEREDOC'
node_modules/
.env
logs/*.log
HEREDOC

# —— ecosystem.config.cjs ——
cat > ecosystem.config.cjs << 'HEREDOC'
module.exports = {
  apps: [{
    name: 'ai-ops-agent',
    script: 'src/agent/index.js',
    interpreter: '/home/ubuntu/.nvm/versions/node/v18.20.2/bin/node',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
    out_file: './logs/agent-out.log',
    error_file: './logs/agent-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    max_memory_restart: '256M',
    cron_restart: '0 */6 * * *'
  }]
}
HEREDOC

# —— src/utils/logger.js ——
cat > src/utils/logger.js << 'HEREDOC'
import winston from 'winston'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/agent.log'),
      maxsize: 5 * 1024 * 1024, maxFiles: 3, tailable: true
    })
  ]
})
HEREDOC

# —— src/utils/db.js ——
cat > src/utils/db.js << 'HEREDOC'
import { MongoClient } from 'mongodb'
import { logger } from './logger.js'

let client = null
let db = null

export async function getDb() {
  if (db) return db
  client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  db = client.db()
  logger.info('MongoDB connected')
  return db
}

export async function closeDb() {
  if (client) await client.close()
}
HEREDOC

# —— src/monitors/logMonitor.js ——
cat > src/monitors/logMonitor.js << 'HEREDOC'
import fs from 'fs'
import path from 'path'
import { logger } from '../utils/logger.js'

const PM2_LOGS_DIR = process.env.PM2_LOGS_DIR || '/home/ubuntu/.pm2/logs'
const PROC = process.env.PM2_PROCESS_NAME || 'trade-tele-bot'
const lastPos = {}

function readNew(filePath) {
  try {
    if (!fs.existsSync(filePath)) return ''
    const stat = fs.statSync(filePath)
    const from = lastPos[filePath] ?? Math.max(0, stat.size - 30000)
    if (stat.size <= from) { lastPos[filePath] = stat.size; return '' }
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(stat.size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
    lastPos[filePath] = stat.size
    return buf.toString('utf8')
  } catch { return '' }
}

export function collectLogs() {
  return {
    stderr: readNew(path.join(PM2_LOGS_DIR, `${PROC}-error.log`)),
    stdout: readNew(path.join(PM2_LOGS_DIR, `${PROC}-out.log`)),
    processName: PROC
  }
}

export function hasAnomalies(logs) {
  const patterns = [
    /uncaughtexception/i, /unhandledrejection/i,
    /ECONNREFUSED/i, /EADDRINUSE/i, /out of memory/i,
    /crashed/i, /killed/i, /fatal/i, /SIGKILL/i,
    /Cannot find module/i, /TypeError.*undefined/i,
    /MongoServerError/i, /ETIMEOUT/i
  ]
  const text = (logs.stderr || '') + (logs.stdout || '')
  return patterns.some(r => r.test(text))
}
HEREDOC

# —— src/monitors/tradingMonitor.js ——
cat > src/monitors/tradingMonitor.js << 'HEREDOC'
import { getDb } from '../utils/db.js'
import { logger } from '../utils/logger.js'

export async function checkTradingHealth() {
  const db = await getDb()
  const report = {}

  // 1. Active signals health
  const active = await db.collection('ai_signals').find({ status: 'ACTIVE' }).toArray()
  const issues = []

  for (const s of active) {
    const orders = await db.collection('orders').countDocuments({ signalId: s._id })
    const grids = (s.gridLevels || []).length
    if (grids === 0) issues.push(`${s.symbol}: NO GRIDS (tick handler broken)`)
    if (orders === 0) issues.push(`${s.symbol}: NO ORDERS`)
    if (s.stopLossPrice > 0 && !s.hedgeActive) issues.push(`${s.symbol}: SL=${s.stopLossPrice} should be 0`)
  }
  report.activeSignals = active.length
  report.activeIssues = issues

  // 2. Orphaned orders
  const openOrders = await db.collection('orders').find({ status: 'OPEN' }).toArray()
  let orphaned = 0
  for (const o of openOrders) {
    const sig = await db.collection('ai_signals').findOne({ _id: o.signalId, status: 'ACTIVE' })
    if (!sig) orphaned++
  }
  report.orphanedOrders = orphaned

  // 3. PnL summary
  const closed = await db.collection('orders').find({ status: 'CLOSED' }).toArray()
  let mainPnl = 0, hedgePnl = 0, mainW = 0, mainL = 0
  for (const o of closed) {
    const pnl = o.pnlUsdt || 0
    if (o.type === 'HEDGE') hedgePnl += pnl
    else { mainPnl += pnl; if (pnl > 0) mainW++; else mainL++ }
  }
  report.pnl = { main: +mainPnl.toFixed(2), hedge: +hedgePnl.toFixed(2), net: +(mainPnl + hedgePnl).toFixed(2) }
  report.winRate = mainW + mainL > 0 ? +((mainW / (mainW + mainL)) * 100).toFixed(1) : 0
  report.wallet = +(1000 + mainPnl + hedgePnl).toFixed(2)

  // 4. Hedge performance
  const hedgeOrders = closed.filter(o => o.type === 'HEDGE')
  const byReason = {}
  for (const h of hedgeOrders) {
    const r = h.closeReason || 'UNKNOWN'
    if (!byReason[r]) byReason[r] = { count: 0, pnl: 0 }
    byReason[r].count++
    byReason[r].pnl += h.pnlUsdt || 0
  }
  report.hedgeByReason = byReason

  // 5. Signals without orders (completed)
  const completed = await db.collection('ai_signals').find({ status: 'COMPLETED' }).toArray()
  let missingOrders = 0
  for (const s of completed) {
    if (await db.collection('orders').countDocuments({ signalId: s._id }) === 0) missingOrders++
  }
  report.completedMissingOrders = missingOrders

  // 6. Exposure
  const totalVol = openOrders.reduce((s, o) => s + (o.notional || 0), 0)
  report.exposure = { openOrders: openOrders.length, totalVol, leverage: +(totalVol / 1000).toFixed(1) }

  // 7. Recent losses streak
  const recentMain = closed.filter(o => o.type === 'MAIN').sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0, 5)
  const recentLosses = recentMain.filter(o => (o.pnlUsdt || 0) < 0).length
  report.recentLossStreak = recentLosses

  return report
}

export function hasTradingIssues(report) {
  return (
    report.activeIssues.length > 0 ||
    report.orphanedOrders > 0 ||
    report.completedMissingOrders > 0 ||
    report.recentLossStreak >= 4 ||
    report.exposure.leverage > 30
  )
}
HEREDOC

# —— src/agent/analyzer.js ——
cat > src/agent/analyzer.js << 'HEREDOC'
import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../utils/logger.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are a DevOps + Trading AI agent monitoring a NestJS trading bot on VPS with PM2.
The bot trades Binance Futures with auto-hedge system.

Analyze logs/health/trading data and return ONLY valid JSON:
{
  "severity": "low|medium|high",
  "category": "crash|oom|websocket|mongodb|redis|hedge_bug|signal_bug|pnl_anomaly|config_error|unknown",
  "summary": "one sentence in Vietnamese",
  "root_cause": "technical explanation",
  "auto_fixable": true/false,
  "fix_actions": ["pm2 restart trade-tele-bot"],
  "trading_advice": "optional trading-specific recommendation",
  "confidence": 0.0-1.0
}

Severity guide:
- low: process crash, OOM, websocket disconnect → auto-restart
- medium: hedge logic error, signal bug, config issue → needs code review
- high: PnL anomaly, data corruption, order mismatch → human only

Trading-specific checks:
- Signals with 0 grids = tick handler broken (critical)
- Orphaned orders = signal completed but orders still OPEN
- SL > 0 when hedge enabled = SL should be disabled
- Loss streak ≥ 4 = strategy may need tuning
- Leverage > 30x = over-exposed`

export async function analyzeWithAI(logs, tradingReport) {
  const context = [
    '=== PM2 LOGS (stderr) ===',
    (logs.stderr || '').split('\n').slice(-50).join('\n'),
    '\n=== PM2 LOGS (stdout last 30 lines) ===',
    (logs.stdout || '').split('\n').slice(-30).join('\n'),
    '\n=== TRADING HEALTH ===',
    JSON.stringify(tradingReport, null, 2)
  ].join('\n')

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Diagnose:\n\n${context}` }]
    })
    const text = res.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '')
    const d = JSON.parse(text)
    logger.info(`Diagnosis: ${d.severity} — ${d.summary}`)
    return d
  } catch (err) {
    logger.error(`AI analysis failed: ${err.message}`)
    return {
      severity: 'high', category: 'unknown',
      summary: 'AI phân tích lỗi — cần kiểm tra thủ công',
      root_cause: err.message, auto_fixable: false,
      fix_actions: [], confidence: 0
    }
  }
}
HEREDOC

# —— src/actions/executor.js ——
cat > src/actions/executor.js << 'HEREDOC'
import { execSync } from 'child_process'
import { logger } from '../utils/logger.js'

const nvm = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const PROC = () => process.env.PM2_PROCESS_NAME || 'trade-tele-bot'

export function run(cmd, cwd) {
  logger.info(`▶ ${cmd}`)
  try {
    const out = execSync(`${nvm}${cmd}`, { cwd, encoding: 'utf8', timeout: 120000 })
    return { ok: true, output: out }
  } catch (err) {
    logger.error(`✗ ${cmd}: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

export const restartBot = () => run(`pm2 restart ${PROC()}`)
export const getBotStatus = () => run(`pm2 jlist`)
export const getBotLogs = (n = 50) => run(`pm2 logs ${PROC()} --lines ${n} --nostream`)

export function getCurrentCommit() {
  try {
    return {
      hash: execSync('git rev-parse HEAD', { cwd: process.env.APP_ROOT, encoding: 'utf8' }).trim().slice(0, 8),
      msg: execSync('git log -1 --pretty=%s', { cwd: process.env.APP_ROOT, encoding: 'utf8' }).trim()
    }
  } catch { return { hash: '?', msg: '?' } }
}
HEREDOC

# —— src/notifications/telegram.js ——
cat > src/notifications/telegram.js << 'HEREDOC'
import axios from 'axios'
import { logger } from '../utils/logger.js'

const send = (method, data) =>
  axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, data)
    .catch(e => logger.error(`Telegram: ${e.message}`))

const esc = t => String(t || '').replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')

export async function notifyIncident(diagnosis, tradingReport) {
  const sev = diagnosis.severity === 'high' ? '🔴' : diagnosis.severity === 'medium' ? '🟡' : '🟢'
  const wallet = tradingReport?.wallet ? `\n💰 Wallet: $${tradingReport.wallet}` : ''
  const wr = tradingReport?.winRate ? ` | WR: ${tradingReport.winRate}%` : ''
  const exposure = tradingReport?.exposure ? `\n📊 Exposure: x${tradingReport.exposure.leverage} ($${tradingReport.exposure.totalVol})` : ''
  const issues = (tradingReport?.activeIssues || []).slice(0, 3).map(i => `  • ${i}`).join('\n')

  const text = [
    `${sev} *${diagnosis.severity.toUpperCase()}* \\| ${esc(diagnosis.category)}`,
    '',
    `📋 ${esc(diagnosis.summary)}`,
    diagnosis.root_cause ? `\n🔍 ${esc(diagnosis.root_cause)}` : '',
    diagnosis.trading_advice ? `\n💡 ${esc(diagnosis.trading_advice)}` : '',
    wallet ? `\n${esc(wallet.trim())}${esc(wr)}` : '',
    exposure ? esc(exposure.trim()) : '',
    issues ? `\n⚠️ Issues:\n${esc(issues)}` : '',
    diagnosis.auto_fixable ? '\n✅ Tự động sửa' : '\n🔧 Cần xử lý thủ công',
    `\n🤖 _AI Ops Agent_`
  ].filter(Boolean).join('\n')

  await send('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: 'MarkdownV2',
    text,
    reply_markup: diagnosis.severity === 'high' ? {
      inline_keyboard: [[
        { text: '🔄 Restart Bot', callback_data: 'restart' },
        { text: '✅ Acknowledge', callback_data: 'ack' }
      ]]
    } : undefined
  })
}

export async function notifyAutoFixed(actions) {
  await send('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: 'MarkdownV2',
    text: `✅ *Auto\\-Fixed*\n\n${actions.map(a => `• ${esc(a)}`).join('\n')}\n\n🤖 _AI Ops Agent_`
  })
}

export async function notifyTradingReport(report) {
  const pnl = report.pnl.net >= 0 ? `+$${report.pnl.net}` : `-$${Math.abs(report.pnl.net)}`
  const color = report.pnl.net >= 0 ? '🟢' : '🔴'

  await send('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: 'MarkdownV2',
    text: [
      `📊 *Báo Cáo Trading*`,
      '',
      `${color} Wallet: *$${esc(String(report.wallet))}*`,
      `💰 PnL: ${esc(pnl)} \\(Main: ${esc(String(report.pnl.main))} \\+ Hedge: ${esc(String(report.pnl.hedge))}\\)`,
      `📈 WR: ${report.winRate}% \\| Signals: ${report.activeSignals}`,
      `📊 Exposure: x${report.exposure.leverage} \\($${esc(String(report.exposure.totalVol))}\\)`,
      report.activeIssues.length > 0 ? `\n⚠️ Issues: ${report.activeIssues.length}` : '✅ All healthy',
      `\n🤖 _AI Ops Agent_`
    ].join('\n')
  })
}
HEREDOC

# —— src/agent/index.js ——
cat > src/agent/index.js << 'HEREDOC'
import 'dotenv/config'
import cron from 'node-cron'
import { collectLogs, hasAnomalies } from '../monitors/logMonitor.js'
import { checkTradingHealth, hasTradingIssues } from '../monitors/tradingMonitor.js'
import { analyzeWithAI } from './analyzer.js'
import { restartBot, getCurrentCommit } from '../actions/executor.js'
import { notifyIncident, notifyAutoFixed, notifyTradingReport } from '../notifications/telegram.js'
import { logger } from '../utils/logger.js'

const POLL = parseInt(process.env.AGENT_POLL_INTERVAL || '120')
let lastReportHour = -1

async function runCheck() {
  try {
    const logs = collectLogs()
    const tradingReport = await checkTradingHealth()
    const logAnomaly = hasAnomalies(logs)
    const tradingAnomaly = hasTradingIssues(tradingReport)

    // Hourly trading report (every 4 hours)
    const hour = new Date().getUTCHours()
    if (hour % 4 === 0 && hour !== lastReportHour) {
      lastReportHour = hour
      await notifyTradingReport(tradingReport)
      logger.info(`Trading report sent | Wallet: $${tradingReport.wallet} | WR: ${tradingReport.winRate}%`)
    }

    if (!logAnomaly && !tradingAnomaly) {
      logger.info(`✓ Healthy | Wallet: $${tradingReport.wallet} | Signals: ${tradingReport.activeSignals} | x${tradingReport.exposure.leverage}`)
      return
    }

    logger.warn('Anomaly detected — analyzing with AI...')
    const diagnosis = await analyzeWithAI(logs, tradingReport)

    if (diagnosis.severity === 'low' && diagnosis.auto_fixable) {
      logger.info(`[LOW] Auto-fixing: ${diagnosis.summary}`)
      const actions = []
      for (const cmd of (diagnosis.fix_actions || [])) {
        if (cmd.includes('restart')) {
          const r = restartBot()
          actions.push(r.ok ? 'Bot restarted ✓' : `Restart failed: ${r.error}`)
        }
      }
      if (actions.length === 0) {
        restartBot()
        actions.push('Bot restarted (default action)')
      }
      await notifyAutoFixed(actions)
    } else {
      await notifyIncident(diagnosis, tradingReport)
    }
  } catch (err) {
    logger.error(`Check failed: ${err.message}`)
  }
}

async function start() {
  logger.info('='.repeat(50))
  logger.info('🤖 AI Ops Agent — Trading Bot Monitor')
  logger.info(`Commit: ${JSON.stringify(getCurrentCommit())}`)
  logger.info(`Poll: every ${POLL}s`)
  logger.info('='.repeat(50))

  await runCheck()
  // Run every 2 minutes
  cron.schedule(`*/${Math.ceil(POLL / 60)} * * * *`, runCheck)
  logger.info('Agent running.')
}

start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1) })
HEREDOC

# —— scripts/setup.js ——
cat > scripts/setup.js << 'HEREDOC'
#!/usr/bin/env node
import 'dotenv/config'
import axios from 'axios'
import { MongoClient } from 'mongodb'

let allOk = true
const ok   = n => console.log(`✅ ${n}`)
const fail = (n, r) => { console.log(`❌ ${n}: ${r}`); allOk = false }

console.log('\n🤖 AI Ops Agent — Setup Validation\n' + '='.repeat(40))

// Env vars
console.log('\n📋 Environment:')
for (const k of ['ANTHROPIC_API_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','MONGODB_URI','APP_ROOT','PM2_PROCESS_NAME']) {
  process.env[k] ? ok(k) : fail(k, 'Missing')
}

// APIs
console.log('\n🔌 APIs:')
try {
  await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  )
  ok('Anthropic API')
} catch (e) { fail('Anthropic', e.response?.data?.error?.message || e.message) }

try {
  const r = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
  ok(`Telegram (@${r.data.result?.username})`)
} catch (e) { fail('Telegram', e.message) }

try {
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const count = await client.db().collection('ai_signals').countDocuments()
  ok(`MongoDB (${count} signals)`)
  await client.close()
} catch (e) { fail('MongoDB', e.message) }

console.log('\n' + '='.repeat(40))
if (allOk) {
  console.log('✅ All checks passed!\n   pm2 start ecosystem.config.cjs && pm2 save')
} else {
  console.log('❌ Fix issues above before starting.')
  process.exit(1)
}
HEREDOC

echo ""
echo "============================================="
echo "✅ Bootstrap complete!"
echo ""
echo "Next: npm install && npm run setup && pm2 start ecosystem.config.cjs && pm2 save"
echo "============================================="
