# Trading Logic — Complete Reference

NestJS bot: AI signal scanner + Grid DCA + Auto-Hedge + Real Binance Futures trading.

---

## 1. Signal Generation Pipeline (3 Tiers)

### Tier 1 — preFilter (Early Exit)
Discard coins before any analysis:
- **Blacklist**: skip known bad coins
- **Duplicate**: skip if signal already ACTIVE for this symbol
- **Active cap**: skip if `maxActiveSignals` (12) reached
- **Daily cap**: skip if `maxDailySignals` (15) reached
- **Cooldown**: skip if coin recently closed (30min after SL)
- **Market Guard `pauseAll`**: skip ALL new signals (BTC panic)
- **Direction block**: skip if MarketGuard blocks this direction

### Tier 2 — Strategy + Confluence
1. **tuneParams**: AI optimizer sets regime, confidence, SL/TP per coin
2. **Confidence floor**: regime-aware minimum
   - Base: 65 | Ranging: 65 | Strong Bull: 80
   - Boosted by MarketGuard floor (BTC bear → floor 68)
3. **RuleEngine.evaluate()**: runs ALL 6 strategies, needs **≥2 to agree** on direction
4. **Futures confidence adjustment**: funding rate, L/S ratio, taker flow → ±3 to ±10 points
5. **Main confidence gate**: final `confidence < minConfidenceToTrade` → block

### Tier 2.5 — Direction Filters
- **BTC 4h EMA**: EMA21 < EMA50 → block LONG, EMA21 > EMA50 → block SHORT
- **Coin 4h EMA**: same logic per-coin
- **Price position in 24h range**: above 70% → block LONG, below 30% → block SHORT

### Tier 3 — Risk Score
Weighted score from 4 factors (threshold = 55):

| Factor | Weight | Logic |
|--------|--------|-------|
| Regime | 30% | STRONG_BEAR+LONG=100, BULLISH+SHORT=60, ranging=20 |
| Funding | 20% | Crowded same-side = high risk, extreme > 0.3% = 100 |
| EMA Trend | 25% | 4h EMA21 vs EMA50 spread against direction |
| Market Guard | 25% | Block flags from BTC momentum analysis |

Score > 55 → signal blocked.

---

## 2. Six Strategies

All strategies evaluated every 30s scan. Need **≥2** to confirm same direction (confluence).

| Strategy | Gate | Timeframe | Key Logic |
|----------|------|-----------|-----------|
| RSI_CROSS | 75 | 4h primary | RSI crosses above/below EMA. HTF RSI confirmation on 1d. Candle color alignment |
| EMA_PULLBACK | 78 | 15m primary | Price pulls back to EMA21 support. RSI 35-55 range. 4h HTF confirmation |
| TREND_EMA | 80 | 15m primary | EMA9/21 cross. 4h EMA200 trend gate. RSI exhaustion check. Max 1.5% from cross |
| STOCH_EMA_KDJ | 82 | 15m primary | Stochastic K/D cross at extremes (30/70). EMA21 proximity. Optional KDJ |
| SMC_FVG | 82 | 15m + 1h HTF | Fair Value Gap + Order Block. BOS/CHoCH on 1h. Candle reaction validation |
| OP_ONCHAIN | 65 | Daily OP | Daily open price bias + on-chain score (funding, L/S, taker, OI, sentiment) |

**Gate** = minimum AI confidence required for that strategy to activate.

---

## 3. Market Guard (BTC Momentum)

Runs every scan cycle. Based on BTC 4h candle data + indicators:

| Condition | Action | Threshold |
|-----------|--------|-----------|
| BTC 24h ≤ -8% OR (4h ≤ -4% + below EMA200) | **pauseAll** | Panic mode |
| BTC 4h ≤ -2.5% OR (below EMA200 + RSI < 42) | **blockLong**, floor 68 | Bear mode |
| BTC 4h ≥ +1.5% + above EMA9 | Clear restrictions | Bull mode |
| Ranging + bear score ≥ 4/6 | blockLong | Directional scoring |
| Ranging + bull score ≥ 4/6 | blockShort | Directional scoring |
| 3+ of last 5 trades SL in same direction | Block that direction | Performance guard |
| Both directions blocked | Deadlock resolver: allow weaker with floor 70 | Safety |

---

## 4. Grid DCA

Fixed 4-level dollar-cost averaging. Activates on entry.

| Level | Deviation | Volume % | Notes |
|-------|-----------|----------|-------|
| L0 | 0% (entry) | 40% | Filled immediately, taker fee |
| L1 | -2% | 15% | RSI guard: LONG needs RSI < 45, SHORT needs RSI > 55 |
| L2 | -4% | 15% | Same RSI guard |
| L3 | -6% | 30% | Same RSI guard + sustained momentum check |

- **Cooldown**: 5 min between fills (`gridFillCooldownMin`)
- **On fill**: recalculate weighted average entry, update SL/TP from new avgEntry
- **DCA TP**: always `dcaTpPct` (3.0%) from avgEntry

---

## 5. Trail Stop

Protects profit by moving SL upward as price rises:

| Phase | Trigger | Action |
|-------|---------|--------|
| **Breakeven** | Peak ≥ 2.0% (`trailTrigger`) | SL = entry price (break-even) |
| **Continuous trail** | After breakeven + peak > 2% | SL = entry ± peak × 75% (`trailKeepRatio`) |
| **TP proximity lock** | Within 0.5% of TP | Freeze trail (don't pull away from TP) |
| **TP Boost** | Peak ≥ 2.5% + volume momentum | Extend TP by 2%, cap at 6.0% (`tpBoostCap`) |

Trail SL stays in DB — SIM controls close timing. Real mode uses position-gone detection as safety.

---

## 6. Hedge System — Entry

When main position loses, open opposite direction to recover:

### Entry Conditions
- **Trigger**: main PnL < `-hedgePartialTriggerPct` (default -3%, hard floor -2%)
- **Direction**: opposite of main (main LONG → hedge SHORT)
- **Size**: 75% of main notional (scale to 100% after 7+ consecutive wins)
- **Regime block**: no hedge in SIDEWAYS regime
- **Cooldown**: 5min between cycles (`hedgeReEntryCooldownMin`)

### RSI Guard (Cycle 2+)
First cycle enters immediately. Subsequent cycles require:
- RSI 15m confirmation: hedge LONG needs RSI < 40, hedge SHORT needs RSI > 60
- Relaxed to 45 threshold when deeply negative or fresh drop after 3+ wins
- **Overbought/Oversold guard**: block hedge LONG at RSI > 70, block hedge SHORT at RSI < 30
- **Candle alignment**: at least 1 of last 2 candles must match hedge direction

### Hedge TP (85% of main regime TP)
| Regime | Hedge TP |
|--------|----------|
| STRONG_BULL/BEAR | 3.5% |
| VOLATILE | 4.0% |
| Default | 3.0% |

---

## 7. Hedge System — Exit

Multiple exit paths checked every price tick when hedge is active:

| Exit Method | Condition | Priority |
|-------------|-----------|----------|
| **Recovery close** | Main > 1.0% AND Hedge ≥ 1.5% | Highest — both sides profitable |
| **Trail TP** | Peak ≥ hedge TP, then pullback > 1% from peak | Peak tracking |
| **Early trail** | Peak ≥ 2.0%, keep 70%, close when peak ≥ 2.5% + drops to trail floor | Fast profit lock |
| **Breakeven SL** | Hedge ≥ 2.0% (no trail yet) → SL at +1.0% | Safety net |
| **Protected SL hit** | Hedge drops to 1.0% with SL at +1.0% | Close with min profit |
| **Timeout** | Held > 6h + PnL between 1-2% (sideways) | Avoid stagnation |

### After Hedge Close
- **SL progression**: widen SL by 2% per win (cap 15%), tighten by 3% per loss (floor 5%)
- **Always restore 40% safety SL** on main after hedge closes
- **SL disabled during hedge**: main SL = 0, hedge system manages all risk
- Cycles continue until **NET_POSITIVE** resolves the position

---

## 8. NET_POSITIVE — Combined Exit

Checks if the total position (main + all hedge profits) is net profitable:

**Formula**: `mainUnrealizedPnL + bankedHedgeProfit + currentHedgePnL > 2% of filledVolume`

| Phase | Trigger | Action |
|-------|---------|--------|
| **Trail activation** | Net PnL ≥ 2.0% | Start tracking net peak |
| **Floor lock** | After activation | Lock floor at 0.5% minimum |
| **Close all** | Net drops below floor after trail activated | Close main + hedge together |

NET_POSITIVE closes ALL positions and resolves the signal completely.

---

## 9. FLIP — Hedge Promotion

When main hits TP while hedge is active:

1. Close main with TP profit → bank to hedge history
2. Promote hedge order → new MAIN (`type = FLIP_MAIN`)
3. New grid L0 only (no DCA after flip)
4. New SL = 40% safety, new TP = 3.5%
5. Reset net trail state (prevent stale NET_POSITIVE)
6. Continue monitoring as normal signal

**FLIP overrides NET_POSITIVE** — always prefer FLIP when main TP is hit.

---

## 10. TIME_STOP

Prevents positions from stagnating indefinitely:

- **Trigger**: age ≥ `timeStopHours` (12h) AND PnL > 0
- **If hedge active**: FLIP (promote hedge to new main)
- **If no hedge**: close normally with "TIME_STOP" reason
- **PnL ≤ 0**: HOLD — hedge system handles loss recovery, don't close at loss

---

## 11. SIM ↔ REAL Sync

**Principle**: SIM drives ALL decisions. REAL follows.

| Action | SIM (PositionMonitor) | REAL (UserRealTrading) |
|--------|----------------------|----------------------|
| Entry | Grid DCA L0-L3 calculated | Market order (L0 volume only) |
| TP/SL movement | DB update + propagate | Cancel + re-place Binance algo |
| Trail | DB peak tracking | SIM propagates moves (5s debounce) |
| DCA fills | RSI guard + cooldown | Grid levels filled by real orders |
| Hedge | SIM cycles until NET_POSITIVE | Separate hedge trade (isHedge=true) |
| Close | Signal resolution in queue | Market close on Binance |
| FLIP | Main close + hedge promote | Close main on Binance + DB promote |
| Safety | — | Position-gone detection (1min cron) |

**No SL/TP algo orders on Binance for MAIN**: SIM controls all close timing.
Only `position-gone detection` runs as safety: if Binance position disappears, mark trade as closed.

---

## 12. Configuration Defaults

### SL/TP
| Param | Default | Description |
|-------|---------|-------------|
| slMin | 1.5% | Minimum stop loss |
| slMax | 2.5% | Maximum stop loss |
| tpMin | 3.0% | Minimum take profit |
| tpMax | 3.0% | Maximum take profit (fixed 3%) |
| dcaTpPct | 3.0% | DCA TP from avgEntry |

### Trail
| Param | Default | Description |
|-------|---------|-------------|
| trailTrigger | 2.0% | Activate trail at this profit |
| trailKeepRatio | 0.75 | Keep 75% of peak |
| tpBoostTrigger | 2.5% | Boost TP at this profit |
| tpBoostCap | 6.0% | Max TP after boost |

### Hedge
| Param | Default | Description |
|-------|---------|-------------|
| hedgePartialTriggerPct | 3.0% | Entry trigger (hard floor 2%) |
| hedgeMaxCycles | 100 | Effectively unlimited |
| hedgeCooldownMin | 5 | Minutes between cycles |
| hedgeTrailKeepRatio | 0.70 | Early trail keep 70% |
| hedgeBlockRegimes | ["SIDEWAYS"] | No hedge in these |
| hedgeTpPctDefault | 3.0% | Default hedge TP |
| hedgeTpPctTrend | 3.5% | Trending regime TP |
| hedgeTpPctVolatile | 4.0% | Volatile regime TP |

### Filters
| Param | Default | Description |
|-------|---------|-------------|
| confidenceFloor | 65 | Base confidence threshold |
| maxActiveSignals | 12 | Max concurrent positions |
| maxDailySignals | 15 | Daily cap |
| riskScoreThreshold | 55 | Block if risk > this |
| timeStopHours | 12 | Close stagnant after N hours |

### Grid DCA
| Param | Default | Description |
|-------|---------|-------------|
| gridLevelCount | 4 | Fixed 4 levels |
| gridFillCooldownMin | 5 | Minutes between fills |
| gridRsiLong | 45 | RSI < 45 for LONG DCA |
| gridRsiShort | 55 | RSI > 55 for SHORT DCA |

### Market Guard (BTC)
| Param | Default | Description |
|-------|---------|-------------|
| btcPanic24hPct | -8% | Pause ALL if BTC drops this in 24h |
| btcPanic4hPct | -4% | Pause ALL if BTC drops this in 4h + below EMA200 |
| btcBear4hPct | -2.5% | Block LONG if BTC drops this in 4h |
| btcBearRsi | 42 | Block LONG if below EMA200 + RSI < this |

### Sim Trading
| Param | Default | Description |
|-------|---------|-------------|
| simNotional | $600 | Volume per trade |
| simTakerFeePct | 0.04% | Market order fee |
| simMakerFeePct | 0.02% | Limit order fee |

### Regime SL/TP Overrides
| Regime | SL | TP | Grid |
|--------|----|----|------|
| STRONG_BULL | 1.5-2.5% | 4.0-6.0% | Yes |
| STRONG_BEAR | 1.5-2.5% | 4.0-6.0% | Yes |
| VOLATILE | 2.5-3.5% | 3.0-4.5% | Yes |
| SIDEWAYS | 1.5-2.0% | 1.5-2.5% | No |
| RANGE_BOUND | 1.5-2.0% | 1.5-2.5% | No |

### Strategy Gates (Confidence Thresholds)
| Strategy | Gate |
|----------|------|
| RSI_CROSS | 75 |
| EMA_PULLBACK | 78 |
| TREND_EMA | 80 |
| STOCH_EMA_KDJ | 82 |
| SMC_FVG | 82 |
| OP_ONCHAIN | 65 |
