# TP Retry/Re-entry Logic Design

## Overview

When a take profit (TP) target is reached and all positions are closed, the system can automatically re-enter positions when the price returns to the original entry level.

## User Flow

### 1. Setup Retry Configuration

```bash
# Enable retry with max 3 attempts for Binance
/setretry binance 3

# Enable retry with max 5 attempts for OKX
/setretry okx 5

# View current retry config
/listaccounts  # Shows retry config per exchange

# Disable retry
/clearretry binance
```

### 2. Normal Trading Flow with Retry

1. User sets TP target: `/setaccount binance 5 1000`
2. Bot monitors positions every 30 seconds
3. **TP Target Reached:**
   - Bot closes all positions
   - Saves each position's details to Redis for re-entry
   - Sends notification: "✅ TP reached! Will retry when price returns (1/3 remaining)"
4. **Price Monitoring (every 30 seconds):**
   - Bot checks current market price vs stored entry prices
   - When price reaches stored entry level (±0.5% tolerance)
   - Bot automatically re-opens the position with same parameters
5. **Re-entry Executed:**
   - Opens same side (LONG/SHORT), quantity, leverage
   - Sends notification: "🔄 Re-entered BTC-USDT LONG at $42,500 (Retry 1/3)"
   - Decrements retry count
6. **Process Repeats:**
   - If TP is reached again, repeats the cycle
   - Continues until `maxRetry` reaches 0
7. **Max Retries Exhausted:**
   - Stops monitoring that pair
   - Sends notification: "⚠️ Max retries reached for BTC-USDT"

## Redis Data Structures

### Retry Configuration

```typescript
// Key: user:{telegramId}:retry:{exchange}
{
  maxRetry: 3,              // Max re-entries
  currentRetryCount: 3,     // Remaining retries (counts down)
  volumeReductionPercent: 15, // Percentage to reduce volume on each retry
  enabled: true,
  setAt: "2026-01-30T10:00:00Z"
}
```

### Re-entry Queue

```typescript
// Key: user:{telegramId}:reentry:{exchange}:{symbol}
{
  symbol: "BTC-USDT-SWAP",
  entryPrice: 42500.50,
  side: "LONG",
  quantity: 0.1,            // Current quantity (reduced on each retry)
  originalQuantity: 0.1,    // Original quantity from first entry
  leverage: 10,
  margin: 425.00,
  volume: 4250.00,          // Current volume (quantity * entryPrice)
  originalVolume: 4250.00,  // Original volume
  closedAt: "2026-01-30T10:30:00Z",
  tpPercentage: 5,
  currentRetry: 1,          // Which retry attempt this is (1, 2, 3...)
  remainingRetries: 2,      // How many retries left after this re-entry
  volumeReductionPercent: 15 // Percentage to reduce volume on each retry
}
```

### Volume Reduction Logic

```typescript
// Volume decreases by fixed percentage on each retry
// Example with maxRetry=5, volumeReduction=15%:
// Retry 1: 100.0% volume
// Retry 2:  85.0% volume (100% * 0.85)
// Retry 3:  72.25% volume (85% * 0.85)
// Retry 4:  61.41% volume (72.25% * 0.85)
// Retry 5:  52.20% volume (61.41% * 0.85)

// Formula:
newQuantity = previousQuantity * (1 - volumeReductionPercent / 100);
```

### Price Tolerance

```typescript
// Re-entry trigger when:
// abs(currentPrice - entryPrice) / entryPrice <= 0.005 (0.5%)
```

## Technical Implementation

### 1. New Commands

#### `/setretry [exchange] [max_retry] [volume_reduction_percent]`

- Validates exchange (binance/okx)
- Validates max_retry (1-10)
- Validates volume_reduction_percent (1-50, default 15)
- Stores config in Redis
- Response: "✅ Retry enabled for BINANCE: Max 5 re-entries with 15% volume reduction per retry"

#### `/clearretry [exchange]`

- Deletes retry config
- Clears all pending re-entries for that exchange
- Response: "✅ Retry disabled for BINANCE. Cleared 2 pending re-entries."

### 2. Modified: `checkTakeProfitTargets()`

**When TP is reached:**

```typescript
// After closing all positions successfully:
if (retryConfig && retryConfig.enabled && retryConfig.currentRetryCount > 0) {
  // Store each position for re-entry
  for (const position of positions) {
    // Calculate next quantity with volume reduction
    const volumeReduction = retryConfig.volumeReductionPercent || 15;
    const nextQuantity = position.quantity * (1 - volumeReduction / 100);

    await this.redisService.set(
      `user:${telegramId}:reentry:${exchange}:${position.symbol}`,
      {
        symbol: position.symbol,
        entryPrice: position.entryPrice,
        side: position.side,
        quantity: nextQuantity, // Reduced quantity for next entry
        originalQuantity: position.quantity,
        leverage: position.leverage,
        margin: position.margin,
        volume: nextQuantity * position.entryPrice,
        originalVolume: position.quantity * position.entryPrice,
        closedAt: new Date().toISOString(),
        tpPercentage: tpData.percentage,
        currentRetry: retryConfig.maxRetry - retryConfig.currentRetryCount + 1,
        remainingRetries: retryConfig.currentRetryCount - 1,
        volumeReductionPercent: volumeReduction,
      },
    );
  }

  // Notify user
  await this.bot.sendMessage(
    chatId,
    `🎯 TP Reached! Positions closed.\n` +
      `🔄 Will re-enter when price returns with ${volumeReduction}% less volume.\n` +
      `Retries remaining: ${retryConfig.currentRetryCount}/${retryConfig.maxRetry}`,
  );
}
```

### 3. New Cron Job: `checkReentryOpportunities()`

**Runs every 30 seconds** (same as TP check)

```typescript
@Cron(CronExpression.EVERY_30_SECONDS)
private async checkReentryOpportunities() {
  try {
    // Get all pending re-entries
    const keys = await this.redisService.keys("user:*:reentry:*");

    for (const key of keys) {
      // Parse: user:{telegramId}:reentry:{exchange}:{symbol}
      const parts = key.split(":");
      const telegramId = parts[2];
      const exchange = parts[4];
      const symbol = parts[5];

      const reentryData = await this.redisService.get(key);
      if (!reentryData) continue;

      const userData = await this.getUserData(parseInt(telegramId), exchange);
      if (!userData) continue;

      // Get current market price
      const currentPrice = await this.getCurrentPrice(exchange, symbol, userData);

      // Check if price is within tolerance (±0.5%)
      const priceDiff = Math.abs(currentPrice - reentryData.entryPrice);
      const tolerance = reentryData.entryPrice * 0.005; // 0.5%

      if (priceDiff <= tolerance) {
        // Re-enter position
        await this.executeReentry(
          telegramId,
          exchange,
          userData,
          reentryData
        );
      }
    }
  } catch (error) {
    this.logger.error("Error in checkReentryOpportunities:", error.message);
  }
}
```

### 4. New Helper Methods

#### `getCurrentPrice()`

Fetches current market price for a symbol

#### `executeReentry()`

Opens a new position with stored parameters:

1. Places market order
2. Sets new TP order at same percentage
3. Updates retry count
4. Removes from re-entry queue if maxRetry reached
5. Sends notification to user

### 5. Update to `closeAllPositions()`

Add logic to check if retry is enabled and store positions before closing.

## Edge Cases & Considerations

### 1. **Insufficient Balance**

- If balance is too low to re-enter
- Send notification: "❌ Cannot re-enter BTC-USDT: Insufficient balance"
- Keep in re-entry queue (try next time)

### 2. **API Errors**

- Network issues, exchange downtime
- Log error, keep in queue
- Retry on next cron cycle

### 3. **Symbol Delisted/Suspended**

- Position cannot be re-opened
- Remove from queue
- Notify user

### 4. **Price Never Returns**

- No expiration (positions stay in queue indefinitely)
- User can manually clear with `/clearretry`

### 5. **Multiple Positions Same Symbol**

- Currently closes all positions together
- Re-entry stores last closed position data
- Consider: Store array of positions per symbol

### 6. **Retry Count Tracking**

- Decrements AFTER successful re-entry
- If re-entry fails, retry count unchanged
- When count reaches 0, remove from queue

### 7. **Manual Position Closure**

- If user manually closes before TP
- Re-entry queue is NOT created
- Only works when TP target is reached automatically

## Example Scenario

```
Initial Setup:
- User sets: /setaccount binanc5 (Max 5 re-entries, 15% volume reduction)

Cycle 1:
- Opens BTC-USDT LONG at $42,500, quantity 0.1, 10x leverage, volume $4,250
- Price rises to $44,625 (5% profit)
- TP reached: Bot closes position
- Stores re-entry: entryPrice=$42,500, quantity=0.1, retries=5
- Message: "🎯 TP reached! Will retry when price returns (5 retries left)"

Cycle 2 (Retry 1):
- Price drops back to $42,500
- Bot calculates: newQuantity = 0.1 * 0.85 = 0.085 (15% reduction)
- Bot re-enters: BTC-USDT LONG at $42,500, 0.085, 10x, volume $3,612.50
- Updates retries: 4 remaining
- Message: "🔄 Re-entered BTC-USDT LONG at $42,500 | Qty: 0.085 (-15%) | Vol: $3,612.50 (Retry 1/5)"

Cycle 3 (Retry 2):
- Price rises to $44,625, TP hit
- Bot closes, calculates: newQuantity = 0.085 * 0.85 = 0.07225
- Stores re-entry with quantity=0.07225, retries=4
- Message: "🎯 TP reached again! Next re-entry: 0.072 (-15%) (4 retries left)"

Cycle 4 (Retry 3):
- Re-enters with quantity 0.07225, volume $3,070.63
- Message: "🔄 Re-entered | Qty: 0.072 (-15%) | Vol: $3,070.63 (Retry 3/5)"

Cycle 5 (Retry 4):
- Re-enters with quantity 0.0614, volume $2,609.50
- Message: "🔄 Re-entered | Qty: 0.061 (-15%) | Vol: $2,609.50 (Retry 4/5)"

Cycle 6 (Retry 5 - FINAL):
- Re-enters with quantity 0.0522, volume $2,218.08
- Message: "🔄 Final retry! | Qty: 0.052 (-15%) | Vol: $2,218.08 (Retry 5/5)"

Final Cycle:
- TP reached after 5th retry
- Retries = 0
- Removes from queue
- Message: "🎯 TP reached! ⚠️ Max retries exhausted. Re-entry disabled for BTC-USDT."
- Total profit across all cycles: ~$1,700+ (compound profit)
- Message: "🎯 TP reached! ⚠️ Max retries exhausted. Re-entry disabled for BTC-USDT."
```

## API Methods Needed

### Exchange Services (Binance/OKX)

```typescript
// Get current market price for symbol
async getCurrentPrice(symbol: string): Promise<number>

// Open position with specific parameters
async openPosition(params: {
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  leverage: number
}): Promise<any>
```

## Configuration Options (Future Enhancement)

```typescript
interface RetryConfig {
  maxRetry: number; // Max re-entries
  priceTolerancePercent: number; // Default 0.5%, customizable
  expirationHours?: number; // Optional: Remove from queue after X hours
  partialReentry?: boolean; // Optional: Re-enter with partial quantity
  stopAfterLoss?: boolean; // Optional: Stop retry if any re-entry results in loss
}
```

## Testing Checklist

- [ ] `/setretry` with valid parameters
- [ ] `/setretry` with invalid exchange
- [ ] `/setretry` with invalid max retry (0, negative, > 10)
- [ ] `/clearretry` removes config and pending re-entries
- [ ] TP reached stores positions in queue
- [ ] Price returns triggers re-entry
- [ ] Re-entry decrements retry count
- [ ] Max retries exhausted stops monitoring
- [ ] Insufficient balance handles gracefully
- [ ] API error doesn't lose queue data
- [ ] Multiple positions on same symbol
- [ ] Works independently for Binance and OKX
- [ ] `/listaccounts` shows retry config

## Files to Modify

1. **src/telegram/telegram.service.ts**
   - Add `/setretry` command handler
   - Add `/clearretry` command handler
   - Add `checkReentryOpportunities()` cron job
   - Add `executeReentry()` helper
   - Modify `checkTakeProfitTargets()` to store re-entry data
   - Modify `handleListAccounts()` to show retry config

2. **src/binance/binance.service.ts**
   - Add `getCurrentPrice(symbol)` method
   - Add `openPosition(params)` method

3. **src/okx/okx.service.ts**
   - Add `getCurrentPrice(symbol)` method
   - Add `openPosition(params)` method

4. **src/interfaces/user.interface.ts** (optional)
   - Add `RetryConfig` interface
   - Add `ReentryData` interface

## Security & Risk Considerations

⚠️ **Important Notes:**

1. **Market Risk**: Automated re-entry can lead to continuous losses if market trend changes
2. **Balance Management**: Ensure sufficient balance for re-entries
3. **Position Sizing**: Consider reducing quantity on retries (future feature)
4. **Stop Loss**: User should set SL manually to limit losses
5. **Testing**: Test thoroughly on testnet before production
6. **Monitoring**: Log all re-entry attempts for audit trail
7. **User Control**: Users can disable retry anytime with `/clearretry`

## Future Enhancements

- [ ] Configurable price tolerance per user
- [ ] Partial re-entry (50% of original quantity)
- [ ] Dynamic retry based on win/loss ratio
- [ ] Different TP percentage for retries
- [ ] Time-based expiration of re-entry queue
- [ ] DCA (Dollar Cost Averaging) on re-entries
- [ ] Analytics dashboard showing retry success rate
