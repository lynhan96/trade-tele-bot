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

### FLIP Logic
- When main order hits TP while hedge is active
- Close main (take profit)
- Promote hedge direction as new main
- New SL/TP calculated fresh
- After FLIP: no hedge for 30min (new main needs to stabilize)

### Critical Bugs Fixed
1. `stopLossPrice = entry*(1-0%) = entry` → instant SL hit
2. `hedgeEnabled = undefined` in Redis → hedge system silently disabled
3. `gridStep = 0/3 = 0` when SL=0 → tick handler crashed
4. `hedgeTrailActivated` not in schema → Mongoose silently dropped
5. `price < lastExit` blocked re-entry when price bounced 5%+

### Performance Data (as of 2026-03-24)
- Wallet: ~$1,461 (+46% from $1,000)
- WR: 58.7%
- Best hedge: JCT +$100 banked over 8 cycles
- Hedge recovery rate: ~40-85% of main losses
