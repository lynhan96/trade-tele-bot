# Re-entry Safety Simulator

## Overview

This simulator tests the safe re-entry system with 10 different market scenarios to validate that the safety checks work correctly.

## How to Run

```bash
npm run test:simulator
```

Or directly:

```bash
npx ts-node run-simulator.ts
```

## Test Scenarios

### ✅ **Scenario 1: Market Crash Continuing** (SHOULD BLOCK)

- **Setup**: Price dropped 15%, cooldown passed
- **Market**: Strong downtrend, EMA9 < EMA21, high sell volume
- **Expected**: ❌ BLOCK - Market still crashing
- **Reason**: EMA not aligned (trend still down)

### ✅ **Scenario 2: Healthy Pullback** (SHOULD ALLOW)

- **Setup**: Price dropped 18%, cooldown passed
- **Market**: Recovery started, EMA9 > EMA21, strong buy volume
- **Expected**: ✅ ALLOW - Safe to re-enter
- **Checks**: All 4 safety checks pass

### ✅ **Scenario 3: Cooldown Active** (SHOULD BLOCK)

- **Setup**: Good market but closed only 15 mins ago
- **Market**: Healthy recovery signals
- **Expected**: ❌ BLOCK - Wait 30 minutes minimum
- **Reason**: Cooldown period not met

### ✅ **Scenario 4: Price Dropped Too Much** (SHOULD BLOCK)

- **Setup**: Price dropped 30% (beyond 25% limit)
- **Market**: Even with good signals
- **Expected**: ❌ BLOCK - Too risky
- **Reason**: Price change outside 5-25% range

### ✅ **Scenario 5: Price Too Close** (SHOULD BLOCK)

- **Setup**: Price only dropped 3% (below 5% minimum)
- **Market**: Sideways/choppy
- **Expected**: ❌ BLOCK - Not a good re-entry point
- **Reason**: Price change too small

### ✅ **Scenario 6: Weak Bounce** (SHOULD BLOCK)

- **Setup**: Price dropped 12%, slight recovery
- **Market**: Low buy volume (<55%), weak momentum
- **Expected**: ❌ BLOCK - Weak recovery signal
- **Reason**: Volume pressure insufficient OR EMA not strong enough

### ✅ **Scenario 7: Strong Recovery** (SHOULD ALLOW)

- **Setup**: Price dropped 20%, strong recovery
- **Market**: EMA9 >> EMA21, very high buy volume (>60%)
- **Expected**: ✅ ALLOW - Excellent re-entry point
- **Checks**: All 4 safety checks pass

### ❌ **Scenario 8: SHORT Position Pump** (SHOULD BLOCK)

- **Setup**: SHORT closed, price pumped 15%
- **Market**: Still pumping, no reversal
- **Expected**: ❌ BLOCK - Market still going against SHORT
- **Note**: SHORT logic is inverted from LONG

### ❌ **Scenario 9: SHORT Position Reversal** (SHOULD ALLOW)

- **Setup**: SHORT closed, price pumped 18%, reversing
- **Market**: Showing reversal signs (sell volume >55%)
- **Expected**: ✅ ALLOW - Safe to re-enter SHORT
- **Note**: Needs sell pressure for SHORT positions

### ✅ **Scenario 10: Sideways Market** (SHOULD BLOCK)

- **Setup**: Price dropped 10%, choppy action
- **Market**: No clear trend, mixed signals
- **Expected**: ❌ BLOCK - Wait for clear direction
- **Reason**: Volume pressure neutral (~50%)

## Output Explanation

Each scenario shows:

### 📍 INPUT DATA

- Symbol, Side (LONG/SHORT)
- Original entry price
- When position was closed
- Current market price
- Market condition type

### 🔍 SAFETY CHECKS

1. **Cooldown**: Time since close vs 30 min requirement
2. **Price Change**: % move from original entry (need 5-25%)
3. **EMA9**: Fast EMA value
4. **EMA21**: Medium EMA value
5. **Buy Pressure**: % of buy volume vs sell volume

### 📤 OUTPUT

- **Safe to Re-enter**: ✅ YES or ❌ NO
- **Reason**: Why it was blocked (if blocked)

### 🎯 EXPECTED vs ACTUAL

- Shows if test passed or failed
- Compares expected behavior with actual result

## Safety Check Logic

### 1. Cooldown Check (30 minutes)

- Prevents panic re-entry immediately after closing
- Allows market to stabilize

### 2. Price Range Check (5-25%)

- **< 5%**: Too close, not worth re-entry
- **5-25%**: Good range for better entry
- **> 25%**: Too far, market might have structurally changed

### 3. EMA Crossover Check

- **LONG**: EMA9 must be > EMA21 (uptrend confirmed)
- **SHORT**: EMA9 must be < EMA21 (downtrend confirmed)
- Uses 30 candles (7.5 hours) of 15m data

### 4. Volume Pressure Check

- **LONG**: Buy volume must be > 55% (buying interest)
- **SHORT**: Buy volume must be < 45% (selling interest)
- Analyzes last 20 candles (5 hours)

## Market Scenarios Generated

The simulator creates realistic candlestick data for each scenario:

- **CRASH_CONTINUING**: Continuous red candles, EMA9 < EMA21
- **HEALTHY_PULLBACK**: Downtrend followed by strong green candles
- **WEAK_BOUNCE**: Mild recovery with low volume
- **SIDEWAYS**: Choppy price action, no clear direction
- **STRONG_RECOVERY**: Massive recovery rally with high volume

## Customization

To add more scenarios, edit `src/simulator/reentry-safety.simulator.ts`:

1. Add new market scenario in `generateKlines()`
2. Add new test in `runAllTests()`
3. Define expected behavior

## Understanding Results

### ✅ Test PASSED

- Actual behavior matches expected behavior
- Safety logic working correctly

### ❌ Test FAILED

- Actual behavior different from expected
- May need to adjust:
  - Market data generation
  - Safety check thresholds
  - EMA calculation logic

## Success Rate

Current: **60% (6/10 passing)**

Failed tests indicate areas where:

- Market data generation needs improvement
- Safety check logic needs tuning
- SHORT position logic needs refinement

## Notes

- All times are based on system time
- Candles are generated for 15-minute intervals
- EMA calculations use exponential smoothing
- Volume pressure assumes green candle = buy, red candle = sell
