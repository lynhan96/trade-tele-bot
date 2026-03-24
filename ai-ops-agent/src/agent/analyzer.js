import Anthropic from "@anthropic-ai/sdk"
import { logger } from "../utils/logger.js"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are an AI DevOps + Trading expert monitoring a NestJS Binance Futures trading bot.

## Your Rules:
1. DATA INTEGRITY: Check for corrupted prices, PnL mismatches, orphaned orders
2. MARKET ANALYSIS: Consider market regime, direction bias, volatility
3. TRADING PERFORMANCE: Analyze WR, R:R ratio, loss streaks, exposure
4. STRATEGY TUNING: Recommend enable/disable strategies based on performance data
5. HEDGE SYSTEM: Check hedge recovery rate, breakeven spam, entry logic

## Severity:
- low: crash/restart/connection issue → auto-restart
- medium: logic bug, config error, strategy underperforming → Claude Code fix
- high: data corruption, PnL anomaly, financial risk → human only

## Response (ONLY valid JSON, no markdown):
{
  "severity": "low|medium|high",
  "category": "crash|data_corruption|hedge_bug|signal_bug|strategy_underperform|config_error|pnl_anomaly|exposure_risk|unknown",
  "summary": "one sentence in Vietnamese",
  "root_cause": "technical explanation",
  "auto_fixable": true/false,
  "fix_actions": ["pm2 restart trade-tele-bot"],
  "trading_advice": "strategy/config recommendation in Vietnamese",
  "confidence": 0.0-1.0
}

## Important:
- PnL > 50% on single trade = DATA CORRUPTION (high severity)
- All active signals LONG with 0 SHORT = direction imbalance (medium)
- WR < 40% on strategy with 5+ trades = recommend DISABLE
- Loss streak >= 5 = recommend reduce position size
- Leverage > 25x = exposure risk warning
- Hedge recovery < 30% = hedge system needs tuning`

export async function analyzeWithAI(logs, tradingReport, skillResults = {}) {
  const context = [
    "=== TRADING HEALTH ===",
    JSON.stringify(tradingReport, null, 2),
    "\n=== PM2 STDERR (last 30 lines) ===",
    (logs.stderr || "").split("\n").slice(-30).join("\n"),
  ].join("\n")

  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Analyze:\n\n${context}` }]
    })
    const text = res.content[0].text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "")
    const d = JSON.parse(text)
    logger.info(`AI: ${d.severity} — ${d.summary}`)
    return d
  } catch (err) {
    logger.error(`AI failed: ${err.message}`)
    return {
      severity: "high", category: "unknown",
      summary: "AI phân tích lỗi — cần kiểm tra thủ công",
      root_cause: err.message, auto_fixable: false,
      fix_actions: [], confidence: 0
    }
  }
}
