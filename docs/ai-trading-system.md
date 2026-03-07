# AI Trading System — Full Design Notes

> **Last updated**: 2026-03-07
> **Status**: FULLY IMPLEMENTED — all phases complete, system is live in production.

## Vision
Build an AI-controlled trading system where Claude AI acts as the brain:
1. **Filter coins** — scan market for hot coins (composite scoring: volume, volatility, futures analytics)
2. **Analyze & decide** — AI reads multi-timeframe data, picks which strategy to use per coin
3. **Output signals** — feeds into existing bot for execution via `handleIncomingSignal()`
4. **Real trading** — places real Binance Futures orders, monitors TP/SL in real-time
5. **Self-protect** — market cooldown, health monitoring, trailing stops

## Architecture

```
+=====================================================================+
|  BINANCE-TELE-BOT                                                    |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  |  MARKET DATA LAYER                           (live + every 2m) |  |
|  |                                                                |  |
|  |  Binance WebSocket --> kline streams --> Redis OHLC cache      |  |
|  |  (5m, 15m, 1h, 4h, 1d for shortlist coins)                    |  |
|  |                                                                |  |
|  |  GET /fapi/v1/ticker/24hr ----------------> cache:market:scan  |  |
|  |  FuturesAnalyticsService --> funding, OI, L/S, taker activity  |  |
|  |  CoinFilterService (composite scoring) --> shortlist (max 50)  |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|                    (every 2h per coin, cached)                       |
|                              v                                       |
|  +---------------------------------------------------------------+  |
|  |  AI OPTIMIZER LAYER                                            |  |
|  |                                                                |  |
|  |  preComputeIndicators() --> EMA, BB, RSI, ATR, ADX (no API)   |  |
|  |          |                                                     |  |
|  |          v                                                     |  |
|  |  Waterfall:                                                    |  |
|  |    1. Claude Haiku (primary)                                   |  |
|  |    2. GPT-4o-mini (fallback)                                   |  |
|  |    3. GPT-4o (premium, top 5 coins)                            |  |
|  |    4. Static ATR defaults (no API left)                        |  |
|  |                                                                |  |
|  |  Output: AiTunedParams --> cache:ai:params:{symbol} (2h+jitter)|  |
|  |  Regime: cache:ai:regime (10min TTL, fast crash reaction)      |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|                    (every 3 minutes)                                 |
|                              v                                       |
|  +---------------------------------------------------------------+  |
|  |  RULE ENGINE LAYER (8 strategies)                              |  |
|  |                                                                |  |
|  |  For each coin in shortlist:                                   |  |
|  |    AI returns pipe-delimited strategies (e.g. "F4|F2")        |  |
|  |    --> tries each until one fires                              |  |
|  |                                                                |  |
|  |    evalRsiCross()        <-- F8 Config 2 (proven)              |  |
|  |    evalRsiZone()         <-- F8 Config 3 (proven)              |  |
|  |    evalTrendEma()        <-- F1 + ADX strength filter          |  |
|  |    evalMeanRevertRsi()   <-- F2 + ADX < 30 + bounce candle     |  |
|  |    evalStochBbPattern()  <-- F4 (2-stage + Redis state)        |  |
|  |    evalStochEmaKdj()     <-- F5 (2-stage + Redis state)        |  |
|  |    evalEmaPullback()     <-- NEW: EMA21 dip/rally in trend     |  |
|  |    evalBbScalp()         <-- NEW: BB bounce + deep RSI         |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|                     (on signal found)                                |
|                              v                                       |
|  +---------------------------------------------------------------+  |
|  |  SIGNAL QUEUE LAYER                        (MongoDB + Redis)   |  |
|  |                                                                |  |
|  |  No active signal   --> ACTIVE --> real order placement        |  |
|  |  Active + opposite  --> QUEUED (stored, waits for close)       |  |
|  |  Active + same dir  --> SKIPPED                                |  |
|  |                                                                |  |
|  |  Profile-aware (dual timeframe):                               |  |
|  |    INTRADAY: 15m primary, 1h HTF (BTC/ETH/SOL/BNB/XRP)       |  |
|  |    SWING:    4h primary, 1d HTF  (same top 5 coins)           |  |
|  |    Other coins: SWING only                                     |  |
|  +---------------------------------------------------------------+  |
|                              |                                       |
|                   (signal executed)                                  |
|                              v                                       |
|  +---------------------------------------------------------------+  |
|  |  EXECUTION + MONITORING LAYER                                  |  |
|  |                                                                |  |
|  |  UserRealTradingService:                                       |  |
|  |    --> MARKET order on Binance Futures                         |  |
|  |    --> Entry price tolerance (1% deviation)                    |  |
|  |    --> Position slot reservation (atomic Redis Lua)            |  |
|  |    --> Per-user max positions + daily limits                   |  |
|  |                                                                |  |
|  |  PositionMonitorService (real-time ~250ms):                    |  |
|  |    --> Price listener callbacks                                |  |
|  |    --> SL-moved-to-entry (break-even protection)               |  |
|  |    --> 5% milestone: SL raised to +2% profit                  |  |
|  |    --> TP boost on volume momentum                             |  |
|  |                                                                |  |
|  |  UserDataStreamService:                                        |  |
|  |    --> Binance Futures WebSocket (order fill events)           |  |
|  |    --> Detects SL/TP fills in real-time                        |  |
|  |    --> Keepalive every 30min, auto-reconnect                   |  |
|  |                                                                |  |
|  |  Market Cooldown:                                              |  |
|  |    --> 3 consecutive SL hits --> 30min market-wide pause       |  |
|  |    --> Per-signal cooldown (30min after resolution)             |  |
|  |                                                                |  |
|  |  HealthMonitorService (every 10min):                           |  |
|  |    --> Error log analysis, stale signal detection              |  |
|  |    --> Signals near SL warnings                                |  |
|  |    --> Orphan trade detection, system pause status              |  |
|  +---------------------------------------------------------------+  |
+=====================================================================+
```

## Module Structure (Actual Implementation)

```
binance-tele-bot/src/
+-- ai-signal/
|   +-- ai-signal.module.ts
|   +-- ai-signal.service.ts            <-- main orchestrator (crons: 2m filter, 3m signals)
|   +-- ai-command.service.ts           <-- /ai Telegram commands (15+ commands)
|   +-- signal-queue.service.ts         <-- ACTIVE/QUEUED/SKIPPED state machine
|   +-- position-monitor.service.ts     <-- real-time TP/SL + trailing stops
|   +-- user-real-trading.service.ts    <-- places real Binance Futures orders
|   +-- user-signal-subscription.service.ts
|   +-- user-data-stream.service.ts     <-- Binance user WebSocket (order fills)
|   +-- ai-signal-stats.service.ts      <-- win rate / PnL analytics
|   +-- health-monitor.service.ts       <-- system health checks (every 10min)
|
+-- strategy/
|   +-- strategy.module.ts
|   +-- indicators/
|   |   +-- indicator.service.ts        <-- RSI, EMA, BB, Stoch, KDJ, ADX
|   +-- rules/
|   |   +-- rule-engine.service.ts      <-- 8 strategies (F1-F8 + EMA_PULLBACK + BB_SCALP)
|   +-- ai-optimizer/
|       +-- ai-optimizer.service.ts     <-- Haiku/GPT waterfall + regime detection
|       +-- ai-tuned-params.interface.ts
|
+-- market-data/
|   +-- market-data.module.ts
|   +-- market-data.service.ts          <-- WebSocket klines (5m,15m,1h,4h,1d) + ticker REST
|   +-- futures-analytics.service.ts    <-- funding rate, OI, L/S ratio, taker activity
|
+-- coin-filter/
|   +-- coin-filter.module.ts
|   +-- coin-filter.service.ts          <-- composite scoring (volume 40%, volatility 30%, analytics 30%)
|
+-- user/
    +-- user-settings.service.ts        <-- Binance API keys storage
```

## 8 Trading Strategies

| # | Strategy | Type | Key Indicators | Best Regime |
|---|---|---|---|---|
| 1 | **TREND_EMA** | Trend-following | EMA9 x EMA21 cross + ADX strength | STRONG_TREND |
| 2 | **MEAN_REVERT_RSI** | Mean reversion | EMA200 + RSI extreme + ADX < 30 + bounce candle | RANGE_BOUND |
| 3 | **STOCH_BB_PATTERN** | Reversal (2-stage) | 3-candle pattern at BB + Stoch cross confirmation | RANGE_BOUND |
| 4 | **STOCH_EMA_KDJ** | Momentum (2-stage) | Stoch cross in extreme + EMA body pierce + KDJ | VOLATILE |
| 5 | **RSI_CROSS** | RSI momentum | RSI crosses RSI-EMA + HTF confirmation | STRONG_TREND |
| 6 | **RSI_ZONE** | RSI reversal | RSI OB/OS zones + candle direction | VOLATILE |
| 7 | **EMA_PULLBACK** | Trend pullback | Dip to EMA21 in bull trend + HTF RSI | STRONG_TREND |
| 8 | **BB_SCALP** | BB bounce | Lower/upper BB bounce + deep RSI (<35) + body% | RANGE_BOUND |

## Market Regime Types

| Regime | Trigger | Primary Strategy | Backup |
|---|---|---|---|
| **STRONG_BULL** | EMA aligned bullish, RSI > 50, cross-TF confirmation | TREND_EMA | RSI_CROSS |
| **STRONG_BEAR** | EMA aligned bearish, RSI < 50 | TREND_EMA | RSI_CROSS |
| **RANGE_BOUND** | emaTrend=MIXED, bbWidth<2.5%, RSI 30-70 | STOCH_BB_PATTERN | MEAN_REVERT_RSI |
| **SIDEWAYS** | Low volatility, no clear direction | BB_SCALP | RSI_ZONE |
| **VOLATILE** | bbWidth>5%, ATR>1.5%, volume spike | RSI_ZONE | STOCH_EMA_KDJ |
| **BTC_CORRELATION** | BTC at BB extreme, alts following | BB_CORRELATION | MEAN_REVERT_RSI |
| **MIXED** | No clear regime | RSI_CROSS | EMA_PULLBACK |

## Dual Timeframe Strategy

Top 5 coins (BTC, ETH, SOL, BNB, XRP) run **both** profiles simultaneously:

| Profile | Primary TF | HTF Confirmation | Active TTL | Queued TTL |
|---|---|---|---|---|
| **INTRADAY** | 15m | 1h | 24h | 4h |
| **SWING** | 4h | 1d | 72h | 48h |

All other coins run SWING only. Cross-profile conflict detection prevents simultaneous entry.

## AI Model Tiers (Waterfall)

| Priority | Model | Use Case | Rate Limit | Cache TTL |
|---|---|---|---|---|
| 1 | Claude Haiku | Per-coin parameter tuning | `AI_MAX_HAIKU_PER_HOUR` | 2h + 15min jitter |
| 2 | GPT-4o-mini | Fallback when Haiku exhausted | `AI_MAX_GPT_PER_HOUR` (200/hr) | 2h |
| 3 | GPT-4o | Premium analysis (top 5 coins) | `AI_MAX_GPT4O_PER_HOUR` (30/hr) | 2h |
| 4 | Static defaults | All APIs exhausted | N/A | N/A |

**AI decides**: regime, strategy (pipe-delimited fallbacks), SL% (7-15%), TP% (1.5x-3x SL), confidence (0-100), timeframe profile.

## Coin Filter (Composite Scoring)

Scoring weights:
- **Volume** (40%): log-normalized USD 24h volume
- **Volatility** (30%): abs(% change)
- **Analytics** (30%): funding rate, L/S ratio, taker buy/sell activity

Always includes: BTC, ETH, SOL, BNB, XRP (priority slots).
Max shortlist: `AI_MAX_SHORTLIST_SIZE` (default 50).
Min volume: `AI_MIN_COIN_VOLUME_USD` (default $10M).
Min change: `AI_MIN_PRICE_CHANGE_PCT` (default 0.3%).

## Redis Cache Keys

| Key | TTL | Content |
|---|---|---|
| `candle-close-price:{COIN}:{interval}` | by interval | Close prices[] |
| `candle-open-price:{COIN}:{interval}` | by interval | Open prices[] |
| `candle-high-price:{COIN}:{interval}` | by interval | High prices[] (for Stoch/KDJ) |
| `candle-low-price:{COIN}:{interval}` | by interval | Low prices[] (for Stoch/KDJ) |
| `cache:market:scan` | 5 min | All futures tickers |
| `cache:filter:shortlist` | 6 min | FilteredCoin[] (composite scored) |
| `cache:ai:params:{symbol}` | 2h + jitter | AiTunedParams (AI output) |
| `cache:ai:regime` | 10 min | Market regime (fast crash reaction) |
| `cache:ai:call_count:{YYYY-MM-DD-HH}` | 1h | Rate limit counter |
| `cache:ai-signal:active:{signalKey}` | 24h/72h | Active signal ref (profile-aware) |
| `cache:ai-signal:queued:{signalKey}` | 4h/48h | Queued signal ref (profile-aware) |
| `cache:ai-signal:state:{symbol}:{strategy}` | 48h | 2-stage state for F4/F5 |

## Telegram Commands

| Command | Description |
|---|---|
| `/ai on\|off` | Toggle real trading mode |
| `/ai setkeys <key> <secret>` | Save Binance API keys |
| `/ai settings` | Show user settings |
| `/ai leverage <n>` | Set leverage (or "ai" for dynamic) |
| `/ai target <n>` | Daily profit target |
| `/ai stoploss <n>` | Daily loss limit |
| `/ai maxpos <n>` | Max concurrent positions |
| `/ai vol <n>` | Position volume |
| `/ai balance` | Show account balance |
| `/ai tpsl` | Custom TP/SL overrides |
| `/ai my` | Dashboard + current positions |
| `/ai my history` | PnL history |
| `/ai account` | Account overview |
| `/ai signals` | Active/queued signals list |
| `/ai rank` | Strategy performance ranking |
| `/ai daily history` | Daily PnL summary |
| `/ai moneyflow on\|off` | Toggle money flow alerts |
| `/ai status` | System status (admin) |
| `/ai pause` / `/ai resume` | Pause/resume signal generation |
| `/ai override <symbol> <strategy>` | Force strategy for a coin |

## Safety Features

- **Market cooldown**: 30-min pause after 3 consecutive SL hits (rolling 1h window)
- **Per-signal cooldown**: 30-min after each signal resolution
- **Daily limits**: Per-user daily profit target and loss limit tracking
- **Health monitor**: Every 10 min — error logs, stale signals, orphan trades, near-SL warnings
- **Entry tolerance**: 1% max deviation from signal entry price
- **Position slots**: Atomic reservation via Redis Lua scripts
- **Symbol blacklist**: XAUUSDT, XAGUSDT, MSTRUSDT excluded
- **Test mode**: Signals generated but no real orders placed

## Data Flow (Anti-Spam)
See: [data-caching-strategy.md](data-caching-strategy.md)

## Key Integration Points
- `handleIncomingSignal()` — public entry point for signal execution
- `IncomingSignal` interface — signal format
- `BOT_FUTURE_AI_1` — AI bot type in `BOT_TYPE_MAP`
- `RedisService.set/get` — all caching uses existing Redis infrastructure
- `@nestjs/schedule` cron — follows existing pattern
- MongoDB Change Streams — real-time admin panel updates
