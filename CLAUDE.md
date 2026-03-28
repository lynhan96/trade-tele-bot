# CLAUDE.md — Binance Trading Bot

## Commands

```bash
npm run start:dev       # Watch mode
npm run build           # Compile TypeScript
npm run start:prod      # Run compiled output
npm run test:all        # Run all simulators (no Jest)
```

## Architecture

NestJS monolith: Telegram bot + AI signal scanner + real Binance Futures trading + hedge system + AI ops agent.

See [.claude/ARCHITECTURE.md](.claude/ARCHITECTURE.md) for full system diagram, data flows, and protection layers.
See [src/ai-signal/CLAUDE.md](src/ai-signal/CLAUDE.md) for core trading module details.

### Key Services

| Service | Role |
|---------|------|
| `AiSignalService` | Cron scanner: CoinFilter → Strategy → RiskScore → Signal |
| `PositionMonitorService` | Price tick: TP/SL/Trail/Grid DCA/Hedge (SIM) |
| `UserRealTradingService` | Real Binance orders: mirrors sim logic exactly |
| `HedgeManagerService` | Hedge entry/exit decisions (pure logic) |
| `UserDataStreamService` | Binance WebSocket: ORDER_TRADE_UPDATE events |
| `TradingConfigService` | Config with defaults + Redis override + hard floors |

### SIM + Real Principle
SIM and Real **MUST run identical logic**. Real only differs in order execution (Binance API vs DB-only). Never add gates/filters to real that don't exist in sim.

### Grid DCA (fixed)
4 levels: L0=entry(40%), L1=2%(15%), L2=4%(15%), L3=6%(30%). DCA continues during hedge.

### Hedge System
- Entry: PnL < -hedgeTrigger% (2-8%, auto-tuned by agent)
- Exit: TP OR trail (activate +2%, keep 70%) OR recovery close
- Progressive SL: cycle 1-2=40%, cycle 3=15%, cycle 4+=8% (only when recovery <50%)
- Trail SL: placed on Binance (not just backend check)
- `onTradeClose` matches by direction (hedge close can't close main)

### AI Ops Agent (separate process at `ai-ops-agent/`)
- 12 skills/15min (free) + Claude Sonnet analysis/4h
- Auto-configs: hedgeTrigger, confidence, maxSignals, riskScore
- FIELD_LIMITS validation: hedgeTrigger 2-8%, confidence 55-75%
- Cannot close/open positions

## Deployment

```bash
# Bot
npm run build && make deploy_develop

# Agent (after bot deploy)
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && cp -r ~/projects/binance-tele-bot/ai-ops-agent/src/* ~/ai-ops-agent/src/ && pm2 restart ai-ops-agent"
```

- Server: `ubuntu@171.244.48.10` | PM2: `trade-tele-bot`
- Git: `-c commit.gpgsign=false` required

## Environment

Copy `.env.example` to `.env`. Required: `TELEGRAM_BOT_TOKEN`, `REDIS_*`, `MONGODB_URI`, `AI_MONITOR_BINANCE_API_KEY/SECRET`.

## Post-Change Checklist

After ANY code change, update memory at:
`/Users/elvislee/.claude/projects/-Users-elvislee-Workspace-DTS-elvis-binance-tele-bot/memory/MEMORY.md`

## Telegram Commands

All user commands prefixed `/ai`, handled in `AiCommandService`.
