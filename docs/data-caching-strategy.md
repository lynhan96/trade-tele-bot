# Data Caching Strategy — Prevent API Spam

## The Problem
- Binance API rate limit: 1200 requests/min (weight-based)
- CoinMarketCap free tier: 333 calls/day (~10K/month)
- If we scan 200+ coins on multiple timeframes every few minutes → instant rate limit ban
- Claude API calls cost money — don't send same data repeatedly

## Solution: 3-Layer Cache using Redis

### Layer 1: WebSocket for Real-Time Candles (NO REST spam)
```
Instead of polling REST API every minute:
  Binance WebSocket → streams candle updates in real-time

  ws://stream.binance.com:9443/ws/btcusdt@kline_5m

  - Subscribe to kline streams for filtered coins
  - Store latest candles in Redis with TTL
  - ZERO API calls for candle data after initial subscribe
```

Key: `cache:candle:{symbol}:{timeframe}` → last 200 candles
TTL: 5m candles → 24h TTL, 1h candles → 7 day TTL

### Layer 2: Market Scanner Cache (REST with smart intervals)
```
Coin scanning (which coins are hot?):
  - Full scan: every 5 minutes (1 API call, returns all tickers)
  - Binance GET /fapi/v1/ticker/24hr → returns ALL pairs in 1 call (weight: 40)
  - CoinMarketCap /v1/cryptocurrency/listings/latest → top 200 in 1 call

  Store in Redis:
  Key: cache:market:scan → full ticker data
  TTL: 5 minutes

  Filter logic runs on cached data, NOT live API
```

### Layer 3: AI Decision Cache
```
AI doesn't need to re-analyze every minute:

  Key: cache:ai:params:{symbol} → AI's recommended config
  TTL: 1-4 hours (based on AI tier)

  Key: cache:ai:regime → current market regime assessment
  TTL: 4 hours

  Only call Claude API when:
  1. Cache expired
  2. Major market event detected (price moves > 5% in 15min)
  3. New coin enters filter (never analyzed before)
```

## Data Flow (Efficient)

```
┌─────────────────────────────────────────────────┐
│  Binance WebSocket (FREE, real-time, no limits) │
│  Subscribe: kline_5m, kline_15m, kline_1h       │
│  For: filtered coins only (5-10 coins)          │
└──────────────┬──────────────────────────────────┘
               ↓ writes continuously
┌─────────────────────────────────────────────────┐
│  Redis Cache                                     │
│                                                  │
│  candles:BTCUSDT:5m  → [200 candles]  TTL: 24h  │
│  candles:BTCUSDT:15m → [200 candles]  TTL: 24h  │
│  candles:BTCUSDT:1h  → [200 candles]  TTL: 7d   │
│  market:scan         → [all tickers]  TTL: 5min  │
│  ai:params:BTCUSDT   → {ema, rsi...}  TTL: 2h   │
│  ai:regime           → "trending"     TTL: 4h   │
└──────────────┬──────────────────────────────────┘
               ↓ reads from cache
┌─────────────────────────────────────────────────┐
│  Coin Filter (every 5 min)                       │
│  → reads market:scan from Redis                  │
│  → NO API call, just filter cached data          │
│  → updates subscription list for WebSocket       │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  AI Brain (only when cache expired or event)     │
│  → reads candles from Redis (not from API)       │
│  → calls Claude API with prepared data           │
│  → stores result back in Redis with TTL          │
│  → estimated: 10-20 Claude calls per hour        │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│  Strategy Engine (every 30s)                     │
│  → reads candles from Redis                      │
│  → reads AI params from Redis                    │
│  → calculates indicators, applies rules          │
│  → outputs signal if conditions met              │
│  → ALL from cache, ZERO external API calls       │
└─────────────────────────────────────────────────┘
```

## API Call Budget (Estimated)

| Source | Calls | Frequency | Monthly |
|---|---|---|---|
| Binance REST (ticker scan) | 1 | Every 5 min | 8,640 |
| Binance WebSocket | 0 (stream) | Always on | 0 |
| CoinMarketCap | 1 | Every 15 min | 2,880 |
| Claude Haiku | ~15/hour | Hourly | ~10,800 |
| Claude Sonnet | ~4/day | Every 4-6h | ~120 |

All well within rate limits. Total Binance REST weight: ~40 per 5min = 480/hour (limit is 1200/min).

## Emergency Override
If market moves > 5% in 15 minutes for any filtered coin:
- Bypass cache TTL
- Immediately re-scan + re-analyze
- Call Claude with "urgent" context
- This handles flash crashes / pumps
