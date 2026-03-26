---
name: Hedge System V3
description: Complete hedge architecture — SL=0, trail TP, FLIP, no price<lastExit, AI agent managed
type: project
---

## Hedge System V3 (2026-03-24)

### Key Changes from V2
- **SL = 0 from signal creation** (V2 had SL=4%, widened to 10%)
- **Removed `price < lastExit`** check for re-entry (RSI + PnL sufficient)
- **Removed hedge trail stop** — hedge only closes on TP or recovery
- **Added hedge trail TP** — ride beyond 3% TP, close on 1% pullback
- **Breakeven SL** at +0.5% (was +0.1%, caused spam)
- **Cooldown 15min** after breakeven (was 5min)
- **Cycle 1 no momentum check** — instant hedge at -3%

### Entry Logic
```
Cycle 1: PnL ≤ -3% → hedge immediately (no RSI check)
Cycle 2+: PnL ≤ -3% + RSI 15m confirm + cooldown 15min
  LONG main → hedge SHORT: RSI 15m < 40 AND RSI 1h < 45
  SHORT main → hedge LONG: RSI 15m > 60 AND RSI 1h > 55
```

### Exit Logic
```
1. TP hit → trail activated (don't close immediately)
   → Track peak PnL
   → Close when pullback > 1% from peak
2. Main TP hit + hedge active → FLIP (promote hedge as new main)
3. NET_POSITIVE: banked profit > main loss → close all
4. Breakeven SL: after +1.5%, SL moves to +0.5%
5. Catastrophic: -25% → force close everything
```

### Volume
- Fixed 75% of main notional for ALL cycles
- Max 100 cycles (effectively unlimited)
- No hedge SL — hedge rides until TP or recovery

### FLIP Logic (Updated 2026-03-25)
- When main order hits TP while hedge is active → **FLIP**
- Close main orders (take profit), bank PnL into hedgeHistory as FLIP_TP entry
- Promote hedge order as new MAIN (type changes HEDGE→MAIN)
- **Volume preserved**: L0 = full hedge vol (e.g. 750), simNotional stays original (1000)
- New SL = 40%, TP = 3.5% from hedge entry price
- `executedAt` reset to FLIP time (correct funding fee calc)
- Grid reinitialized: L0 filled + 1 DCA level for remaining vol
- **Safety net**: if `hedgeActive=false` but OPEN HEDGE order in DB → force FLIP (desync protection)
- `hedgeManager.cleanupSignal()` called → clears cooldown, peak, banked maps
- `hedgeCycleCount` reset to 0 → fresh 7 hedge cycles for flipped position
- `resolvingSymbols` guard prevents duplicate FLIP from concurrent price events
- hedgeHistory preserved across FLIPs (cumulative profit tracking)
- After FLIP: hedge can re-enter at -3% immediately (cooldown cleared)

### What Agent Should Monitor Post-FLIP
- FLIP_TP entries in hedgeHistory (direction shows which main was closed)
- Post-FLIP position is essentially new — track performance separately
- Wide grid spacing after FLIP (13.3% = SL/3) means DCA fills only on big moves
- If flipped position keeps losing → NET_POSITIVE may close if banked > loss

### Critical Bugs Fixed (2026-03-25)
1. `stopLossPrice = entry*(1-0%) = entry` → instant SL hit
2. `hedgeEnabled = undefined` in Redis → hedge system silently disabled
3. `gridStep = 0/3 = 0` when SL=0 → tick handler crashed
4. `hedgeTrailActivated` not in schema → Mongoose silently dropped
5. `price < lastExit` blocked re-entry when price bounced 5%+
6. **FLIP desync**: `hedgeActive=false` but HEDGE order OPEN → force FLIP via DB check
7. **FLIP race condition**: concurrent price events created duplicate FLIP_TP → `resolvingSymbols` guard
8. **FLIP vol loss**: DCA grid recreated with 40% of hedge vol → now preserves full hedge vol as L0
9. **FLIP funding fees**: `executedAt` not reset → overstated fees by hours/days
10. **FLIP stale maps**: hedge manager cooldown/peak not cleared → blocked new hedges
11. **handleHedgeClose cycleNumber desync**: query too strict → orphan HEDGE orders (root cause of #6)
12. **Grid fill race with FLIP**: concurrent async ticks corrupt grid state → skip grid when resolving

### Performance Data (as of 2026-03-25)
- Wallet: ~$1,597 (+60% from $1,000)
- WR: 68.9%
- Best hedge: JCT +$100 banked over 8 cycles
- Hedge recovery rate: ~40-85% of main losses
- IRYSUSDT: 10 hedge SHORT cycles (+$128 banked) → FLIP to SHORT main
