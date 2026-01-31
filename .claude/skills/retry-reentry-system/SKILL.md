---
name: retry-reentry-system
description: Understanding the automated retry/re-entry system for positions. Use when asked about retry logic, re-entry mechanism, stop loss protection, volume reduction, or how the bot handles position re-opening after TP.
---

# Retry & Re-entry System

## Purpose

Automatically re-opens positions when the price returns to the original entry level after Take Profit is reached, allowing traders to capture additional profits from price oscillations while protecting already-secured gains.

## How It Works

### 1. User Configuration

Users enable retry with `/setretry` command:

```
/setretry 5 15
```

Parameters:

- Max retries: 1-10 (how many times to re-enter)
- Volume reduction: 1-50% (reduce position size each retry)

**Storage:** `user:{telegramId}:retry:{exchange}`

### 2. TP Reached - Store Re-entry Data

**Trigger:** Every 30 seconds by `checkTakeProfitTargets()` cron job

**Process:**

1. Check if unrealized PnL >= target profit
2. **Filter positions with PnL > 0 AND profit > 2%**
3. For each profitable position:
   - Calculate next position quantity (with volume reduction)
   - Calculate profit-protected stop loss
   - Store re-entry data in Redis
4. Close profitable positions
5. Notify user with profit details

**Position Filtering Logic:**

```typescript
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  // Calculate profit percentage from entry
  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Must have > 2% profit
});
```

**Why 2% Minimum?**

- Filters out small price fluctuations
- Ensures meaningful profit before closing
- Reduces unnecessary re-entries
- Covers trading fees and slippage

**Stop Loss Calculation (Risk-Equals-Reward):**

```typescript
// Example: BTC LONG
// Position A: Entry $100, Qty 1 BTC, TP at $110 → Profit $10
// Position B: Entry $100, Qty 0.85 BTC (15% reduction)

const potentialNextProfit = ($110 - $100) × 0.85 = $8.50
const profitPerUnit = $8.50 / 0.85 = $10
const stopLoss = $100 - $10 = $90

// Result:
// - If SL hits: Loss = -$8.50, Net = $10 - $8.50 = $1.50 ✅
// - If TP hits: Profit = +$8.50, Total = $10 + $8.50 = $18.50 🎯
```

**Storage:** `user:{telegramId}:reentry:{exchange}:{symbol}`

### 3. Price Monitoring

**Trigger:** Every 15 seconds by `checkReentryOpportunities()` cron job

**Process:**

1. Get all pending re-entries from Redis
2. For each re-entry:
   - Fetch current market price
   - Check if within ±0.5% tolerance of original entry
   - If yes → Execute re-entry

**Tolerance Logic:**

- $100 entry → re-enter between $99.50-$100.50
- $50,000 entry → re-enter between $49,750-$50,250

### 4. Execute Re-entry

**Automated Actions:**

1. **Open Position**
   - Symbol, side, quantity, leverage from stored data
2. **Set Stop Loss on Exchange** ⭐
   - Uses pre-calculated profit-protected price
   - Ensures minimum profit = potential next profit
3. **Set Take Profit on Exchange** ⭐
   - Same TP percentage as original position
   - Allows position to reach target again

4. **Update Re-entry Data**
   - Reduce quantity for next retry
   - Decrement remaining retries
   - If no retries left → clean up Redis data

5. **Notify User**
   - Show entry price, quantity, volume reduction
   - Display SL and TP levels
   - Show remaining retries

## Key Features

### ✅ Only Close Profitable Positions (> 2%)

When TP target is reached, positions must meet both criteria:

1. **PnL > 0** (profitable in dollar terms)
2. **Profit > 2%** (minimum 2% gain from entry price)

**Filtering Logic:**

```typescript
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Must have > 2% profit
});
```

**Why 2% Minimum?**

- Filters out small price fluctuations
- Ensures meaningful profit before closing
- Reduces unnecessary re-entries
- Covers trading fees and slippage

**Example Scenarios:**

**Position A - BTC LONG:**

- Entry: $100, Current: $101.50
- Profit: 1.5% → **NOT closed** ❌ (below 2% threshold)

**Position B - ETH LONG:**

- Entry: $3000, Current: $3070
- Profit: 2.33% → **Closed, re-entry enabled** ✅

**Position C - SOL SHORT:**

- Entry: $100, Current: $98
- Profit: 2% → **NOT closed** ❌ (exactly 2%, needs > 2%)

**Position D - BTC LONG:**

- Entry: $50000, Current: $51500
- Profit: 3% → **Closed, re-entry enabled** ✅

**Mixed Portfolio:**

- BTC: +1.8% → Left open ❌
- ETH: +5.2% → Closed ✅, re-entry enabled
- SOL: -2.1% → Left open ❌
- AVAX: +3.7% → Closed ✅, re-entry enabled

Result: 2 positions closed, 2 left open

### ✅ Profit-Protected Stop Loss

Stop loss ensures you always secure a minimum profit:

```
Net Secured Profit = Original Profit - Potential Next Profit

Example:
- Original: $10 profit
- Next position can make: $8.50
- Minimum secured: $10 - $8.50 = $1.50
```

**Calculation:**

```typescript
const potentialNextProfit = Math.abs(tpPrice - entryPrice) × nextQuantity;
const profitPerUnit = potentialNextProfit / nextQuantity;
const stopLoss = isLong
  ? entryPrice - profitPerUnit
  : entryPrice + profitPerUnit;
```

### ✅ Automatic Exchange Orders

**Both SL and TP are set on the exchange:**

- No manual intervention needed
- Orders execute even if bot is offline
- Exchange handles execution timing
- User can see orders in exchange UI

### ✅ Volume Reduction

Each retry reduces position size:

| Retry | Reduction | Quantity | Example (1 BTC) |
| ----- | --------- | -------- | --------------- |
| 0     | 0%        | 1.0000   | 1.0000 BTC      |
| 1     | 15%       | 0.8500   | 0.8500 BTC      |
| 2     | 15%       | 0.7225   | 0.7225 BTC      |
| 3     | 15%       | 0.6141   | 0.6141 BTC      |
| 4     | 15%       | 0.5220   | 0.5220 BTC      |
| 5     | 15%       | 0.4437   | 0.4437 BTC      |

**Formula:** `nextQuantity = currentQuantity × (1 - volumeReduction / 100)`

## Commands

### Enable Retry

```
/setretry <max_retries> <volume_reduction_percent>

Examples:
/setretry 3 20    - 3 retries, 20% reduction each time
/setretry 5 15    - 5 retries, 15% reduction (default)
```

### Clear Retry

```
/clearretry

Disables retry system and removes all pending re-entries
```

## Data Flow

```
TP Reached → Filter Profitable → Calculate SL → Store Data → Close Positions
                                                                    ↓
                                                            Notify User
                                                                    ↓
Price Monitor (15s) → Check Tolerance → Within Range?
                                              ↓ YES
                                        Execute Re-entry
                                              ↓
                                    Open Position + Set SL + Set TP
                                              ↓
                                        Update Data → Notify User
                                              ↓
                                    Retry Again? → YES → Loop
                                              ↓ NO
                                        Clean Up Redis
```

## Redis Keys

```
user:{telegramId}:retry:{exchange}
→ Stores: maxRetry, currentRetryCount, volumeReductionPercent, enabled

user:{telegramId}:reentry:{exchange}:{symbol}
→ Stores: Position data, retry counters, stopLossPrice, tpPercentage
```

## Example Scenario

**Initial Setup:**

```
User enables: /setretry 3 15
Opens position: BTC LONG @ $100, 1 BTC, TP 10%
```

**Retry 1:**

```
✅ TP reached at $110 → Profit $10 secured
📊 Store re-entry: Entry $100, Qty 0.85 BTC, SL $90
⏳ Wait for price to return...
✅ Price returns to $100.20 (within tolerance)
🔄 Re-enter: 0.85 BTC LONG @ $100
🛡️ Set SL @ $90 on exchange
🎯 Set TP @ $110 on exchange
```

**Retry 2:**

```
✅ TP reached at $110 → Profit $8.50 + previous $10 = $18.50 total
📊 Store re-entry: Entry $100, Qty 0.7225 BTC, SL $92.93
⏳ Wait for price...
✅ Price returns to $99.80
🔄 Re-enter: 0.7225 BTC LONG @ $100
🛡️ Set SL @ $92.93 on exchange
🎯 Set TP @ $110 on exchange
```

**Retry 3:**

```
❌ SL hit at $92.93 → Loss $5.15
💰 Net total profit: $18.50 - $5.15 = $13.35 ✅
🎯 Still profitable despite SL!
```

## Error Handling

- **Position open fails:** Notify user, keep re-entry data for next check
- **SL setting fails:** Continue (logged), position still open
- **TP setting fails:** Continue (logged), position still open
- **Max retries reached:** Clean up Redis data, notify user
- **No more pending re-entries:** Reset retry counter to max

## Benefits

1. **Risk Management:** Always secure minimum profit
2. **Automation:** Fully automated, no manual re-entry needed
3. **Flexibility:** Configurable retries and volume reduction
4. **Exchange Protection:** Orders on exchange even if bot offline
5. **Profit Multiplication:** Capture multiple profits from oscillations
6. **Smart Filtering:** Only profitable positions trigger re-entry
