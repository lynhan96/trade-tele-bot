# AI Trading System — Full Design Notes

## Vision
Build an AI-controlled trading system where Claude AI acts as the brain:
1. **Filter coins** — scan market for hot coins (price change, momentum, volume)
2. **Analyze & decide** — AI reads multi-timeframe charts, picks which strategy to use
3. **Output signals** — feeds into existing bot for execution via `handleIncomingSignal()`

## Architecture

```
┌──────────────┐    ┌───────────────┐    ┌─────────────────┐
│ MarketData   │───▶│  CoinFilter   │───▶│   Strategy      │
│ (Binance WS  │    │  (top 10 hot  │    │   Engine        │
│  + REST)     │    │   coins)      │    │  (EMA,RSI,SMC)  │
└──────────────┘    └───────────────┘    └────────┬────────┘
                                                  │
                                         ┌────────▼────────┐
                                         │  AI Optimizer    │
                                         │  (Claude API)    │
                                         │  tunes params    │
                                         └────────┬────────┘
                                                  │
                                         ┌────────▼────────┐
                                         │  Rule Engine     │
                                         │  → IncomingSignal│
                                         │  → handleIncoming│
                                         │    Signal()      │
                                         └─────────────────┘
```

## 3-Layer Architecture

### Layer 1: Market Data + Coin Filter
- **Data source: Binance API only** (free, no rate limit issues)
  - `GET /fapi/v1/ticker/24hr` — all pairs in 1 call every 5min (price change, volume, momentum)
  - WebSocket `client.ws.futuresCandles()` for real-time klines (only filtered coins)
  - `futuresCandles()` REST for historical klines
- **No user API keys needed** — public Binance client `Binance({})`
- CoinMarketCap: skip for now, add later if needed
- **Filter criteria**: price change >3%, volume >$50M, intraday range >5%
- **Output**: shortlist of 5-10 tradeable coins, cached in Redis

### Layer 2: Strategy Engine + AI Brain
- Calculate indicators from cached kline data (no API calls)
- **AI decides WHICH indicators to use** based on market regime:
  - Trending → EMA + candle color
  - Ranging → RSI + RSI-EMA
  - Smart money → SMC (Order Blocks, FVG, BOS/CHoCH)
  - Or combination
- AI adjusts parameters dynamically (EMA periods, RSI thresholds, SL%, confidence)
- **AI does NOT decide buy/sell** — it tunes the knobs, rule engine makes the decision

### Layer 3: Execution (Existing Bot)
- Builds `IncomingSignal` objects
- Calls `telegramBotService.handleIncomingSignal(signal)` directly
- Uses `BOT_FUTURE_CT_8` or new `BOT_FUTURE_AI_1` bot type
- Zero changes to existing execution logic

## Technical Indicators
- EMA (multiple periods: 5, 9, 13, 21, 50, 200) — series + single value
- RSI (14)
- RSI-EMA (RSI smoothed with EMA)
- Candle color / patterns (streak, doji, body-to-wick ratio)
- Volume pressure (buy/sell ratio from candle color classification)
- SMC: Order Blocks, Fair Value Gaps, Break of Structure, Change of Character

## AI Model Tiers
| Layer | Model | Frequency | Cost |
|---|---|---|---|
| Per-symbol parameter tuning | Haiku 4.5 | Every 1 hour | ~$0.001/call |
| Market regime analysis | Sonnet 4.6 | Every 4 hours | ~$0.05/call |
| Hard cap | — | 30 Haiku + 2 Sonnet/hour | — |

## New Module Structure
```
src/
├── market-data/
│   ├── market-data.module.ts        # NestJS module
│   ├── market-data.service.ts       # REST + WebSocket + Redis cache
│   └── market-data.interfaces.ts    # TickerScanResult
├── coin-filter/
│   ├── coin-filter.module.ts        # NestJS module
│   ├── coin-filter.service.ts       # Filter logic (reads cache only)
│   └── coin-filter.interfaces.ts    # FilteredCoin
├── strategy/
│   ├── strategy.module.ts           # NestJS module
│   ├── indicators/
│   │   ├── indicator.service.ts     # EMA, RSI, SMC, volume analysis
│   │   └── indicator.interfaces.ts  # OrderBlock, FVG, StructureBreak
│   ├── rules/
│   │   └── rule-engine.service.ts   # Signal evaluation + confidence scoring
│   └── ai-optimizer/
│       ├── ai-optimizer.service.ts  # Claude API integration
│       └── ai-optimizer.interfaces.ts # MarketRegime, AiTunedParams
├── ai-signal/
│   ├── ai-signal.module.ts          # NestJS module
│   └── ai-signal.service.ts         # Orchestrator + cron jobs
```

## Key Integration Points
- `handleIncomingSignal()` at telegram.service.ts line 3811 — public entry point
- `IncomingSignal` interface at telegram.service.ts line 34 — signal format
- `BOT_TYPE_MAP` at telegram.service.ts line 17 — add AI bot type
- `RedisService.set/get` — all caching uses existing Redis infrastructure
- `@nestjs/schedule` cron — follows existing pattern

## Redis Cache Keys (New)
| Key | TTL | Content |
|---|---|---|
| `cache:market:scan` | 5 min | All futures tickers |
| `cache:candle:{symbol}:{interval}` | 24h | Last 200 candles |
| `cache:filter:shortlist` | 5 min | Filtered top 10 coins |
| `cache:ai:params:{symbol}` | 1-4h | AI-tuned parameters |
| `cache:ai:regime` | 4h | Market regime assessment |
| `cache:ai:call_count:{hour}` | 1h | Rate limit counter |

## Data Flow (Anti-Spam)
See: [data-caching-strategy.md](data-caching-strategy.md)
