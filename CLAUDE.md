# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run start:dev       # Watch mode (logs to /tmp/bot.log)
npm run build           # Compile TypeScript
npm run start:prod      # Run compiled output
npm run format          # Prettier format

# Simulation / testing (no Jest — uses ts-node simulators)
npm run test:safety     # run-simulator.ts
npm run test:complete   # run-complete-simulator.ts
npm run test:skills     # run-skills-simulator.ts
npm run test:all        # run all simulators
```

There are no unit tests. All testing is done via ts-node simulator scripts in the project root.

## Architecture

NestJS monolith with polling Telegram bot. Key infrastructure: Redis (cache/session), MongoDB (persistence), Binance WebSocket streams (real-time market data).

### Module Map

```
AppModule
├── LoggerModule          — Winston logger (daily rotate)
├── RedisModule           — Redis client (prefix: binance-telebot:)
├── BinanceModule         — Binance REST API client (node binance-api-node)
├── TelegramModule        — TelegramBotService (node-telegram-bot-api, polling)
├── AiSignalModule        — Core AI trading signal system (see below)
│   ├── MarketDataModule  — WebSocket candle feeds + FuturesAnalyticsService
│   ├── CoinFilterModule  — Filters tradeable coins by volume/volatility
│   ├── StrategyModule    — Technical indicators + rule engine + AI optimizer
│   └── UserModule        — User settings (MongoDB UserSettings schema)
```

### AiSignalModule Services

| Service | Role |
|---|---|
| `AiSignalService` | Cron-driven scanner; calls CoinFilter → Strategy → queues signals |
| `SignalQueueService` | Manages queued/active signals in MongoDB |
| `PositionMonitorService` | Monitors open positions; fires TP/SL on price events |
| `UserRealTradingService` | Places/closes real Binance Futures orders per user |
| `UserSignalSubscriptionService` | Manages user subscriptions (MongoDB) |
| `UserDataStreamService` | Binance user data WebSocket (order fill events) |
| `AiCommandService` | Handles all `/ai` Telegram commands |
| `AiSignalStatsService` | Win rate / PnL stats |

### Strategy Pipeline

`IndicatorService` (technicalindicators) → `RuleEngineService` (entry rules) → `AiOptimizerService` (Claude Haiku / GPT-4o-mini tunes SL/TP params, cached 4h in Redis)

### Market Data Flow

`MarketDataService` maintains persistent WebSocket connections to `wss://fstream.binance.com` for multiple symbols/intervals (`5m`, `15m`, `1h`, `4h`, `1d`). Candles stored in MongoDB (`CandleHistory`). Real-time price events dispatched to registered listeners. `getPrice(symbol)` auto-subscribes if not already connected.

### Dual Timeframe Strategy

`DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"]` get both INTRADAY (15m) and SWING (4h) analysis. All other coins get SWING only.

### Redis Key Patterns

- `binance-telebot:user:{telegramId}` — user API keys
- `binance-telebot:user:{telegramId}:tp` — take profit state
- `cache:ai:paused` / `cache:ai:test-mode` / `cache:ai:scanning` — AI system flags
- AI optimizer params cached with 4h TTL

### AdminModule (`src/admin/`)

REST API + WebSocket gateway for the admin frontend panel.

| File | Role |
|---|---|
| `admin.module.ts` | Module registering all schemas, controller, services, gateway |
| `admin.controller.ts` | REST endpoints under `/admin/` (auth + CRUD for all entities) |
| `admin.service.ts` | Database queries: dashboard stats, paginated lists, updates |
| `admin-auth.service.ts` | JWT login, token verification, password change, auto-seeds default admin |
| `admin.guard.ts` | JWT Bearer token guard for protected routes |
| `admin.gateway.ts` | Socket.IO gateway (`/admin` namespace), MongoDB Change Streams for real-time events |

Auth: JWT tokens (env: `ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES_IN`). Default admin seeded on first boot (`ADMIN_DEFAULT_USERNAME`/`ADMIN_DEFAULT_PASSWORD`, defaults: admin/admin123).

Schema: `AdminAccount` (`admin_accounts` collection) — username, passwordHash, role, isActive.

### MongoDB Schemas (`src/schemas/`)

`AiSignal`, `AiCoinProfile`, `AiRegimeHistory`, `UserSignalSubscription`, `DailyMarketSnapshot`, `UserTrade`, `UserSettings`, `AiMarketConfig`, `AdminAccount`

## Environment

Copy `.env.example` to `.env`. Required vars: `TELEGRAM_BOT_TOKEN`, `REDIS_*`, `MONGODB_URI`, `ANTHROPIC_API_KEY`, `AI_MONITOR_BINANCE_API_KEY/SECRET`. Optional: `OPENAI_API_KEY` (GPT-4o-mini fallback for AI tuning), `AI_ADMIN_TELEGRAM_ID` (comma-separated).

AI tuning waterfall: Claude Haiku (primary, limit: `AI_MAX_HAIKU_PER_HOUR`) → GPT-4o-mini (fallback, `AI_MAX_GPT_PER_HOUR`) → static ATR defaults.

## Proxy

`src/utils/proxy.ts` exports `getProxyAgent()` used in WebSocket and HTTP connections when `HTTPS_PROXY` / `HTTP_PROXY` env vars are set.

## Telegram Commands

All user-facing commands are prefixed `/ai` and handled in `AiCommandService`. The `/start` welcome message (Vietnamese) is in `TelegramBotService.setupCommands()`.
