# Architecture — Binance Trading Bot

## System Overview

NestJS monolith: Telegram bot + AI signal scanner + real Binance Futures trading + hedge system + AI ops agent.

```
                    ┌─────────────┐
                    │  Telegram   │ User commands (/ai)
                    └──────┬──────┘
                           │
┌──────────────────────────┼──────────────────────────┐
│ NestJS Bot               │                          │
│  ┌───────────┐    ┌──────┴──────┐   ┌────────────┐ │
│  │ AiSignal  │───▶│ Position    │──▶│ UserReal   │ │
│  │ Service   │    │ Monitor     │   │ Trading    │ │
│  │ (scanner) │    │ (price tick)│   │ (Binance)  │ │
│  └───────────┘    └──────┬──────┘   └─────┬──────┘ │
│       │                  │                │        │
│  ┌────┴─────┐     ┌──────┴──────┐   ┌────┴──────┐ │
│  │ Strategy │     │ Hedge       │   │ UserData  │ │
│  │ Pipeline │     │ Manager     │   │ Stream    │ │
│  │ (7 strats)│    │ (entry/exit)│   │ (WS fills)│ │
│  └──────────┘     └─────────────┘   └───────────┘ │
└────────────────────────────────────────────────────┘
         │                                    │
    ┌────┴────┐                        ┌──────┴──────┐
    │ MongoDB │                        │  Binance    │
    │ + Redis │                        │  Futures    │
    └─────────┘                        └─────────────┘
         │
    ┌────┴──────────┐
    │ AI Ops Agent  │ (separate process)
    │ 12 skills/15m │
    │ Claude/4h     │
    └───────────────┘
```

## Core Data Flow

### Signal → Trade → Hedge
1. **AiSignalService** scans 200 coins every 30s via CoinFilter → Strategy → RiskScore
2. Signal passes confidence floor (68) + risk score (<55) → ACTIVE signal created
3. **PositionMonitorService** registers price listener → handles TP/SL/Trail/Grid/Hedge on every tick
4. **UserRealTradingService** mirrors sim: places real Binance orders for subscribers
5. **HedgeManagerService** manages hedge lifecycle (entry at -trigger%, TP, trail, progressive SL)

### SIM + Real Principle
SIM and Real **MUST run identical logic**. Real only differs in:
- Order execution (Binance API vs DB-only)
- Entry price (market fill vs tick price)
- Actual SL/TP placed on Binance as algo orders

### Grid DCA (fixed, same for SIM + Real)
- 4 levels: L0=entry(40%), L1=2%(15%), L2=4%(15%), L3=6%(30%)
- DCA continues during hedge (lowers avgEntry for recovery)
- RSI guard on L1+ (prevent DCA during continuous selling)

### Hedge System
- **Entry**: PnL < -hedgeTrigger% (2-8%, auto-tuned by agent)
- **Exit**: TP OR trail (activate +2%, keep 70%) OR recovery close
- **Progressive SL**: cycle 1-2=40%, cycle 3=15%, cycle 4+=8% (only when recovery ratio <50%)
- **Circuit breaker**: 3+ cycles AND recovery<50% AND price beyond SL → close
- **Real trail**: places actual SL on Binance (not just backend check)
- **Direction filter**: `onTradeClose` matches by direction (hedge close can't close main)

### AI Ops Agent (separate process)
- 12 skills run every 15min (free, no AI cost)
- Claude Sonnet analysis every 4h (6x/day)
- Auto-configs: hedgeTrigger (volatility), confidence (drawdown), maxSignals, riskScore
- FIELD_LIMITS validation: hedgeTrigger 2-8%, confidence 55-75%, etc.
- Cannot close/open positions (whitelist: UPDATE_CONFIG, LEARNING, NO_ACTION)

## Key Protection Layers

| Layer | What | Where |
|-------|------|-------|
| Signal quality | Confidence 68, risk score <55 | ai-signal.service |
| Strategy filter | OP_ONCHAIN disabled | TradingConfig |
| Entry guard | Price deviation <2%, slot reservation | user-real-trading |
| Grid DCA | Fixed 2/4/6%, double-check DB before order | user-real-trading |
| Hedge trigger | Floor 2% (code + agent FIELD_LIMITS) | trading-config + agent |
| Progressive SL | Tighten when hedge ineffective | position-monitor + user-real-trading |
| Trail SL | Real SL on Binance, not just backend | user-real-trading |
| Direction filter | onTradeClose matches by direction | user-data-stream |
| Sync grace | 60min protection for synced trades | user-real-trading |
| Agent safety | FIELD_LIMITS clamp all config values | agent skills.js |

## MongoDB Collections

| Collection | Purpose |
|-----------|---------|
| `ai_signals` | Signal lifecycle (QUEUED→ACTIVE→COMPLETED) |
| `orders` | Sim order records (MAIN, HEDGE, FLIP_MAIN) |
| `user_trades` | Real trade records (mirrors orders for real mode) |
| `user_signal_subscriptions` | User settings, real mode, grid config |
| `user_settings` | Binance API keys |
| `ai_market_configs` | TradingConfig persistent store |

## Redis Key Patterns

| Pattern | Purpose |
|---------|---------|
| `binance-telebot:trading-config` | TradingConfig cache (5min refresh) |
| `cache:ai:regime` | Current market regime |
| `cache:hedge:lock:{ctxId}` | Prevent duplicate hedge open |
| `cache:grid-lock:{tgId}:{symbol}:{level}` | Prevent duplicate DCA fill |
| `cache:trail-breach:{tgId}:{symbol}` | Trail breach counter |
| `cache:sl-placed:{tgId}:{symbol}` | SL placement cooldown (10min) |
