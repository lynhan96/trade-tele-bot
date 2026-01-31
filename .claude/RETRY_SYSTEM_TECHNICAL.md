# Retry & Re-entry System - Technical Documentation

## Overview

The retry/re-entry system automatically re-opens positions when the price returns to the original entry level after a Take Profit (TP) target is reached. This allows capturing additional profits from price oscillations while managing risk through volume reduction and stop-loss protection.

## Core Concepts

### 1. Retry Configuration

Each user can configure retry behavior per exchange (Binance/OKX):

```typescript
interface RetryConfig {
  maxRetry: number; // 1-10 retries allowed
  currentRetryCount: number; // Remaining retries
  volumeReductionPercent: number; // 1-50% (default 15%)
  enabled: boolean;
  setAt: number; // Timestamp
}
```

**Storage Key:** `user:{telegramId}:retry:{exchange}`

### 2. Re-entry Data

When TP is reached, position data is stored for potential re-entry:

```typescript
interface ReentryData {
  // Position Info
  symbol: string; // e.g., BTCUSDT
  entryPrice: number; // Original entry price
  side: "LONG" | "SHORT";
  leverage: number;

  // Volume Management
  quantity: number; // Current quantity
  originalQuantity: number; // Initial quantity
  volume: number; // Current volume (USDT)
  originalVolume: number; // Initial volume
  margin: number;

  // Retry Management
  currentRetry: number; // Current retry iteration
  remainingRetries: number; // Retries left
  volumeReductionPercent: number;

  // Risk Management
  tpPercentage: number; // TP % used
  stopLossPrice: number; // Previous TP price (SL level)
  closedAt: number; // Timestamp
}
```

**Storage Key:** `user:{telegramId}:reentry:{exchange}:{symbol}`

## Workflow

### Phase 1: TP Target Reached

**Trigger:** `checkTakeProfitTargets()` cron (every 30s)

```typescript
// 1. Check unrealized PnL vs target
const targetProfit = (initialBalance * tpPercentage) / 100;
if (unrealizedPnl >= targetProfit) {
  // 2. Filter positions with PnL > 0 only
  const profitablePositions = positions.filter((pos) => pos.unrealizedPnl > 0);

  // 3. For each profitable position, calculate stop loss
  for (const position of profitablePositions) {
    const nextQuantity = position.quantity * (1 - volumeReduction / 100);

    // Calculate potential profit if next position reaches TP
    const isLong = position.side === "LONG";
    const tpPrice = isLong
      ? position.entryPrice * (1 + tpPercentage / 100)
      : position.entryPrice * (1 - tpPercentage / 100);
    const potentialNextProfit =
      Math.abs(tpPrice - position.entryPrice) * nextQuantity;

    // Allow Position B to lose its potential profit amount
    // Example: Profit A = $10, Potential B = $8.50 → Allow loss of $8.50 → Net secured = $1.50
    const profitPerUnit = potentialNextProfit / nextQuantity;

    // For LONG: SL = entryPrice - profitPerUnit
    // For SHORT: SL = entryPrice + profitPerUnit
    const stopLossPrice = isLong
      ? parseFloat((position.entryPrice - profitPerUnit).toFixed(4))
      : parseFloat((position.entryPrice + profitPerUnit).toFixed(4));

    // 4. Store re-entry data with profit-protected stop loss
    await storeReentryData({
      ...position,
      currentPrice: position.currentPrice,
      closedProfit: position.unrealizedPnl,
      stopLossPrice: stopLossPrice, // Profit-protected stop loss
      currentRetry: 1,
      remainingRetries: maxRetry - 1,
      volumeReductionPercent: config.volumeReductionPercent,
    });
  }

  // 5. Close only profitable positions
  await closeAllPositions(userData, profitablePositions);

  // 6. Notify user with details
  const totalProfit = profitablePositions.reduce(
    (sum, pos) => sum + pos.unrealizedPnl,
    0,
  );
  sendNotification(
    `TP reached! Closed ${profitablePositions.length} positions\n` +
      `Total Profit: $${totalProfit.toFixed(2)}`,
  );
}
```

**Key Points:**

- **Only closes positions with PnL > 0 AND profit > 2%**
- Minimum 2% profit ensures meaningful gains (filters noise)
- Stop loss calculation: `SL = entryPrice ± (potentialNextProfit / nextQuantity)`
- This ensures: **Net Profit = Original Profit - Potential Next Profit**
- Volume reduced by configured percentage (default 15%)
- Stores closed profit for reference

**Example Calculation:**

**Position A (LONG BTC):**

- Entry: $100, Quantity: 1 BTC
- TP at 10%: $110
- Profit when closed: **$10** ✅

**Position B Re-entry Setup:**

- Entry: $100 (when price returns)
- Quantity: 0.85 BTC (15% reduction)
- Potential TP profit: ($110 - $100) × 0.85 = **$8.50**
- **Stop Loss: $100 - ($8.50 / 0.85) = $100 - $10 = $90**

**Outcome:**

- If SL hits: Loss = -$8.50, Net = $10 - $8.50 = **$1.50 secured** ✅
- If TP hits: Profit = +$8.50, Total = $10 + $8.50 = **$18.50** 🎯

### Phase 2: Price Monitoring

**Trigger:** `checkReentryOpportunities()` cron (every 15s)

```typescript
// 1. Get all pending re-entries
const reentries = await getAllReentries();

for (const reentry of reentries) {
  // 2. Get current market price
  const currentPrice = await getCurrentPrice(symbol);

  // 3. Calculate tolerance (±0.5%)
  const tolerance = reentry.entryPrice * 0.005;
  const priceDiff = Math.abs(currentPrice - reentry.entryPrice);

  // 4. Check if within tolerance
  if (priceDiff <= tolerance) {
    await executeReentry(reentry);
  }
}
```

**Tolerance Logic:**

- Entry at $100: Re-enter between $99.50 - $100.50
- Entry at $50,000: Re-enter between $49,750 - $50,250
- Prevents immediate re-entry on small fluctuations
- Allows for spread/slippage

### Phase 3: Execute Re-entry

**Trigger:** Price within tolerance

```typescript
async function executeReentry(reentryData) {
  // 1. Open position with current quantity
  await openPosition({
    symbol: reentryData.symbol,
    side: reentryData.side,
    quantity: reentryData.quantity,
    leverage: reentryData.leverage,
  });

  // 2. Set Stop Loss on exchange (profit-protected)
  await setStopLoss({
    symbol: reentryData.symbol,
    stopPrice: reentryData.stopLossPrice, // Stored SL price
    side: reentryData.side,
    quantity: reentryData.quantity,
  });

  // 3. Set Take Profit on exchange
  const isLong = reentryData.side === "LONG";
  const takeProfitPrice = isLong
    ? reentryData.entryPrice * (1 + reentryData.tpPercentage / 100)
    : reentryData.entryPrice * (1 - reentryData.tpPercentage / 100);

  await setTakeProfit({
    symbol: reentryData.symbol,
    tpPercentage: reentryData.tpPercentage,
  });

  // 4. Calculate next quantity (volume reduction)
  const nextQuantity =
    reentryData.quantity * (1 - reentryData.volumeReductionPercent / 100);

  // 4. Update or cleanup
  if (reentryData.remainingRetries > 0) {
    // Store for next retry
    await updateReentryData({
      ...reentryData,
      quantity: nextQuantity,
      volume: nextQuantity * reentryData.entryPrice,
      currentRetry: reentryData.currentRetry + 1,
      remainingRetries: reentryData.remainingRetries - 1,
    });
  } else {
    // Last retry - cleanup
    await deleteReentryData();

    // Check if all symbols done
    const remaining = await getRemainingReentries();
    if (remaining.length === 0) {
      // Reset retry counter
      await resetRetryCount();
    }
  }

  // 5. Notify user
  sendNotification("Re-entered position");
}
```

## Volume Reduction Math

### Example: 5 Retries with 15% Reduction

**Initial Position:** 1.0 BTC

| Retry  | Formula       | Quantity | Reduction from Original |
| ------ | ------------- | -------- | ----------------------- |
| 0 (TP) | Original      | 1.0000   | 0%                      |
| 1      | 1.0 × 0.85    | 0.8500   | 15%                     |
| 2      | 0.85 × 0.85   | 0.7225   | 27.75%                  |
| 3      | 0.7225 × 0.85 | 0.6141   | 38.59%                  |
| 4      | 0.6141 × 0.85 | 0.5220   | 47.80%                  |
| 5      | 0.5220 × 0.85 | 0.4437   | 55.63%                  |

**Formula:** `quantity(n) = quantity(n-1) × (1 - reductionPercent/100)`

### Why Volume Reduction?

1. **Risk Management:** Reduce exposure on each retry
2. **Profit Lock:** Already took profit, now risking profits
3. **Market Signal:** If price keeps oscillating, reduce exposure
4. **Capital Preservation:** Don't keep full position indefinitely

## Stop Loss Strategy

### Risk-Free Re-entry

The stop loss is set at the **previous TP price** to ensure risk-free re-entry:

```
Scenario: LONG Position
- Original Entry: $100
- TP Target: 5%
- TP Price: $105 (take profit here)
- Re-entry: $100 (when price returns)
- Stop Loss: $105 (previous TP)

Result: If SL hit, still made 5% profit!
```

**Key Insight:** Even if re-entry fails, you never lose original gains.

### Stop Loss Calculation (Already Done!)

```typescript
// WRONG: Recalculate SL each time
const slPrice = isLong
  ? entryPrice * (1 + tpPercentage / 100)
  : entryPrice * (1 - tpPercentage / 100);

// RIGHT: Use stored stopLossPrice
const slPrice = reentryData.stopLossPrice; // Set once at TP
```

**Why?**

- Consistency across retries
- No calculation errors
- Maintains original profit protection

## Retry Counter Management

### Per-Symbol Tracking

Each symbol has its own retry data:

```
user:123:reentry:binance:BTCUSDT  → { remainingRetries: 3 }
user:123:reentry:binance:ETHUSDT  → { remainingRetries: 5 }
user:123:reentry:binance:BNBUSDT  → { remainingRetries: 2 }
```

### Global Counter Reset

```typescript
// When last retry of a symbol is executed
if (remainingRetries === 0) {
  // Delete this symbol's data
  await deleteReentryData(symbol);

  // Check if ALL symbols are done
  const allReentries = await getAllReentries(exchange);

  if (allReentries.length === 0) {
    // No more pending re-entries, reset global counter
    await updateRetryConfig({
      ...retryConfig,
      currentRetryCount: retryConfig.maxRetry, // Reset
    });
  }
}
```

**Logic:**

- Each symbol decrements independently
- Global counter resets only when ALL symbols exhausted
- Allows user to add new positions without manual reset

## Commands

### /setretry [exchange] [max_retry] [volume_reduction%]

**Examples:**

```
/setretry binance 5
→ 5 retries, 15% reduction (default)

/setretry okx 3 20
→ 3 retries, 20% reduction

/setretry binance 10 10
→ 10 retries, 10% reduction
```

**Validations:**

- exchange: binance | okx
- max_retry: 1-10
- volume_reduction: 1-50% (default 15%)

**Effect:**

- Enables retry system for exchange
- Stores configuration
- Applies to future TP closures

### /clearretry [exchange]

**Examples:**

```
/clearretry binance
→ Disables retries, clears pending re-entries

/clearretry okx
→ Same for OKX
```

**Effect:**

- Deletes retry configuration
- Deletes all pending re-entries
- No more automatic re-entries
- Requires /setretry to re-enable

## Edge Cases & Handling

### 1. Rapid Price Oscillation

**Problem:** Price oscillates rapidly around entry
**Solution:** ±0.5% tolerance prevents immediate retriggering

### 2. Stop Loss Failure

**Problem:** SL order fails to place
**Solution:**

- Log error to file
- Continue execution (don't block)
- Position still opened (user can close manually)

### 3. Insufficient Balance

**Problem:** Not enough margin for reduced quantity
**Solution:**

- Exchange API rejects order
- Error logged
- Re-entry skipped this cycle
- Will retry on next price trigger

### 4. Symbol Price Format

**Problem:** Different decimal places per symbol
**Solution:**

- Use exchange API defaults
- Binance: 4 decimals for prices
- OKX: Varies by instrument

### 5. Leverage Changes

**Problem:** Leverage changed between TP and re-entry
**Solution:**

- Use stored leverage from original position
- Maintain consistency across retries

### 6. Exchange Downtime

**Problem:** API unavailable during re-entry window
**Solution:**

- Error logged
- Retry on next cron run (15s later)
- No data lost

## Performance Considerations

### Redis Operations

- **Read:** O(1) per key
- **Scan:** O(N) for all re-entries
- **Write:** O(1) per update
- **Delete:** O(1) per key

**Optimization:** Re-entries scanned every 15s, limited by active positions

### API Calls

- **Per Re-entry Check:** 1 API call (get price)
- **Per Re-entry Execution:** 2-3 API calls (open position + set SL)
- **Rate Limits:** Handled by exchange SDKs

**Optimization:** Parallel checks for multiple symbols

### Memory Usage

- **Per Re-entry:** ~500 bytes (JSON data)
- **100 Re-entries:** ~50 KB
- **Negligible Impact**

## Monitoring & Debugging

### Log Search

```bash
# Find re-entry errors
grep '"operation":"executeReentry"' logs/error-*.log

# Find specific symbol re-entries
grep '"symbol":"BTCUSDT"' logs/combined-*.log | grep reentry

# Check retry cleanup
grep "retry reset" logs/combined-*.log
```

### Redis Inspection

```bash
# List all re-entries for user
redis-cli keys "binance-bot:user:123456789:reentry:*"

# Get re-entry data
redis-cli get "binance-bot:user:123456789:reentry:binance:BTCUSDT"

# Get retry config
redis-cli get "binance-bot:user:123456789:retry:binance"
```

### Health Checks

- Verify cron jobs running (check logs)
- Check Redis connectivity
- Monitor error rates
- Track re-entry success rate

## Testing Scenarios

### Scenario 1: Successful Re-entry

1. Set TP target 5%, balance $1000
2. Open position: 1 BTC at $100
3. Price goes to $105 → TP hit
4. Price drops to $100 → Re-enter 0.85 BTC
5. SL at $105 protects profit

### Scenario 2: Multiple Retries

1. Configure 3 retries, 15% reduction
2. TP at $105
3. Retry 1: $100 → 0.85 BTC, SL $105
4. TP at $105 again
5. Retry 2: $100 → 0.7225 BTC, SL $105
6. TP at $105 again
7. Retry 3: $100 → 0.6141 BTC, SL $105
8. Cleanup + reset counter

### Scenario 3: Stop Loss Hit

1. Re-enter at $100, SL $105
2. Price goes to $105
3. SL triggered → Position closed
4. Still profitable (previous TP at $105)

## Conclusion

The retry system provides automated profit maximization while maintaining:

- **Risk Control:** Volume reduction
- **Profit Protection:** SL at previous TP
- **Flexibility:** Configurable retries
- **Reliability:** Error handling & cleanup
- **Transparency:** Full logging
