import axios from 'axios'
import { logger } from '../utils/logger.js'

const send = (method, data) =>
  axios.post(`https://api.telegram.org/bot${process.env.AGENT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN}/${method}`, data)
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
