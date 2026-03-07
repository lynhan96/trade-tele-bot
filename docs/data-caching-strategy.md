# Data Caching Strategy — Prevent API Spam

> **Last updated**: 2026-03-07
> **Status**: FULLY IMPLEMENTED — all cache layers operational.

## The Problem
- Binance API rate limit: 1200 requests/min (weight-based)
- Claude/GPT API calls cost money -- don't send same data repeatedly
- If we scan 50+ coins on multiple timeframes every few minutes --> instant rate limit ban

## Solution: 4-Layer Cache using Redis

### Layer 1: WebSocket for Real-Time Candles (NO REST spam)
```
Binance WebSocket --> streams candle updates in real-time

  wss://fstream.binance.com/stream (combined stream)

  - Subscribe to kline streams for filtered coins
  - Intervals: 5m, 15m, 1h, 4h, 1d
  - Store OHLC arrays in Redis with TTL
  - ZERO API calls for candle data after initial subscribe
  - Auto-reconnect on close
```

Keys:
- `candle-close-price:{COIN}:{interval}` --> number[] (last 500)
- `candle-open-price:{COIN}:{interval}` --> number[]
- `candle-high-price:{COIN}:{interval}` --> number[] (for Stoch/KDJ)
- `candle-low-price:{COIN}:{interval}` --> number[] (for Stoch/KDJ)

TTL: 5m candles --> 24h, 1h candles --> 7d, 4h/1d --> 30d

### Layer 2: Market Scanner Cache (REST with smart intervals)
```
Coin scanning (which coins are hot?):
  - Full scan: every 2 minutes
  - Binance GET /fapi/v1/ticker/24hr --> returns ALL pairs in 1 call (weight: 40)
  - Store in Redis: cache:market:scan (TTL: 5 min)
  - Filter logic runs on cached data, NOT live API

Futures analytics (funding, OI, L/S ratio):
  - FuturesAnalyticsService fetches per-coin sentiment data
  - Cached 5 min per coin
  - Used for composite scoring in coin filter
```

### Layer 3: AI Decision Cache
```
AI doesn't need to re-analyze every minute:

  Key: cache:ai:params:{symbol} --> AiTunedParams
  TTL: 2 hours + random 15min jitter (prevent thundering herd)

  Key: cache:ai:regime --> current market regime
  TTL: 10 minutes (react fast to crashes/regime shifts)

  Waterfall (only call next if previous exhausted):
  1. Claude Haiku (primary)
  2. GPT-4o-mini (fallback)
  3. GPT-4o (premium, top 5 coins only)
  4. Static ATR defaults (all APIs exhausted)

  Only call AI when:
  1. Cache expired
  2. Emergency override (price moves > 5% in 15min)
  3. New coin enters filter (never analyzed before)
```

### Layer 4: Signal State Cache (Profile-Aware)
```
Signal state management for dual timeframe:

  Key: cache:ai-signal:active:{signalKey}
  TTL: INTRADAY=24h, SWING=72h

  Key: cache:ai-signal:queued:{signalKey}
  TTL: INTRADAY=4h, SWING=48h

  signalKey format: "BTCUSDT:INTRADAY" or "BTCUSDT:SWING"
  (profile-aware for dual timeframe coins)

  Key: cache:ai-signal:state:{symbol}:{strategy}
  TTL: 48h (2-stage pattern state for F4/F5)
```

## Data Flow (Efficient)

```
+---------------------------------------------------+
|  Binance WebSocket (FREE, real-time, no limits)    |
|  Subscribe: 5m, 15m, 1h, 4h, 1d klines            |
|  For: filtered coins (up to 50 coins)              |
+-------------------+-------------------------------+
                    | writes continuously
+---------------------------------------------------+
|  Redis Cache                                       |
|                                                    |
|  candles:BTC:5m    --> [500 candles]  TTL: 24h     |
|  candles:BTC:15m   --> [500 candles]  TTL: 24h     |
|  candles:BTC:1h    --> [500 candles]  TTL: 7d      |
|  candles:BTC:4h    --> [200 candles]  TTL: 30d     |
|  market:scan       --> [all tickers]  TTL: 5min    |
|  ai:params:BTCUSDT --> {strategy...}  TTL: 2h      |
|  ai:regime         --> "STRONG_BULL"  TTL: 10min   |
+-------------------+-------------------------------+
                    | reads from cache
+---------------------------------------------------+
|  Coin Filter (every 2 min)                         |
|  --> reads market:scan from Redis                  |
|  --> fetches futures analytics (cached 5min)       |
|  --> composite scoring: vol 40%, volatility 30%,   |
|      analytics 30%                                 |
|  --> updates subscription list for WebSocket       |
+-------------------+-------------------------------+
                    |
+---------------------------------------------------+
|  AI Optimizer (only when cache expired or event)   |
|  --> reads candles from Redis (not from API)       |
|  --> preCompute: EMA, BB, RSI, ATR, ADX (~5ms)    |
|  --> calls AI waterfall with prepared data         |
|  --> stores result back in Redis with TTL+jitter   |
|  --> estimated: 10-30 AI calls per hour            |
+-------------------+-------------------------------+
                    |
+---------------------------------------------------+
|  Strategy Engine (every 3 min)                     |
|  --> reads candles from Redis                      |
|  --> reads AI params from Redis                    |
|  --> calculates indicators, applies rules          |
|  --> pipe-delimited fallback: tries each strategy  |
|  --> outputs signal if conditions met              |
|  --> ALL from cache, ZERO external API calls       |
+-------------------+-------------------------------+
                    |
+---------------------------------------------------+
|  Real Trading (on signal)                          |
|  --> SignalQueueService: ACTIVE/QUEUED/SKIPPED     |
|  --> UserRealTradingService: MARKET order           |
|  --> PositionMonitorService: real-time TP/SL       |
|  --> UserDataStreamService: WebSocket order fills   |
+---------------------------------------------------+
```

## API Call Budget (Actual)

| Source | Calls | Frequency | Monthly |
|---|---|---|---|
| Binance REST (ticker scan) | 1 | Every 2 min | ~21,600 |
| Binance REST (futures analytics) | ~50 | Every 5 min | ~432,000 |
| Binance WebSocket | 0 (stream) | Always on | 0 |
| Claude Haiku | ~15/hour | 2h cache + refreshes | ~10,800 |
| GPT-4o-mini (fallback) | ~5/hour | When Haiku exhausted | ~3,600 |
| GPT-4o (premium) | ~2/hour | Top 5 coins only | ~1,440 |

Binance REST weight: ~40 per scan = 480/hour (limit is 1,200/min = 72,000/hour).

## Market Cooldown (Safety)

```
Track SL hits in rolling 1-hour window:

  3 consecutive SL hits --> 30-minute market-wide signal pause
  Per-signal cooldown: 30 min after each resolution

  This prevents over-trading during adverse conditions.
  Existing positions continue monitoring -- only NEW signals paused.
```

## Emergency Override
If market moves > 5% in 15 minutes for any filtered coin:
- Bypass cache TTL for that coin
- Invalidate 2-stage pattern state
- Immediately re-analyze with AI (bypass rate limit)
- Run signal check with fresh params
- This handles flash crashes / pumps
