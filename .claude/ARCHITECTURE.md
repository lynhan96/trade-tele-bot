# Architecture — Binance Trading Bot

## System Overview

NestJS monolith: Telegram bot + AI signal scanner + real Binance Futures trading + hedge system.

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
│  │ (6 strats)│    │ (entry/exit)│   │ (WS fills)│ │
│  └──────────┘     └─────────────┘   └───────────┘ │
└────────────────────────────────────────────────────┘
         │                                    │
    ┌────┴────┐                        ┌──────┴──────┐
    │ MongoDB │                        │  Binance    │
    │ + Redis │                        │  Futures    │
    └─────────┘                        └─────────────┘
```

## Core Data Flow

### Signal → Trade → Hedge
1. **AiSignalService** scans 200 coins every 30s via CoinFilter → Strategy → RiskScore
2. Signal passes confidence floor (65) + risk score (<55) → ACTIVE signal created
3. **PositionMonitorService** registers price listener → handles TP/SL/Trail/Grid/Hedge on every tick
4. **UserRealTradingService** mirrors sim: places real Binance orders for subscribers
5. **HedgeManagerService** manages hedge lifecycle (entry at -trigger%, TP, trail, recovery)

### SIM + Real Principle
SIM and Real **MUST run identical logic**. Real only differs in:
- Order execution (Binance API vs DB-only)
- Entry price (market fill vs tick price)
- Position-gone detection as safety net (1min cron)

### Grid DCA (fixed, same for SIM + Real)
- 4 levels: L0=entry(40%), L1=2%(15%), L2=4%(15%), L3=6%(30%)
- DCA continues during hedge (lowers avgEntry for recovery)
- RSI guard on L1+ (prevent DCA during continuous selling)

### Hedge System
- **Entry**: PnL < -hedgeTriggerPct% (default 3%, hard floor 2%)
- **Exit**: TP OR trail (activate +2%, keep 70%) OR recovery close (main>1% + hedge≥1.5%)
- **SL disabled during hedge**: hedge cycles indefinitely until NET_POSITIVE > 2%
- **After hedge close**: restore 40% safety SL on main
- **Direction filter**: `onTradeClose` matches by direction (hedge close can't close main)

## Key Protection Layers

| Layer | What | Where |
|-------|------|-------|
| Signal quality | Confidence 65+, risk score <55 | ai-signal.service |
| Confluence | 2+ strategies must agree | rule-engine.service |
| Entry guard | Price deviation <3%, slot reservation | user-real-trading |
| Grid DCA | Fixed 2/4/6%, RSI guard, 5min cooldown | position-monitor |
| Hedge trigger | Hard floor 2% in TradingConfig.get() | trading-config |
| Trail SL | SIM controls, propagates to real (5s debounce) | position-monitor |
| Direction filter | onTradeClose matches by direction | user-data-stream |
| Sync grace | 60min protection for synced trades | user-real-trading |
| Position-gone | 1min cron detects Binance position closed | user-real-trading |

## MongoDB Collections

| Collection | Purpose |
|-----------|---------|
| `ai_signals` | Signal lifecycle (QUEUED→ACTIVE→COMPLETED) |
| `orders` | Sim order records (MAIN, DCA, HEDGE, FLIP_MAIN) |
| `user_trades` | Real trade records (mirrors orders for real mode) |
| `user_signal_subscriptions` | User settings, real mode, grid config |
| `user_settings` | Binance API keys |
| `ai_market_configs` | TradingConfig persistent store |

## Redis Key Patterns

| Pattern | Purpose |
|---------|---------|
| `cache:ai:trading-config` | TradingConfig cache (5min refresh) |
| `cache:ai:regime` | Current market regime |
| `cache:hedge:lock:{ctxId}` | Prevent duplicate hedge open |
| `cache:grid-lock:{tgId}:{symbol}:{level}` | Prevent duplicate DCA fill |
| `cache:trail-breach:{tgId}:{symbol}` | Trail breach counter |
| `cache:sl-placed:{tgId}:{symbol}` | SL placement cooldown (10min) |
