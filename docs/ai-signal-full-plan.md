# AI Signal System — Full Plan + Sample Trading + Flow

> **Last updated**: 2026-03-07
> **Status**: FULLY IMPLEMENTED — all features live in production. This doc preserves the original plan + sample scenarios for reference.

---

## Part 1: System Overview

### What It Is
An autonomous signal generator **living inside `binance-tele-bot`** that:
- Scans the top 50 most active futures coins every 2 minutes (composite scoring)
- Uses AI waterfall (Haiku --> GPT-4o-mini --> GPT-4o --> static defaults) to tune parameters
- Runs 8 strategies (F1-F8 + EMA_PULLBACK + BB_SCALP) with pipe-delimited fallbacks
- Dual timeframe: INTRADAY (15m) + SWING (4h) for top 5 coins
- Signal queue with ACTIVE/QUEUED/SKIPPED state machine
- Places real Binance Futures orders with position monitoring + trailing stops
- Market cooldown, health monitoring, 15+ Telegram /ai commands

### What It Is NOT
- NOT a new exchange integration
- NOT a separate app (runs inside existing `binance-tele-bot`)
- NOT a black-box AI — AI only tunes parameters, formula logic decides the signal
- NOT replacing F8 / bot-signal — it runs in parallel as `BOT_FUTURE_AI_1`

---

## Part 2: Complete Architecture

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  BINANCE-TELE-BOT                                                         ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  MARKET DATA LAYER                              (every 5 min / live)│  ║
║  │                                                                     │  ║
║  │  Binance WebSocket ──► kline streams ──► Redis OHLC cache           │  ║
║  │  (kline_5m, 15m, 1h   for shortlist coins)                         │  ║
║  │                                                                     │  ║
║  │  GET /fapi/v1/ticker/24hr ──────────────► cache:market:scan (5min)  │  ║
║  │  CoinFilterService ────────────────────► cache:filter:shortlist     │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                              │                                            ║
║                    (every 1h per coin)                                    ║
║                              ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  AI OPTIMIZER LAYER                                                 │  ║
║  │                                                                     │  ║
║  │  preComputeIndicators() ──► EMA align, BB width, RSI, ATR (no API) │  ║
║  │          │                                                          │  ║
║  │          ▼                                                          │  ║
║  │  Haiku API ──► AiTunedParams ──► cache:ai:params:{symbol} (1–4h)   │  ║
║  │  Sonnet API ──► global regime ──► cache:ai:regime         (4h)     │  ║
║  │  Fallback  ──► F8 default params  (if AI unavailable)              │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                              │                                            ║
║                    (every 30 seconds)                                     ║
║                              ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  RULE ENGINE LAYER (8 strategies, pipe-delimited fallbacks)         │  ║
║  │                                                                     │  ║
║  │  For each coin in shortlist:                                        │  ║
║  │    evalRsiCross()        ← F8 Config 2 logic (proven)              │  ║
║  │    evalRsiZone()         ← F8 Config 3 logic (proven)              │  ║
║  │    evalTrendEma()        ← F1 + ADX strength filter                │  ║
║  │    evalMeanRevertRsi()   ← F2 + ADX < 30 + bounce candle          │  ║
║  │    evalStochBbPattern()  ← F4 (2-stage + Redis state)              │  ║
║  │    evalStochEmaKdj()     ← F5 (2-stage + Redis state + KDJ)       │  ║
║  │    evalEmaPullback()     ← NEW: EMA21 dip/rally in trend           │  ║
║  │    evalBbScalp()         ← NEW: BB bounce + deep RSI              │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                              │                                            ║
║                     (on signal found)                                     ║
║                              ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  SIGNAL QUEUE LAYER                              (MongoDB + Redis)  │  ║
║  │                                                                     │  ║
║  │  No active signal   ──► ACTIVE ──► handleIncomingSignal()          │  ║
║  │  Active + opposite  ──► QUEUED (stored in MongoDB, waits)          │  ║
║  │  Active + same dir  ──► SKIPPED                                    │  ║
║  │                                                                     │  ║
║  │  PositionMonitorService (real-time ~250ms):                         │  ║
║  │    SL/TP monitoring + trailing stops                                │  ║
║  │    SL-to-entry (break-even) | 5% milestone | TP boost              │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                              │                                            ║
║                   (signal executed)                                       ║
║                              ▼                                            ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  EXECUTION + REAL TRADING LAYER                                     │  ║
║  │                                                                     │  ║
║  │  UserRealTradingService:                                            │  ║
║  │    → MARKET order on Binance Futures                                │  ║
║  │    → Entry price tolerance (1% deviation)                           │  ║
║  │    → Position slot reservation (atomic Redis Lua)                   │  ║
║  │    → Per-user max positions + daily limits                          │  ║
║  │                                                                     │  ║
║  │  UserDataStreamService:                                             │  ║
║  │    → Binance Futures WebSocket (order fill events)                  │  ║
║  │    → Detects SL/TP fills in real-time                              │  ║
║  │    → Keepalive + auto-reconnect                                    │  ║
║  │                                                                     │  ║
║  │  Market Cooldown:                                                   │  ║
║  │    → 3 consecutive SL hits → 30min pause                           │  ║
║  │    → Per-signal cooldown (30min after resolution)                   │  ║
║  │                                                                     │  ║
║  │  HealthMonitorService (every 10min):                                │  ║
║  │    → Error logs, stale signals, orphan trades, near-SL warnings    │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## Part 3: Complete Data Flow (Step-by-Step)

### Startup Sequence

```
T+0s    App starts (onModuleInit)
T+1s    MarketDataService: subscribe to BTC/ETH/SOL/... klines (5m, 15m, 1h)
T+3s    MarketDataService: fetch /fapi/v1/ticker/24hr → cache:market:scan
T+4s    CoinFilterService: compute shortlist → cache:filter:shortlist
T+5s    AiOptimizerService: assessGlobalRegime() → Sonnet call → cache:ai:regime
T+10s   AiOptimizerService: tuneParamsForSymbol() for each shortlist coin (Haiku × 10)
T+30s   AiSignalService first cron run → all 10 coins checked against their AI params
T+60s   PositionMonitorService first run → fetch open positions for monitor account
```

### Every 30-Second Signal Cycle

```
T+0ms   cron fires: AiSignalService.runSignalScan()
T+1ms   Redis: GET cache:filter:shortlist → [BTCUSDT, ETHUSDT, SOLUSDT, ...]
T+5ms   For each coin (parallel, Promise.allSettled):
          Redis: GET cache:ai:params:{symbol}
          If null → AiOptimizerService.tuneParamsForSymbol() (async, Haiku call)
          Else → use cached AiTunedParams
T+8ms   RuleEngineService.evaluate(params, coin)
          → reads Redis OHLC cache
          → runs formula math (RSI, EMA, Stoch, etc.)
          → returns SignalResult | null
T+10ms  If SignalResult:
          SignalQueueService.handleNewSignal()
          → MongoDB: find active signal for symbol
          → decide: ACTIVE / QUEUED / SKIPPED
T+15ms  If ACTIVE → buildIncomingSignal() → handleIncomingSignal()
          → existing execution layer handles per-user trading
T+30ms  Same cycle runs for PositionMonitorService.checkAndResolve()
```

### Candle Update Flow (WebSocket)

```
Binance WebSocket fires kline close event:
  {symbol: 'BTCUSDT', interval: '15m', isFinal: true,
   open: 95100, high: 95400, low: 94900, close: 95250, volume: ...}
     │
     ▼
MarketDataService.onKlineClose():
  1. Append close to candle-close-price:BTC:15m  (keep last 500)
  2. Append open  to candle-open-price:BTC:15m
  3. Append high  to candle-high-price:BTC:15m   ← new, needed for F4/F5
  4. Append low   to candle-low-price:BTC:15m    ← new, needed for F4/F5
  5. Reset TTL for all 4 keys
```

---

## Part 4: Sample Trading Scenarios

### Scenario A — Clean Single Signal (BTCUSDT Trending Day)

**Context**: Monday 09:00, Bitcoin has been trending up since 07:00.
Regime: STRONG_TREND | Strategy: RSI_CROSS (AI selected)

```
Timeline:

09:00  Sonnet assesses global regime: "STRONG_TREND, confidence=85"
       cache:ai:regime = 'STRONG_TREND'

09:05  Haiku tunes BTCUSDT params:
       {
         regime: 'STRONG_TREND',
         strategy: 'RSI_CROSS',
         confidence: 82,
         rsiCross: {
           primaryKline: '15m',
           rsiPeriod: 14,
           rsiEmaPeriod: 9,
           enableThreshold: true,
           rsiThreshold: 50,
           enableHtfRsi: true,
           htfKline: '1h',
           enableCandleDir: true,
           candleKline: '15m',
         },
         stopLossPercent: 1.8,
         minConfidenceToTrade: 70,
       }
       cache:ai:params:BTCUSDT = above (TTL: 1h)

09:15  15m candle closes at $95,200
       AiSignalService cron fires at 09:15:30

       RuleEngine.evalRsiCross():
         RSI(14) on 15m: last=47.3, secondLast=52.1   ← crossed BELOW: was above 50, now below
         RSI-EMA(9):     last=49.8, secondLast=49.6
         crossedBelow = (47.3 < 49.8 && 52.1 >= 49.6) = TRUE
         → SHORT signal candidate
         rsiThreshold check: 47.3 <= 50 → FAIL (for SHORT, RSI must be ABOVE threshold)
         → null (no signal)

09:30  15m candle closes at $95,450
       RSI(14): last=55.2, secondLast=48.9   ← crossed ABOVE RSI-EMA
       RSI-EMA(9): last=50.4, secondLast=50.1
       crossedAbove = (55.2 > 50.4 && 48.9 <= 50.1) = TRUE
       → LONG candidate
       rsiThreshold check: 55.2 >= 50 → FAIL (for LONG, RSI must be BELOW threshold)
       → null (no signal)

09:45  15m candle closes at $95,680
       RSI(14): last=58.4, secondLast=52.1
       RSI-EMA(9): last=54.2, secondLast=51.8
       crossedAbove = TRUE
       rsiThreshold: 58.4 < 50 → wait, 58.4 >= 50 → threshold FAILS
       → null

10:00  15m candle closes at $96,100
       RSI(14): last=44.8, secondLast=56.2  ← RSI drops below EMA
       RSI-EMA(9): last=52.1, secondLast=54.3
       crossedBelow = TRUE → SHORT candidate
       rsiThreshold: 44.8 <= 50 → FAIL for SHORT
       → null

10:15  BTC dips to $95,800, RSI resets

10:30  15m candle closes at $96,350
       RSI(14): last=43.2, secondLast=51.8
       RSI-EMA(9): last=49.1, secondLast=51.2
       crossedAbove check: 43.2 > 49.1? NO
       crossedBelow check: 43.2 < 49.1 AND 51.8 >= 51.2 → TRUE → SHORT candidate
       rsiThreshold: 43.2 <= 50 → FAIL for SHORT (need RSI > 50 for SHORT)
       → null

11:00  BTC rallies hard, closes $97,200
       RSI(14): last=67.4, secondLast=58.2
       RSI-EMA(9): last=61.8, secondLast=60.1
       crossedAbove: 67.4 > 61.8 AND 58.2 <= 60.1 → TRUE → LONG!
       rsiThreshold: 67.4 >= 50? YES → FAIL for LONG (need RSI < 50 for LONG cross)
       → null

11:15  BTC pullback closes $96,800
       RSI(14): last=46.3, secondLast=63.1
       RSI-EMA(9): last=58.7, secondLast=60.2
       crossedBelow: 46.3 < 58.7 AND 63.1 >= 60.2 → TRUE → SHORT candidate
       rsiThreshold: 46.3 <= 50 → FAIL for SHORT
       → null

11:30  BTC bounces, closes $97,400
       RSI(14): last=38.2, secondLast=46.8  ← BELOW 50
       RSI-EMA(9): last=44.6, secondLast=53.2
       crossedAbove: 38.2 > 44.6? NO
       crossedBelow: 38.2 < 44.6 AND 46.8 >= 53.2? NO
       → null

11:45  15m candle closes at $97,900
       RSI(14): last=62.4, secondLast=38.2  ← BIG RSI jump
       RSI-EMA(9): last=46.8, secondLast=44.6
       crossedAbove: 62.4 > 46.8 AND 38.2 <= 44.6 → TRUE → LONG!
       rsiThreshold: 62.4 < 50? NO → FAIL for LONG

       Hmm. Let's say threshold is 55:
       rsiThreshold: 62.4 < 55? NO → FAIL

12:00  15m candle closes at $98,100
       RSI(14): last=48.6, secondLast=62.4
       RSI-EMA(9): last=52.4, secondLast=46.8
       crossedAbove: 48.6 > 52.4? NO
       crossedBelow: 48.6 < 52.4 AND 62.4 >= 46.8 → TRUE → SHORT!
       rsiThreshold for SHORT: 48.6 > 50? NO → FAIL
       → null

12:15  15m candle closes at $97,500
       RSI(14): last=41.2, secondLast=48.3  ← below 50
       RSI-EMA(9): last=48.1, secondLast=52.2
       crossedAbove: 41.2 > 48.1? NO
       crossedBelow: 41.2 < 48.1 AND 48.3 >= 52.2? NO (48.3 < 52.2 → crossedBelow fails!)

Let me use a cleaner example instead. The real idea is:

12:30  RSI drops to 28.4 (oversold territory after 5% correction)

       Using RSI_ZONE strategy (fallback when RSI_CROSS gives no signal):
       RSI(14) = 28.4 < rsiBottom(30) → LONG signal!

       HTF check (1h): RSI(14)=42.1, RSI-EMA(9)=39.8 → 42.1 > 39.8 → PASS (bullish HTF)
       Initial candle: close(97,500) > open(97,200) → GREEN → PASS

       ✅ SIGNAL: BTCUSDT LONG

       SignalQueueService.handleNewSignal():
         MongoDB find active for BTCUSDT → null (no active signal)
         → Execute immediately as ACTIVE
```

**MongoDB record created:**
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "symbol": "BTCUSDT",
  "coin": "btc",
  "currency": "usdt",
  "direction": "LONG",
  "entryPrice": 97500,
  "stopLossPrice": 95745,
  "stopLossPercent": 1.8,
  "strategy": "RSI_ZONE",
  "regime": "STRONG_TREND",
  "aiConfidence": 82,
  "status": "ACTIVE",
  "expiresAt": "2026-02-27T16:30:00Z",
  "generatedAt": "2026-02-27T12:30:00Z",
  "executedAt": "2026-02-27T12:30:02Z",
  "sentToUsers": 3
}
```

**Redis state:**
```
cache:ai-signal:active:BTCUSDT = "507f1f77bcf86cd799439011"  TTL: 8h
```

**Telegram message sent to all users with BOT_FUTURE_AI_1:**
```
📡 Bot Signal Nhận Được

📈 BTCUSDT LONG
├ Bot: AI1
├ Sàn: BINANCE
├ Giá vào: $97,500
├ Stop Loss: $95,745 (-1.8%)
├ Volume: $500
├ Đòn bẩy: 10x
└ Timeframe: 15m

🧠 AI Analysis:
├ Regime: STRONG_TREND (82%)
├ Strategy: RSI_ZONE (RSI oversold 28.4 < 30)
└ HTF 1h: Bullish ✓
```

**What happens inside handleIncomingSignal() for 3 users:**
```
User A (volume=$500, leverage=10x):
  Open positions check: BTCUSDT → no LONG position → PROCEED
  Order: BUY BTCUSDT, size=0.0051 BTC ($500 notional at 10x)
  Entry: $97,500 (market order, actual fill ~$97,512)
  TP set: $97,500 × 1.05 = $102,375 (user configured 5% TP)
  SL set: $95,745 (from signal)

User B (volume=$200, leverage=5x):
  Open positions check: BTCUSDT → no LONG position → PROCEED
  Order: BUY BTCUSDT, size=0.001 BTC ($200 notional at 5x)
  Entry: $97,500

User C (volume=$1000, leverage=20x):
  Open positions check: BTCUSDT → has existing LONG position → SKIP
  (User C already manually opened BTC long earlier)
```

**14:30 — BTC reaches $102,200 (+4.8%)**
```
checkTakeProfitTargets() fires:
  User A: PnL = ($102,200 - $97,512) / $97,512 × 10x leverage = +48%
  → TP threshold reached → close position
  User B: same logic → close

PositionMonitorService detects:
  openPositions = {} (BTCUSDT gone from monitor account)
  active signal: 507f1f77bcf86cd799439011 (BTCUSDT LONG)
  → resolveActiveSignal('BTCUSDT', 'POSITION_CLOSED', 102200)
```

**MongoDB updated:**
```json
{
  "status": "COMPLETED",
  "closeReason": "POSITION_CLOSED",
  "positionClosedAt": "2026-02-27T14:30:00Z",
  "exitPrice": 102200,
  "pnlPercent": 4.82
}
```

**Redis cleared:**
```
DEL cache:ai-signal:active:BTCUSDT
```

**No queued signal → nothing more happens for BTCUSDT until AI generates next signal.**

---

### Scenario B — Queue Flow (ETHUSDT: LONG then OPPOSITE SHORT)

**Context**: Tuesday 10:00. ETH in momentum up-move.

```
10:00  ETHUSDT shortlist. AI params: RSI_CROSS, 15m, rsiThreshold=50

10:15  RSI(14) crosses above RSI-EMA(9) while RSI < 50 → LONG signal
       Entry: $3,420, SL: $3,319 (-2.95%)

       SignalQueue: no active signal → ACTIVE → execute

MongoDB: {symbol:'ETHUSDT', direction:'LONG', status:'ACTIVE',
          entryPrice: 3420, stopLossPrice: 3319}
Redis:   cache:ai-signal:active:ETHUSDT = <signal_id_1>

Telegram: "📈 ETHUSDT LONG at $3,420"

10:30  ETH pumps to $3,520 (+2.9%)
       Users' TP not hit yet (set at 5% = $3,591)

11:45  RSI on 15m reaches 74.2 (overbought after pump)

       Rule engine fires: evalRsiZone()
       RSI = 74.2 > rsiTop(70) → SHORT signal
       HTF 1h RSI = 68.1 < RSI-EMA(71.2) → PASS (bearish HTF)
       Entry: $3,510, SL: $3,615 (+3.0%)

       SignalQueue.handleNewSignal():
         MongoDB find active for ETHUSDT → {direction: 'LONG', status: 'ACTIVE'}
         isSameDirection? (SHORT vs LONG) → NO → opposite direction
         existing QUEUED? → null → no replace needed
         → save as QUEUED, expiresAt = now + 4h
```

**MongoDB new record:**
```json
{
  "_id": "507f1f77bcf86cd799439022",
  "symbol": "ETHUSDT",
  "direction": "SHORT",
  "entryPrice": 3510,
  "stopLossPrice": 3615,
  "status": "QUEUED",
  "expiresAt": "2026-02-27T15:45:00Z"
}
```

**Redis:**
```
cache:ai-signal:active:ETHUSDT  = <signal_id_1>  (LONG, unchanged)
cache:ai-signal:queued:ETHUSDT  = "507f1f77bcf86cd799439022"
```

**Telegram notification:**
```
📋 AI Signal — Xếp hàng chờ

📉 ETHUSDT SHORT at $3,510
└ Đang chờ lệnh LONG hiện tại đóng

⏰ Hết hạn lúc: 15:45 (4 giờ)
```

**12:30 — New SHORT signal arrives again (stronger RSI overbought)**
```
evalRsiZone(): RSI = 77.8 > 70 → SHORT at $3,545, SL = $3,652

SignalQueue.handleNewSignal():
  Active = LONG (still open)
  Opposite direction → check existing QUEUED
  QUEUED exists (id: 022) → cancel it (REPLACED_BY_NEW)
  Save new QUEUED signal at $3,545

MongoDB:
  id:022 → status: 'CANCELLED', closeReason: 'REPLACED_BY_NEW'
  id:033 → status: 'QUEUED', entryPrice: 3545, expiresAt: now+4h

Telegram:
  "🔄 ETHUSDT SHORT cập nhật
   Short cũ ($3,510) đã được thay thế bởi SHORT mới tại $3,545"
```

**13:15 — ETH hits TP at $3,591 (+5%)**
```
checkTakeProfitTargets() → all users close LONG positions

PositionMonitorService (13:15:30 run):
  openPositions = {} (ETHUSDT gone)
  active signal = LONG (id:001)
  → resolveActiveSignal('ETHUSDT', 'POSITION_CLOSED', 3591)

  MongoDB id:001: status=COMPLETED, exitPrice=3591, pnlPercent=+5.0%

  → activateQueuedSignal('ETHUSDT')
    queued id:033 (SHORT at 3545) — is it expired? 13:15 < 17:30 (expiresAt) → VALID
    → update id:033: status=ACTIVE, executedAt=now
    → Redis: cache:ai-signal:active:ETHUSDT = id:033
    → Redis: DEL cache:ai-signal:queued:ETHUSDT
    → broadcastSignal(id:033) → handleIncomingSignal()
```

**Auto-executed Telegram message:**
```
✅ ETHUSDT LONG đã đóng
└ Entry: $3,420 → Exit: $3,591 (+5.0%)

⚡ Tự động kích hoạt lệnh chờ:

📉 ETHUSDT SHORT at $3,545
├ Bot: AI1  ├ SL: $3,652 (+3.0%)
└ Được xếp hàng từ 11:45

🧠 Strategy: RSI_ZONE (RSI overbought 77.8)
```

**Users' Binance positions:**
```
User A: close LONG (profit), open SHORT ETHUSDT at $3,545 (auto from queue)
User B: close LONG (profit), open SHORT ETHUSDT at $3,545
```

---

### Scenario C — Multi-Coin Day (5 Strategies Active Simultaneously)

**Context**: Wednesday, mixed market conditions across different coins.

```
Coin shortlist at 09:00:
  BTCUSDT  — $97,400  — 24h: +2.1%  — vol: $2.1B
  ETHUSDT  — $3,510   — 24h: +1.8%  — vol: $980M
  SOLUSDT  — $182.4   — 24h: +5.2%  — vol: $340M
  BNBUSDT  — $612.3   — 24h: -0.8%  — vol: $290M
  XRPUSDT  — $0.841   — 24h: +3.9%  — vol: $185M

AI regime assessment (Sonnet):
  Global: MIXED (BTC consolidating, alts diverging)
  confidence: 72

Haiku tunes each coin:
  BTCUSDT → RANGE_BOUND  → STOCH_BB_PATTERN (BB narrow 1.8%)
  ETHUSDT → STRONG_TREND → RSI_CROSS (EMA trend bullish)
  SOLUSDT → VOLATILE     → RSI_ZONE  (bbWidth 5.2%, ATR 2.1%)
  BNBUSDT → RANGE_BOUND  → MEAN_REVERT_RSI (near EMA200, RSI=31)
  XRPUSDT → STRONG_TREND → TREND_EMA (fast EMA cross)
```

**09:45 — BNBUSDT fires MEAN_REVERT_RSI LONG**
```
BNBUSDT:
  EMA200(15m) = $612.8, price = $611.9 → within 0.15% (priceRange=0.3% → PASS)
  RSI(14) = 28.3 < longRsi(30) → LONG condition met
  price > EMA200? 611.9 > 612.8 → NO → FAIL

  Wait... let me reconsider. F2 logic: "price > EMA AND RSI < longRsi → LONG"
  611.9 < 612.8 → price BELOW EMA → the oversold scenario

  Actually F2: price above EMA + RSI oversold → mean-reversion
  Since 611.9 < 612.8, this doesn't fire the LONG condition.
  → null

  10:00 candle: price bounces to $614.2 (now ABOVE EMA200 $612.9)
  RSI(14) = 29.1 < 30 → LONG!
  price within priceRange of EMA: |614.2 - 612.9| / 614.2 = 0.21% < 0.3% → PASS

  ✅ BNBUSDT LONG at $614.2, SL = $611.8 (-0.39%... wait that's too tight)

  Actually stopLoss from AI params = 2.0%
  SL = 614.2 × (1 - 0.02) = $601.9

Telegram: "📈 BNBUSDT LONG $614.2 | SL $601.9 (-2.0%) | Strategy: MEAN_REVERT_RSI"
```

**10:15 — SOLUSDT fires RSI_ZONE SHORT**
```
SOLUSDT:
  RSI(14) on 15m = 73.4 > rsiTop(70) → SHORT candidate
  Initial candle: close(183.8) > open(183.2) → GREEN
  → isEnableInitialCandle=true: need RED for SHORT → FAIL

  10:30: RSI = 75.8, current candle RED (close 183.1 < open 183.9)
  Initial candle: RED for SHORT → PASS
  HTF 1h RSI = 68.2 < RSI-EMA(69.4) → bearish HTF → PASS

  ✅ SOLUSDT SHORT at $183.1, SL = $188.6 (+3.0%)

Telegram: "📉 SOLUSDT SHORT $183.1 | SL $188.6 (+3.0%) | Strategy: RSI_ZONE"
```

**10:30 — XRPUSDT fires TREND_EMA LONG**
```
XRP:
  EMA(9) on 15m = $0.8412, EMA(21) = $0.8389
  Previous: EMA(9)=0.8388, EMA(21)=0.8395 → EMA(9) was BELOW EMA(21)
  Now: EMA(9)=0.8412 > EMA(21)=0.8389 → CROSSED ABOVE → LONG!

  Trend gate (4h EMA200=0.8201): price $0.844 > EMA200 $0.8201 → bullish side ✓
  trendRange: |0.844 - 0.8201| / 0.844 = 2.83% < trendRange(5%) → PASS

  ✅ XRPUSDT LONG at $0.8440, SL = $0.8270 (-2.0%)

Telegram: "📈 XRPUSDT LONG $0.8440 | SL $0.8270 | Strategy: TREND_EMA (EMA9×EMA21 15m)"
```

**11:15 — BTCUSDT STOCH_BB_PATTERN fires Stage 1**
```
BTC:
  Candles (15m, last 3):
    c[-3]: open=97100, close=97380 (GREEN)
    c[-2]: open=97380, close=97190 (RED)
    c[-1]: open=97190, close=97420 (GREEN)
  Pattern: GREEN-RED-GREEN → SHORT pattern at upper BB

  BB(20,2): upper=97,650, lower=96,200, middle=96,925
  bbRange = 1,450
  close=97,420, distance from upper = 97,650-97,420 = 230
  priceRange = 230/1450 × 100 = 15.9% ... > rangeCondition1(10%) → FAIL

  11:30 candle: close=97,580 (closer to upper BB)
  Pattern still GREEN-RED-GREEN at c[-1]
  Distance: 97,650-97,580 = 70, pct = 70/1450 = 4.8% < 10% → PASS!

  Stage 1 triggers:
  Redis: cache:ai-signal:state:BTCUSDT:STOCH_BB = {isLong:false, count:1}

  (No signal yet — waiting for Stage 2 stoch cross confirmation)

  11:45: Stoch %D = 72.1 > stochShort(70), %K crosses below %D
  isCrossBelow = TRUE, %D > 70 → PASS
  Distance from upper BB: close=97,490, distance=97,650-97,490=160, pct=11% > rangeCondition2(8%) → FAIL

  12:00: close=97,620, distance=30, pct=2.1% < 8% → PASS
  Stoch %D = 74.2 > 70, isCrossBelow = TRUE → ✅ STAGE 2 PASSES!

  ✅ BTCUSDT SHORT at $97,620, SL = $99,372 (+1.8%)
  Redis: DEL cache:ai-signal:state:BTCUSDT:STOCH_BB

Telegram: "📉 BTCUSDT SHORT $97,620 | SL $99,372 (+1.8%)
           Strategy: STOCH_BB_PATTERN (GREEN-RED-GREEN at upper BB + Stoch cross)"
```

**State at 12:00:**
```
ACTIVE signals:
  BNBUSDT  LONG   $614.2   (since 10:00)
  SOLUSDT  SHORT  $183.1   (since 10:30)
  XRPUSDT  LONG   $0.8440  (since 10:30)
  BTCUSDT  SHORT  $97,620  (since 12:00)

QUEUED: none
```

**14:00 — ETHUSDT RSI_CROSS fires LONG**
```
ETH RSI(14) crosses above RSI-EMA(9) with RSI=44.2 < 50
HTF 1h RSI: 46.1 > RSI-EMA(44.8) → PASS

SignalQueue.handleNewSignal('ETHUSDT', LONG):
  Active ETHUSDT? → null (no active)
  → ACTIVE → execute immediately

✅ ETHUSDT LONG $3,510, SL $3,373 (-3.9%)... actually
SL = 3510 × (1 - 0.018) = $3,447

Telegram: "📈 ETHUSDT LONG $3,510"
```

**Active signals at 14:00:**
```
BTCUSDT SHORT  $97,620  → queue: none
BNBUSDT LONG   $614.2   → queue: none
SOLUSDT SHORT  $183.1   → queue: none
XRPUSDT LONG   $0.8440  → queue: none
ETHUSDT LONG   $3,510   → queue: none
```

---

### Scenario D — Edge Cases

#### D1: Queued Signal Expires (TTL)
```
14:00  SOLUSDT SHORT active ($183.1)
14:15  New SOLUSDT LONG signal → QUEUED (expiresAt: 18:15)
18:00  SOL position still open (no TP/SL hit yet)
18:15  cleanupExpiredQueued() cron fires
       QUEUED signal expiresAt < now → CANCELLED

MongoDB: {status: 'CANCELLED', closeReason: 'TTL_EXPIRED'}
Redis: DEL cache:ai-signal:queued:SOLUSDT

Telegram: "⏰ SOLUSDT LONG (queued) đã hết hạn (4h TTL)
           Tín hiệu không còn hợp lệ với điều kiện thị trường hiện tại."
```

#### D2: AI Failure → Fallback
```
11:00  Haiku API returns 429 (rate limit exceeded)
       AiOptimizerService.tuneParamsForSymbol():
         catch(err) → logger.warn → return getDefaultParams(symbol)

       Default params = F8 Config 2 defaults:
       { strategy: 'RSI_CROSS', rsiPeriod: 14, rsiEmaPeriod: 9,
         rsiThreshold: 50, primaryKline: '15m', ... }

       System continues running with F8 defaults.
       Logged: "[AI] Using default params for XRPUSDT (Haiku unavailable)"

       At 12:00: cache:ai:params:XRPUSDT expires → retry Haiku → success
```

#### D3: Emergency Override (5% price move)
```
15:30  BTCUSDT drops from $97,620 to $92,400 in 12 minutes (-5.4%)

       PriceWatchService detects: priceChange15min > 5%
       → handleEmergencyOverride('BTCUSDT', -5.4)

       1. DEL cache:ai:params:BTCUSDT
       2. DEL cache:ai-signal:state:BTCUSDT:STOCH_BB (stale pattern)
       3. DEL cache:ai-signal:state:BTCUSDT:STOCH_EMA
       4. Haiku called immediately (bypass rate limit)
          Prompt includes: "EMERGENCY: price -5.4% in 15min"
          Response: {regime:'VOLATILE', strategy:'RSI_ZONE', rsiBottom:25, ...}
       5. Run signal check with new params immediately

       If RSI now < 25 → LONG signal fires
       If BTCUSDT SHORT position still active (opened at $97,620):
         → new LONG queued (opposite direction)
         → will execute when SHORT closes (SL hit or manual close)

Telegram: "⚠️ EMERGENCY OVERRIDE
           BTCUSDT giảm 5.4% trong 15 phút
           AI đang phân tích lại... RSI=24.1 (oversold)
           📋 BTCUSDT LONG được xếp hàng chờ SHORT đóng"
```

#### D4: Same Direction Signal (Skip)
```
10:00  ETHUSDT LONG active at $3,510
11:00  New RSI_CROSS LONG signal fires for ETHUSDT

       SignalQueue.handleNewSignal('ETHUSDT', LONG):
         active = {direction:'LONG'}
         isSameDirection? YES → SKIPPED

MongoDB: {status:'SKIPPED', direction:'LONG', entryPrice:3,535}
No Telegram message (silent skip, just log)
```

---

## Part 5: Signal State Machine (Full)

```typescript
// Signal transitions — all paths:

GENERATED → ACTIVE      (no existing active, first signal for coin)
GENERATED → QUEUED      (active exists, opposite direction)
GENERATED → SKIPPED     (active exists, same direction)

ACTIVE    → COMPLETED   (position closed: TP hit / SL hit / manual)
ACTIVE    → COMPLETED   (via resolveActiveSignal())

QUEUED    → ACTIVE      (previous active completed, activateQueuedSignal())
QUEUED    → CANCELLED   (TTL expired in cleanupExpiredQueued() cron)
QUEUED    → CANCELLED   (newer opposite signal replaces it: REPLACED_BY_NEW)
```

---

## Part 6: MongoDB Operations

### Queries Used at Runtime

```typescript
// 1. Find active signal for a coin (called every 30s in handleNewSignal)
await aiSignalModel.findById(
  await redis.get(`cache:ai-signal:active:${symbol}`)
);

// 2. Find expired QUEUED signals (called every 5 min)
await aiSignalModel.find({
  status: 'QUEUED',
  expiresAt: { $lt: new Date() },
});

// 3. Find all active signals for position monitor (every 30s)
await aiSignalModel.find({ status: 'ACTIVE' });

// 4. Performance stats per strategy (for /ai stats command)
await aiSignalModel.aggregate([
  { $match: { status: 'COMPLETED', pnlPercent: { $exists: true } } },
  { $group: {
    _id: '$strategy',
    totalSignals: { $sum: 1 },
    wins: { $sum: { $cond: [{ $gt: ['$pnlPercent', 0] }, 1, 0] } },
    avgPnl: { $avg: '$pnlPercent' },
    avgDurationHours: { $avg: {
      $divide: [
        { $subtract: ['$positionClosedAt', '$executedAt'] },
        3600000
      ]
    }},
  }},
  { $sort: { avgPnl: -1 } },
]);

// 5. Update coin profile after signal resolves
await aiCoinProfileModel.findOneAndUpdate(
  { symbol },
  {
    $inc: {
      [`strategyStats.${strategy}.totalSignals`]: 1,
      [`strategyStats.${strategy}.wins`]: isWin ? 1 : 0,
    },
    $set: { [`strategyStats.${strategy}.lastUsedAt`]: new Date() },
  },
  { upsert: true },
);
```

---

## Part 7: Telegram Commands

```
/ai status
  Shows:
  🔍 AI Signal Status
  ├ Global regime: STRONG_TREND (85%)
  ├ Shortlist: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT (+5)
  │
  ├ ACTIVE (4 signals):
  │   📈 BTCUSDT SHORT  $97,620 → current $96,800 (+0.84%)
  │   📈 ETHUSDT LONG   $3,510  → current $3,580  (+2.0%)
  │   📉 SOLUSDT SHORT  $183.1  → current $178.2  (+2.7%)
  │   📈 XRPUSDT LONG   $0.844  → current $0.881  (+4.4%)
  │
  └ QUEUED (1 signal):
      📋 BNBUSDT LONG $611.8 (expires in 3h 12m)

/ai params BTCUSDT
  Shows AI-tuned params for BTCUSDT:
  ├ Strategy: STOCH_BB_PATTERN
  ├ Regime: RANGE_BOUND (74%)
  ├ Timeframe: 15m | BB(20,2)
  ├ Stoch: K=14, D=3, smoothD=3
  ├ Zones: Long<30, Short>70
  ├ StopLoss: 1.8%
  └ Cached until: 14:25 (38 min)

/ai stats
  📊 AI Signal Performance (last 30 days)
  ├ RSI_ZONE:       12 signals, 75% win, avg +2.4%
  ├ RSI_CROSS:      18 signals, 67% win, avg +1.8%
  ├ TREND_EMA:       8 signals, 62% win, avg +3.1%
  ├ STOCH_BB_PATTERN: 5 signals, 80% win, avg +2.9%
  └ MEAN_REVERT_RSI:  6 signals, 50% win, avg +0.8%
  Total cost: $2.34 / month

/ai override BTCUSDT RSI_CROSS
  Forces RSI_CROSS strategy for BTCUSDT regardless of AI assessment.
  (DEL cache:ai:params:BTCUSDT, set override in Redis for 4h)

/ai pause
  Stop generating new signals (existing positions continue)

/ai resume
  Resume signal generation
```

---

## Part 8: Complete Module Files to Create

### 8.1 `ai-signal.module.ts`
```typescript
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'AiSignal', schema: AiSignalSchema },
      { name: 'AiCoinProfile', schema: AiCoinProfileSchema },
      { name: 'AiRegimeHistory', schema: AiRegimeHistorySchema },
    ]),
    ScheduleModule,
    TelegramModule,  // for handleIncomingSignal() and bot notifications
  ],
  providers: [
    AiSignalService,
    SignalQueueService,
    PositionMonitorService,
    MarketDataService,
    CoinFilterService,
    IndicatorService,
    RuleEngineService,
    AiOptimizerService,
  ],
  exports: [AiSignalService],
})
export class AiSignalModule {}
```

### 8.2 `app.module.ts` — Add AiSignalModule
```typescript
@Module({
  imports: [
    // ... existing modules ...
    MongooseModule.forRoot(process.env.MONGODB_URI),
    AiSignalModule,  // ← add this
  ],
})
export class AppModule {}
```

### 8.3 Environment Variables
```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017/binance-tele-bot

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...
AI_ENABLED=true
AI_MONITOR_TELEGRAM_ID=123456789
AI_SIGNAL_TTL_HOURS=4
AI_MAX_HAIKU_PER_HOUR=30
AI_MAX_SONNET_PER_HOUR=2

# Coin Filter
AI_MIN_COIN_VOLUME_USD=50000000
AI_MIN_PRICE_CHANGE_PCT=3.0
AI_MAX_SHORTLIST_SIZE=10
AI_EMERGENCY_THRESHOLD_PCT=5.0
```

---

## Part 9: Implementation Status (ALL COMPLETE)

All phases have been implemented and are running in production.

```
Phase 0 — Foundation                    [DONE]
  Mongoose schemas, MarketDataService (WebSocket + REST),
  FuturesAnalyticsService, CoinFilterService (composite scoring)

Phase 1 — Signal Loop + Queue           [DONE]
  IndicatorService (RSI, EMA, BB, Stoch, KDJ, ADX),
  RuleEngineService (8 strategies), SignalQueueService,
  AiSignalService (crons: 2m filter, 3m signals)

Phase 2 — All Strategies                [DONE]
  evalTrendEma (+ ADX), evalMeanRevertRsi (+ ADX < 30 + bounce),
  evalStochBbPattern (2-stage), evalStochEmaKdj (2-stage + KDJ),
  evalEmaPullback (NEW), evalBbScalp (NEW)

Phase 3 — AI Optimizer                  [DONE]
  Waterfall: Haiku --> GPT-4o-mini --> GPT-4o --> static defaults,
  preComputeIndicators (~5ms), 7 regime types,
  pipe-delimited strategy fallbacks, 10-min regime cache

Phase 4 — Real Trading                  [DONE]
  UserRealTradingService: MARKET orders, entry tolerance (1%),
  position slot reservation (atomic Redis Lua),
  per-user max positions + daily limits,
  symbol blacklist (XAUUSDT, XAGUSDT, MSTRUSDT)

Phase 5 — Position Monitoring           [DONE]
  Real-time price listeners (~250ms resolution),
  SL-moved-to-entry (break-even), 5% milestone raise,
  TP boost on volume momentum

Phase 6 — Dual Timeframe               [DONE]
  INTRADAY (15m primary, 1h HTF) for BTC/ETH/SOL/BNB/XRP,
  SWING (4h primary, 1d HTF) for all coins,
  profile-aware Redis keys, cross-profile conflict detection

Phase 7 — Safety + Monitoring           [DONE]
  Market cooldown (3 SL --> 30min pause),
  HealthMonitorService (every 10min),
  UserDataStreamService (Binance WebSocket order fills),
  AiSignalStatsService (win rate, PnL analytics)

Phase 8 — Telegram Commands             [DONE]
  15+ /ai commands: on/off, setkeys, settings, leverage,
  target, stoploss, maxpos, vol, balance, tpsl,
  my, signals, rank, daily history, moneyflow,
  status, pause/resume, override
```

---

## Part 10: Cost and Performance Summary

### Daily Operation (10 coins, normal day)
```
Haiku calls:     10 coins × 24 refreshes = 240 calls
                 Each: ~350 in + ~150 out = 500 tokens
                 Cost: 240 × 500 × $0.0008/1K = $0.096/day

Sonnet calls:    6 per day (every 4h)
                 Each: ~250 in + ~100 out = 350 tokens
                 Cost: 6 × 350 × $0.015/1K = $0.032/day

Binance REST:    1 call/5min = 288/day (weight 40 each = 11,520 weight/day)
                 Daily limit: 1,728,000 weight → uses 0.67%

WebSocket:       10 coins × 3 intervals = 30 streams (free)

MongoDB ops:     ~100 reads + ~20 writes/day (minimal)

Total AI cost:   ~$3.84/month
```

### Expected Signal Frequency
```
Per coin:        1–3 signals per day (deduplication with 1h window)
Total signals:   10–20 per day across all coins
Queue events:    2–5 per day (queue created when position still active)
Win rate goal:   65–75% (matching existing F8 performance)
```

### Latency
```
From kline close to signal check:   30–60s (next cron tick)
From signal to handleIncomingSignal: < 100ms
From handleIncomingSignal to order:  < 500ms (Binance API)
Total latency (kline close → order): 30–90 seconds
```

---

## Part 11: Quick Reference Card

```
Files to create (new):
  src/ai-signal/
    ai-signal.module.ts
    ai-signal.service.ts          ← orchestrator, all crons
    signal-queue.service.ts       ← state machine + MongoDB
    position-monitor.service.ts   ← detect position close
    schemas/
      ai-signal.schema.ts
      ai-coin-profile.schema.ts
      ai-regime-history.schema.ts

  src/market-data/
    market-data.module.ts
    market-data.service.ts        ← WebSocket + REST scan

  src/coin-filter/
    coin-filter.module.ts
    coin-filter.service.ts

  src/strategy/
    strategy.module.ts
    indicators/indicator.service.ts
    rules/rule-engine.service.ts
    ai-optimizer/ai-optimizer.service.ts

Files to modify (existing):
  src/app.module.ts               ← add MongooseModule.forRoot + AiSignalModule
  src/telegram/telegram.service.ts ← add BOT_FUTURE_AI_1 to BOT_TYPE_MAP

Dependencies to add (package.json):
  @nestjs/mongoose
  mongoose
  @anthropic-ai/sdk
```
