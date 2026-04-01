# Trading System — Complete Reference (SIM + REAL)

## Overview

NestJS monolith: AI signal scanner → Grid DCA → Auto-Hedge → Real Binance Futures.
SIM drives all decisions. REAL follows via market orders.

---

## 1. Signal Lifecycle

### 1.1 Creation: processCoin() — every 30s

```
200 coins shortlisted (volume ≥ $5M, change ≥ 0.1%)
  → Tier 1: preFilter (blacklist, active cap, daily cap, cooldown, market guard)
  → Tier 2: Strategy + Confluence (6 strategies, need ≥2 agree)
  → Tier 2.5: Direction Filters (BTC EMA, coin EMA, price position)
  → Tier 3: Risk Score (4 factors, threshold 55)
  → Signal created → Queue
```

### 1.2 Queue: handleNewSignal()

```
Check Redis ACTIVE_KEY for symbol:
├─ ACTIVE exists, same direction → SKIP
├─ ACTIVE exists, opposite direction → QUEUE (wait for close)
└─ No active signal:
   ├─ Save to MongoDB: status = "ACTIVE"
   ├─ Set Redis ACTIVE_KEY (no expiry)
   ├─ Create MAIN Order (L0 = 40% notional)
   ├─ Initialize Grid: L0 FILLED, L1-L3 PENDING
   └─ Register price listener in PositionMonitor
```

### 1.3 Resolution: resolveActiveSignal()

Close reasons: `TAKE_PROFIT`, `STOP_LOSS`, `TRAIL_STOP`, `NET_POSITIVE`, `TIME_STOP`, `MANUAL`

```
1. Update signal status → COMPLETED
2. Calculate PnL (grid-weighted USDT)
3. Fire resolveCallback → AiSignalService
4. Close real positions for all subscribers
5. Promote queued signal if exists
```

---

## 2. SIM Trading — Price Tick Flow

**handlePriceTick(signal, price)** — fires on every WebSocket price update.

### 2.1 Grid DCA

**Fixed 4 levels** (from `constants.ts`):
```
L0: 0% deviation, 40% volume — FILLED at entry
L1: 2% deviation, 15% volume — PENDING, RSI < 48 (LONG) / > 52 (SHORT)
L2: 4% deviation, 15% volume — PENDING, same RSI guard
L3: 6% deviation, 30% volume — PENDING, RSI + sustained momentum
```

**On each tick for PENDING grids:**
```
triggerPrice = entryPrice × (1 ± deviation%)

if price hits triggerPrice:
  if lastFill < 5min ago → skip (cooldown)
  if RSI not OK → skip
  
  FILL grid:
    avgEntry = volume-weighted average of all filled grids
    Update MAIN order: new entryPrice, notional, quantity
    
    if hedgeActive:
      SL = 0 (disabled)
    else:
      SL = avgEntry × (1 ± max(hedgeTrigger+1%, 2.5%))
    
    TP = avgEntry × (1 ± dcaTpPct) = avgEntry ± 3.0%
```

### 2.2 Trail Stop

```
Peak PnL tracked on every tick.

Phase 1 — Breakeven (peak ≥ 2.0%):
  SL → entry price (break-even)
  slMovedToEntry = true
  Propagate to Binance (5s debounce)

Phase 2 — Continuous Trail (after breakeven, peak > 2%):
  if NOT within 0.5% of TP:
    trailSL = entry ± (peak × 75%)
    DB only (SIM controls close)

Phase 3 — TP Boost (peak ≥ 2.5%):
  if volume momentum detected:
    TP extended by 2%, cap at 6.0%
    Propagate to Binance
```

### 2.3 Hedge Entry

```
pnlPct = (price - avgEntry) / avgEntry × 100

if pnlPct < -hedgeTriggerPct (default -3%, floor -2%):
  
  Cycle 1 (first hedge):
    Open immediately, no RSI check
  
  Cycle 2+ (re-entry):
    RSI 15m confirmation required:
      hedge LONG: RSI < 40 (relaxed to 45 if deep loss)
      hedge SHORT: RSI > 60
    Overbought guard: block LONG hedge at RSI > 70
    Oversold guard: block SHORT hedge at RSI < 30
    Candle alignment: 1 of last 2 candles must match direction
  
  Open hedge:
    Direction: opposite of main
    Size: 75% of main notional (100% after 7+ consecutive wins)
    TP = 85% of regime TP:
      STRONG_BULL/BEAR: 3.5%
      VOLATILE: 4.0%
      Default: 3.0%
    
    SL on main → DISABLED (set to 0)
    Hedge cycles indefinitely until NET_POSITIVE > 2%
```

### 2.4 Hedge Exit

```
Every tick when hedgeActive:

1. Recovery Close (highest priority):
   main PnL > 1.0% AND hedge PnL ≥ 1.5%
   → Close hedge with profit

2. Trail TP:
   Track peak hedge PnL
   if pullback > 1% from peak → close
   Early trail: activate at +2%, keep 70%
   if peak ≥ 2.5% and drops to trail floor → close

3. Breakeven SL:
   hedge ≥ 2.0% (no trail yet) → SL at +1.0%
   if drops to 1.0% → close with min profit

4. Timeout:
   held > 6h + PnL between 1-2% → close (avoid stagnation)

After hedge close:
  Widen main SL by 2% per win (cap 15%)
  Tighten by 3% per loss (floor 5%)
  Always restore 40% safety SL
```

### 2.5 NET_POSITIVE

```
netPnlUsdt = mainUnrealized + bankedHedgeProfit + currentHedgePnL
netPnlPct = (netPnlUsdt / filledVolume) × 100

Trail activation: netPnlPct ≥ 2.0%
Floor lock: 0.5% minimum
Close all: when net drops below floor after trail activated

Closes BOTH main + hedge → signal resolved.
```

### 2.6 FLIP

```
When main TP hit + hedge active:
  1. Close main with TP profit → bank to history
  2. Promote hedge → new MAIN (type = FLIP_MAIN)
  3. New grid L0 only (no DCA after flip)
  4. New SL = 40% safety, new TP = 3.5%
  5. Reset net trail state

FLIP overrides NET_POSITIVE.
```

### 2.7 TIME_STOP

```
if signal age ≥ 12h AND pnlPct > 0:
  if hedgeActive → FLIP
  else → close normally ("TIME_STOP")

pnlPct ≤ 0 → HOLD (hedge handles recovery)
```

### 2.8 SL/TP Hit

```
Fresh MAIN order loaded from DB each tick.

TP hit (LONG: price ≥ tpPrice, SHORT: price ≤ tpPrice):
  if hedgeActive → FLIP
  else → close with TAKE_PROFIT

SL hit (LONG: price ≤ slPrice, SHORT: price ≥ slPrice):
  Close with STOP_LOSS
  Track SL hit for market cooldown
```

---

## 3. REAL Trading Flow

### 3.1 Signal → Real Order: onSignalActivated()

```
For each real-mode subscriber:
  Pre-checks:
    ✓ Not TradFi blacklisted (XAU, XAG, MSTR)
    ✓ Symbol not closed for maintenance
    ✓ Current price within 3% of signal entry
    ✓ No existing OPEN trade same symbol+direction
    ✓ Position slot available (max from config)
  
  Place market order on Binance:
    volume = fullVol × 40% (grid L0) or fullVol (no grid)
    quantity = volume / currentPrice
    leverage = from user settings or AI-tuned
    
    NO SL/TP algo orders on Binance for MAIN
    (SIM controls all close timing)
    
  Save UserTrade to MongoDB:
    entryPrice, quantity, leverage, notionalUsdt
    gridLevels (if grid enabled)
    aiSignalId → links to SIM signal
```

### 3.2 SIM → REAL Propagation

```
SL move (breakeven):
  SIM updates DB → propagateSlMove() → 5s debounce
  → Cancel old Binance SL algo → Place new SL algo
  
TP move (boost):
  SIM updates DB → propagateTpMove() → 5s debounce
  → Cancel old Binance TP algo → Place new TP algo

Hedge open:
  SIM opens hedge in DB → realHedgeCallback()
  → Place market order on Binance (opposite direction)
  → Place TP algo on Binance for hedge (to catch spikes)

Hedge close:
  SIM closes hedge in DB → closeRealHedge()
  → Close hedge position on Binance (market order)
  → Cancel hedge TP algo
```

### 3.3 Binance → DB: onTradeClose()

```
Binance ORDER_TRADE_UPDATE (FILLED, reduce-only):
  ├─ Derive closedDirection: BUY → SHORT closed, SELL → LONG closed
  ├─ Find OPEN trade matching symbol + direction
  ├─ Calculate PnL from gridAvgEntry
  ├─ Atomic update: status → CLOSED (prevent duplicate)
  ├─ Cancel remaining SL/TP algo orders
  └─ Notify user via Telegram
```

### 3.4 FLIP in Real Mode

```
closeRealPosition() with hedge active:
  1. Close main on Binance (market order)
  2. Calculate main PnL, update DB
  3. Promote hedge trade:
     isHedge → false
     New SL = entry × 0.60 (LONG) / 1.40 (SHORT)
     New TP = entry × 1.035 (LONG) / 0.965 (SHORT)
  4. Place new SL/TP algos on Binance
```

### 3.5 Safety Nets

```
protectOpenTrades() — every 1 min:
  For each user with OPEN trades:
    Fetch Binance positions
    If position gone on Binance but OPEN in DB:
      → Mark CLOSED with "BINANCE_CLOSED"
      → Calculate PnL from last fill price
      → Notify user

checkOrphanHedges() — every 1 min @ :30s:
  For trades whose signal is no longer ACTIVE:
    Run hedge check directly against Binance position
    Open/close hedge as needed
    
Sync grace: 60min protection for manually synced positions
  User-initiated closes bypass grace period
```

---

## 4. Market Guard (BTC Momentum)

```
Every scan cycle, evaluate BTC 4h candles:

PANIC (pauseAll):
  BTC 24h ≤ -8% OR (4h ≤ -4% + below EMA200)
  → Block ALL new signals

BEAR (blockLong):
  BTC 4h ≤ -2.5% OR (below EMA200 + RSI < 42)
  → Block LONG, confidence floor → 68

BULL (clear):
  BTC 4h ≥ +1.5% + above EMA9
  → Lift restrictions

Ranging market:
  Bear score ≥ 4/6 → blockLong
  Bull score ≥ 4/6 → blockShort
  3/6 → floor 68
  else → floor 65

Performance guard:
  3+ of last 5 SLs in same direction → block that direction
  Both blocked → deadlock resolver (allow weaker with floor 70)
```

---

## 5. Risk Score (4 Factors)

| Factor | Weight | Score 0 = safe, 100 = dangerous |
|--------|--------|------|
| Regime | 30% | STRONG_BEAR+LONG=100, ranging=20, aligned=0 |
| Funding | 20% | Extreme > 0.3% = 100, crowded same-side = proportional |
| EMA Trend | 25% | 4h EMA21 vs EMA50 spread against direction |
| Market Guard | 25% | Block flags from BTC momentum |

**Total > 55 → signal blocked.**

---

## 6. Six Strategies

| Strategy | Gate | Timeframe | Key Logic |
|----------|------|-----------|-----------|
| RSI_CROSS | 75 | 4h | RSI crosses EMA. HTF RSI on 1d. Candle alignment |
| EMA_PULLBACK | 78 | 15m | Pull to EMA21 support. RSI 35-55. 4h HTF gate |
| TREND_EMA | 80 | 15m | EMA9/21 cross. EMA200 trend gate. Max 1.5% from cross |
| STOCH_EMA_KDJ | 82 | 15m | Stochastic at extremes. EMA21 proximity |
| SMC_FVG | 82 | 15m+1h | Fair Value Gap + Order Block. BOS/CHoCH on 1h |
| OP_ONCHAIN | 65 | Daily | Open price bias + on-chain score |

**Confluence: ≥2 strategies must agree on direction.**

---

## 7. Configuration Defaults

### Core Trading
| Param | Default | Description |
|-------|---------|-------------|
| slMin/slMax | 1.5-2.5% | Stop loss range |
| tpMin/tpMax | 3.0-3.0% | Take profit (fixed 3%) |
| dcaTpPct | 3.0% | DCA TP from avgEntry |
| trailTrigger | 2.0% | Activate trail |
| trailKeepRatio | 0.75 | Keep 75% of peak |
| tpBoostCap | 6.0% | Max TP after boost |
| confidenceFloor | 65 | Base confidence |
| maxActiveSignals | 12 | Max concurrent positions |
| riskScoreThreshold | 55 | Risk score block |
| timeStopHours | 12 | Close stagnant signals |
| simNotional | $600 | Volume per trade |

### Hedge
| Param | Default | Description |
|-------|---------|-------------|
| hedgePartialTriggerPct | 3.0% | Entry trigger (floor 2%) |
| hedgeMaxCycles | 100 | Effectively unlimited |
| hedgeCooldownMin | 5 | Between cycles |
| hedgeTrailKeepRatio | 0.70 | Keep 70% of peak |
| hedgeTpPctDefault | 3.0% | Default hedge TP |
| hedgeBlockRegimes | ["SIDEWAYS"] | No hedge |

### Regime SL/TP Overrides
| Regime | SL | TP | Grid |
|--------|----|----|------|
| STRONG_BULL | 1.5-2.5% | 4.0-6.0% | Yes |
| STRONG_BEAR | 1.5-2.5% | 4.0-6.0% | Yes |
| VOLATILE | 2.5-3.5% | 3.0-4.5% | Yes |
| SIDEWAYS | 1.5-2.0% | 1.5-2.5% | No |

---

## 8. Key Architecture Patterns

1. **SIM controls REAL** — SIM fires all decisions, REAL follows via market orders
2. **No SL/TP on Binance for MAIN** — Only position-gone detection as safety
3. **HEDGE trades get TP on Binance** — Catch price spikes while SIM cycles
4. **Order cache 5s TTL** — Reduces DB queries from 500+/s to ~5/s
5. **Direction matching on close** — Prevents hedge close from closing main
6. **Atomic DB updates** — findOneAndUpdate with status guard prevents race conditions
7. **Per-signal concurrency lock** — Prevents duplicate hedge opens
8. **Grid persistence in Order model** — Survives restarts
9. **Dual-timeframe coins** — BTC, ETH, SOL, BNB, XRP run INTRADAY + SWING
