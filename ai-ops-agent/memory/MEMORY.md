# Trading Bot Memory

- [Financial Expert Role](user_finance_expert.md) — Act as quant finance expert for trading strategy discussions
- [Hedge System V3](hedge_system_v3.md) — Complete hedge architecture (entry/exit/flip/no-SL)

## Deployment
- **Deploy command:** `make deploy_develop` (from project root)
- SSHs into `ubuntu@171.244.48.10`, pulls master, yarn install, yarn build, pm2 restart `trade-tele-bot`
- PM2 process name: `trade-tele-bot`, project dir: `~/projects/binance-tele-bot`
- Other: `make logs`, `make logs-errors`, `make logs-signals`, `make status`, `make restart`, `make ssh`
- **Admin frontend deploy:** `cd /Users/elvislee/Workspace/DTS/elvis/admin && git add -A && git -c commit.gpgsign=false commit -m "..." && make deploy_develop`

## Git
- GPG signing fails locally — user approved `-c commit.gpgsign=false`
- Backend: `https://github.com/lynhan96/trade-tele-bot.git` | Admin: `https://github.com/lynhan96/binance-tele-bot-admin.git`

## Critical Bugs Fixed (2026-03-24)
- **SL=entry instant close:** `stopLossPrice = entry*(1-0%) = entry` when hedgeEnabled. Fix: `stopLossPrice = 0` when `stopLossPercent = 0`
- **hedgeEnabled=undefined:** TradingConfig merge `{...defaults, ...{hedgeEnabled: undefined}}` overrides default true. Fix: filter undefined before merge
- **Grid init crash SL=0:** `gridStep = 0/3 = 0` when SL=0, breaks all tick handlers. Fix: min gridStep 4%
- **Schema missing fields:** `hedgeTrailActivated`, `hedgeSlAtEntry` not in Mongoose schema → silently dropped on save
- **Analytics cache TTL:** 5min but scanner runs 15min → cache dead 10/15min. Fix: TTL=20min

## Auto-Hedge System V3 (2026-03-24)
- **SL:** Always 0 from signal creation. Hedge manages ALL risk. Catastrophic stop -25%
- **Entry:** Cycle 1 = -3% (no momentum check, instant). Cycle 2+ = PnL < -3% + RSI confirm
- **Exit:** TP hit → trail (ride trend) | Main TP → FLIP | NET_POSITIVE | Breakeven SL at +0.5%
- **Vol:** 75% fixed all cycles | Max 100 cycles | No hedge SL
- **Trail:** Hedge TP reached → trail activated → close on 1% pullback from peak
- **Breakeven:** After +1.5%, SL moves to +0.5%. Cooldown 15min after breakeven close
- **FLIP:** Main TP while hedge active → close main, promote hedge as new main
- **No `price < lastExit` check** — removed, RSI + PnL threshold sufficient

## TradingConfig
- **File:** `src/ai-signal/trading-config.ts` — single source of truth
- **IMPORTANT:** `undefined` values in Redis override defaults! Always filter undefined before merge
- **Confidence cap:** MAX 68 for ALL regimes (prevents AutoTuner over-restricting)
- **Strategy gates:** MAX 68 (was 82, blocked all signals)
- **Extreme move filter:** 50% (was 30%, blocked coins in bull market)
- **SHORT in STRONG_BULL:** Allowed for STOCH_EMA_KDJ, SMC_FVG, OP_ONCHAIN
- **On-chain filter:** Info-only for non-OP_ONCHAIN strategies (doesn't block)

## Order System
- **1 signal = 1 MAIN order + N HEDGE orders** (DCA merged into MAIN)
- **Fields:** stopLossPrice, takeProfitPrice, entryFeeUsdt, exitFeeUsdt, fundingFeeUsdt
- **Source of truth for PnL** — dashboard, sidebar, charts all use orders collection
- **WebSocket:** registerPriceListener auto-subscribes coin + bootstrap HTTP tick

## OP_ONCHAIN Strategy
- Uses daily open price (from Redis candle cache, not MongoDB) + on-chain data
- Score: OP direction (20) + Taker flow (15) + L/S ratio (10) + FR (10)
- Min score 30 to fire. Lower thresholds than other strategies

## On-Chain Scanner
- Cron 15min, saves to `onchain_snapshots` collection
- Telegram alerts DISABLED — AI Ops Agent handles notifications
- Data feeds into OP_ONCHAIN strategy + agent decisions

## AI Ops Agent (2026-03-24)
- **Location:** `ai-ops-agent/` in project root, also deployed at `~/ai-ops-agent/` on server
- **PM2:** `ai-ops-agent` process
- **5 Skills:** DataValidator, HedgeManager, StrategyTuner, ExposureManager, ProfitProtector
- **Decision Engine:** Claude Code CLI (Pro plan) analyzes data hourly → decides actions
- **Admin API:** Can close signals, update config directly via `http://127.0.0.1:3001/admin/`
- **Memory:** `~/ai-ops-agent/memory/` — decisions.json + learnings.json
- **Telegram:** Only notifies on actual actions (no spam). Report every 4h
- **Poll:** 15min | Decisions: hourly | Dedup: 1h

## Admin Frontend
- **Dashboard sidebar:** Equity, Wallet Balance, Unrealized PnL, Total PnL, Win/Loss, Win Rate
- **History:** Grouped by signal (MAIN + HEDGE children), detail modal on click
- **Starting balance:** 1000 USDT (sim account)

## Fee Simulation
- **Taker:** 0.05% per side | **Maker:** 0.02% per side
- **Funding:** every 8h, config `simFundingEnabled`

## DCA Grid
- **3 levels:** L0=40%, L1=25%, L2=35%
- **Grid step:** originalSL% / 3 (min 4% when SL=0)
- **Skip grid fills** when hedge active

## Cron Jobs (UTC)
- Signal scan: 30s | Monitor positions: 30s | Coin filter: 5min
- Regime: 4h | Market Guard: 15min | On-chain scanner: 15min
