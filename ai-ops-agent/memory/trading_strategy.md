# AI Agent Trading Strategy Guide

## Core Principle
- NEVER close losing positions. Hedge covers losses.
- ONLY close winning positions to lock profit.
- Use hedge to protect losing positions.

## When to OPEN HEDGE (OPEN_HEDGE)
- Signal losing > -3% AND no hedge active
- On-chain shows continuation against main direction
- Multiple signals in same direction (portfolio risk)
- Market regime changed against position direction

## When to CLOSE HEDGE (CLOSE_HEDGE)  
- ONLY when hedge PnL > 0 (profitable)
- Main position recovering (main PnL improving)
- On-chain shows reversal back to main direction
- Bank hedge profit, keep main running

## When to CLOSE SIGNAL (CLOSE_SIGNAL)
- ONLY when main PnL > 0 (winning)
- PnL > +3% and on-chain shows reversal risk
- PnL > +5% regardless (lock profit)
- Trail TP pattern: let winners run, cut on pullback

## When to UPDATE CONFIG
- Strategy WR < 35% on 5+ trades → disable
- Strategy WR > 70% → boost confidence
- Loss streak > 5 → reduce position params
- Market volatile → widen SL/TP

## Hedge Strategy
1. Main losing > -3% → open hedge (opposite direction)
2. Hedge profitable → trail, bank profit on pullback
3. Main recovering → close hedge, keep main
4. Main TP hit + hedge active → FLIP (system handles)
5. Banked > main loss → NET_POSITIVE (system handles)
6. Cycle: hedge TP → bank → re-enter if still losing

## Learning Priorities
- Track which coins respond well to hedge
- Track market regimes that cause most losses
- Track time-of-day patterns
- Track strategy performance trends


## Market-Based Decision Rules

### Regime-Based
- STRONG_BULL: favor LONG, be cautious with SHORT hedge closes
- STRONG_BEAR: favor SHORT, consider opening hedge earlier for LONGs
- SIDEWAYS/RANGE: reduce activity, only close clear winners
- VOLATILE: widen TP expectations, hedge more aggressively

### BTC Correlation
- BTC dropping > -2% in 4h: ALL LONG positions at risk, open hedges preemptively
- BTC pumping > +3% in 4h: LONG positions likely recovering, consider closing profitable hedges
- BTC sideways: individual coin analysis matters more

### On-Chain Signals
- Funding rate > 0.05%: market overleveraged LONG, SHORT bias, protect LONGs
- Funding rate < -0.05%: market overleveraged SHORT, LONG bias, protect SHORTs
- L/S > 65% one side: contrarian signal, crowd likely wrong
- Taker buy spike > 1.3: institutional buying, bullish
- Taker sell spike < 0.7: institutional selling, bearish

### Alt Pulse
- >75% alts green 4h: strong bull momentum, let LONGs run
- <30% alts green 4h: bearish, protect LONGs with hedges
- 40-60%: neutral, rely on individual coin analysis

### Risk Management
- Leverage > 25x: reduce exposure
- Loss streak > 5: conservative mode
- Wallet drawdown > 15%: only close winners, no new actions
