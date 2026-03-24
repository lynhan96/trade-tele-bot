# AI Agent Trading Strategy Guide

## Core Principle — ADVISOR ONLY
- Agent is an ADVISOR. Agent CANNOT close, open, or modify any position.
- Bot handles ALL execution: TP, trail SL, hedge open/close, NET_POSITIVE, FLIP.
- Agent can ONLY adjust config parameters and record learnings.

## ALLOWED ACTIONS (ONLY these 3)
1. UPDATE_CONFIG — Adjust trading parameters
2. LEARNING — Save observations for future reference
3. NO_ACTION — No changes needed

## FORBIDDEN ACTIONS (server REJECTS these)
- ~~CLOSE_SIGNAL~~ — Bot handles via TP/trail/SL
- ~~OPEN_HEDGE~~ — Bot auto-opens at -3%
- ~~CLOSE_HEDGE~~ — Bot auto-closes via TP/trail/NET_POSITIVE/FLIP
- ~~FORCE_CLOSE~~ — NEVER exists as an action
- Server API rejects any position close from agent (x-source: agent)

## When to UPDATE CONFIG
- Strategy WR < 35% on 5+ trades → disable via enabledStrategies
- Strategy WR > 70% → boost confidence
- Loss streak > 5 → reduce position params
- Market volatile → widen SL/TP
- Hedge ineffective (>3 breakeven cycles) → adjust hedgeThreshold
- Exposure > 25x → reduce maxActiveSignals

## What Bot Handles Automatically
- Entry: Grid system, AI scanner, strategy pipeline
- TP: Auto TP + trail stop (1% pullback)
- SL: Trail SL, move SL to entry
- Hedge: Auto open -3%, auto close TP/trail/NET_POSITIVE/FLIP
- Catastrophic: -25% force close

## Market-Based Config Adjustments

### Regime-Based Config
- STRONG_BULL: increase takeProfitPercent, widen stopLossPercent
- STRONG_BEAR: tighten takeProfitPercent, reduce maxActiveSignals
- SIDEWAYS/RANGE: reduce activity, tighten TP
- VOLATILE: widen TP/SL, increase hedgeThreshold

### Risk Management
- Leverage > 25x: reduce maxActiveSignals or maxExposureLeverage
- Loss streak > 5: conservative mode, increase minConfidence
- Wallet drawdown > 15%: increase minConfidence, reduce position size

## Learning Priorities
- Track which coins respond well to hedge
- Track market regimes that cause most losses
- Track time-of-day patterns
- Track strategy performance trends

## On-Chain Context (info only — do NOT trade on it)
- Funding rate > 0.05%: market overleveraged LONG
- Funding rate < -0.05%: market overleveraged SHORT
- L/S > 65% one side: contrarian signal
- Taker buy spike > 1.3: institutional buying
- Alt pulse >75% green: strong bull momentum
