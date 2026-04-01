# CLAUDE.md — Binance Trading Bot

## Commands

```bash
npm run start:dev       # Watch mode
npm run build           # Compile TypeScript
npm run start:prod      # Run compiled output
npm run test:all        # Run all simulators (no Jest)
```

## Architecture

NestJS monolith: Telegram bot + AI signal scanner + real Binance Futures trading + hedge system.

See [.claude/ARCHITECTURE.md](.claude/ARCHITECTURE.md) for full system diagram, data flows, and protection layers.
See [src/ai-signal/CLAUDE.md](src/ai-signal/CLAUDE.md) for core trading module details.
See [TRADING_LOGIC.md](TRADING_LOGIC.md) for complete trading logic reference.

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
- Entry: PnL < -hedgeTriggerPct% (default 3%, hard floor 2%)
- Exit: TP OR trail (activate +2%, keep 70%) OR recovery close
- SL disabled during hedge — cycles until NET_POSITIVE > 2%
- `onTradeClose` matches by direction (hedge close can't close main)

## Deployment

```bash
npm run build && make deploy_develop
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
