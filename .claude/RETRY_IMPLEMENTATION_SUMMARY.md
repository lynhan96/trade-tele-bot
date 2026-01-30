# Retry/Re-entry Implementation Summary

## ✅ Implementation Complete

All retry/re-entry features have been successfully implemented with **volume reduction** on each retry.

## 🎯 Key Features

### 1. **Volume Reduction on Each Retry**

- Each retry decreases position volume by a configurable percentage (default 15%)
- Example with 5 retries at 15% reduction:
  - Retry 1: 100% volume
  - Retry 2: 85% volume
  - Retry 3: 72.25% volume
  - Retry 4: 61.41% volume
  - Retry 5: 52.20% volume

### 2. **Complete Position Data Storage**

Stores all information when TP is reached:

- Entry price, quantity, leverage, side
- Original quantity and volume (for tracking reduction)
- TP percentage, margin
- Retry count and remaining retries
- Volume reduction percentage

### 3. **Automatic Re-entry**

- Monitors prices every 30 seconds
- Triggers when price returns to entry level (±0.5% tolerance)
- Recreates position with same parameters but reduced volume
- Continues until max retries exhausted

## 📝 New Commands

### `/setretry [exchange] [max_retry] [volume_reduction%]`

Enable retry with volume reduction:

```bash
# Enable 5 retries with 15% reduction (default)
/setretry binance 5

# Enable 3 retries with 20% reduction
/setretry okx 3 20
```

**Parameters:**

- `exchange`: binance or okx
- `max_retry`: 1-10 (number of re-entries)
- `volume_reduction`: 1-50% (default 15%)

### `/clearretry [exchange]`

Disable retry and clear pending re-entries:

```bash
/clearretry binance
/clearretry okx
```

## 🔄 How It Works

### Step 1: Enable Retry

```
/setretry binance 5
```

Output:

```
✅ Retry Enabled for BINANCE

📊 Configuration:
├ Max Retries: 5
├ Volume Reduction: 15% per retry
└ Status: Active

When TP is reached, positions will be re-entered
automatically when price returns to entry level.

Use /clearretry binance to disable.
```

### Step 2: TP is Reached

When your take profit target is hit:

1. Bot closes all positions
2. Stores position data in Redis for re-entry
3. Calculates next entry quantity (reduced by 15%)
4. Sends notification:

```
🎯 Take Profit Target Reached! (BINANCE)

Target: 5% of $1000.00
Target Profit: $50.00
Unrealized PnL: $52.30
Total Balance: $1052.30

✅ All positions have been closed!

🔄 Auto Re-entry Enabled
Will re-enter when price returns (15% volume reduction)
Retries remaining: 5/5
```

### Step 3: Price Monitoring

Bot checks every 30 seconds:

- Gets current market price for each stored position
- Compares to entry price
- If within ±0.5% tolerance → triggers re-entry

### Step 4: Re-entry Executed

When price returns to entry level:

1. Opens new position with reduced volume
2. Sets same TP percentage
3. Updates retry count
4. Sends notification:

```
🔄 Re-entered Position! (BINANCE)

📈 BTCUSDT LONG
Entry: $42,500
Quantity: 0.085 (-15.0% from original)
Volume: $3,612.50
Leverage: 10x

Retry 1/5
Retries remaining: 4
```

### Step 5: Repeat

Process repeats until:

- Max retries exhausted, OR
- User disables retry with `/clearretry`

## 📊 View Configuration

Use `/listaccounts` to see retry status:

```
📋 Your Connected Accounts

🟢 Binance
├ Created: 1/30/2026
├ TP Config: 5% of $1000.00
├ TP Target: $50.00
├ 🔄 Retry: 4/5 (-15% vol)
└

🟠 OKX
├ Created: 1/30/2026
├ TP Config: Not set
├ 🔄 Retry: Disabled
└
```

## 🗂️ Redis Data Structure

### Retry Configuration

Key: `user:{telegramId}:retry:{exchange}`

```json
{
  "maxRetry": 5,
  "currentRetryCount": 4,
  "volumeReductionPercent": 15,
  "enabled": true,
  "setAt": "2026-01-30T10:00:00Z"
}
```

### Re-entry Queue

Key: `user:{telegramId}:reentry:{exchange}:{symbol}`

```json
{
  "symbol": "BTCUSDT",
  "entryPrice": 42500.5,
  "side": "LONG",
  "quantity": 0.085,
  "originalQuantity": 0.1,
  "leverage": 10,
  "margin": 425.0,
  "volume": 3612.5,
  "originalVolume": 4250.0,
  "closedAt": "2026-01-30T10:30:00Z",
  "tpPercentage": 5,
  "currentRetry": 1,
  "remainingRetries": 4,
  "volumeReductionPercent": 15
}
```

## 🔧 Modified Files

### 1. `src/binance/binance.service.ts`

**Added Methods:**

- `getCurrentPrice(apiKey, apiSecret, symbol)` - Get mark price
- `openPosition(apiKey, apiSecret, params)` - Open new position with leverage

### 2. `src/okx/okx.service.ts`

**Added Methods:**

- `getCurrentPrice(apiKey, apiSecret, passphrase, symbol)` - Get last price
- `openPosition(apiKey, apiSecret, passphrase, params)` - Open new position with leverage

### 3. `src/telegram/telegram.service.ts`

**Added Commands:**

- `handleSetRetry()` - Process /setretry command
- `handleClearRetry()` - Process /clearretry command

**Added Cron Job:**

- `checkReentryOpportunities()` - Runs every 30 seconds
  - Monitors all pending re-entries
  - Checks if price reached entry level
  - Executes re-entry when conditions met

**Added Helper:**

- `executeReentry()` - Opens position, updates retry count, notifies user

**Modified Methods:**

- `checkTakeProfitTargets()` - Now stores positions for re-entry when TP reached
- `handleListAccounts()` - Shows retry configuration

## 💡 Volume Reduction Formula

```typescript
// Each retry applies multiplicative reduction
newQuantity = previousQuantity * (1 - volumeReductionPercent / 100);

// Example with 15% reduction:
// Original: 0.1
// Retry 1: 0.1 * 0.85 = 0.085
// Retry 2: 0.085 * 0.85 = 0.07225
// Retry 3: 0.07225 * 0.85 = 0.0614
// Retry 4: 0.0614 * 0.85 = 0.0522
// Retry 5: 0.0522 * 0.85 = 0.0444
```

## ⚠️ Important Notes

### Risk Management

- Volume reduction helps manage risk on consecutive re-entries
- Prevents over-exposure if market keeps hitting TP at same level
- Allows multiple profit-taking opportunities with controlled risk

### Balance Requirements

- Ensure sufficient balance for re-entries
- If balance too low, re-entry will fail but stay in queue
- Bot will retry on next price check

### Price Tolerance

- Re-entry triggers within ±0.5% of entry price
- Prevents constant re-entries from small price fluctuations
- Can be adjusted in code if needed

### Retry Count

- Counts down after each successful re-entry
- If re-entry fails (API error, insufficient balance), count unchanged
- When reaches 0, removes from queue

## 🧪 Testing Checklist

- [x] `/setretry` with valid parameters
- [x] `/setretry` with invalid exchange
- [x] `/setretry` with invalid max retry
- [x] `/setretry` with invalid volume reduction
- [x] `/clearretry` removes config and pending re-entries
- [x] TP reached stores positions with volume reduction
- [x] Price monitoring detects entry opportunities
- [x] Re-entry opens position with correct reduced volume
- [x] Retry count decrements correctly
- [x] Max retries exhausted removes from queue
- [x] `/listaccounts` shows retry config
- [x] Works independently for Binance and OKX
- [x] No TypeScript compilation errors

## 📈 Example Trading Scenario

```
Setup:
→ /setaccount binance 5 1000  (5% TP target)
→ /setretry binance 5          (5 retries, 15% reduction)

Cycle 1:
→ Open BTCUSDT LONG: 0.1 BTC @ $42,500 (10x) = $4,250 volume
→ Price rises to $44,625 (+5%)
→ TP Hit! Profit: $212.50
→ Bot closes position
→ Stores: next quantity = 0.085 BTC

Cycle 2:
→ Price drops to $42,500
→ Re-enters LONG: 0.085 BTC @ $42,500 = $3,612.50 volume
→ Price rises to $44,625 (+5%)
→ TP Hit! Profit: $180.63
→ Stores: next quantity = 0.07225 BTC

Cycle 3:
→ Re-enters: 0.07225 BTC = $3,070.63 volume
→ TP Hit! Profit: $153.53

Cycle 4:
→ Re-enters: 0.0614 BTC = $2,609.50 volume
→ TP Hit! Profit: $130.48

Cycle 5:
→ Re-enters: 0.0522 BTC = $2,218.08 volume
→ TP Hit! Profit: $110.90

Cycle 6 (Final):
→ Re-enters: 0.0444 BTC = $1,885.37 volume
→ TP Hit! Profit: $94.27
→ Retries exhausted, stops monitoring

Total Profit: $882.31 across 6 cycles
```

## 🚀 Deployment

All changes are backward compatible. Existing functionality unchanged:

- TP monitoring continues to work
- Position display unchanged
- No migration needed

Simply restart the bot to activate new features!

## 📚 Related Documents

- [RETRY_LOGIC_DESIGN.md](RETRY_LOGIC_DESIGN.md) - Full design specification
- [COMMANDS.md](COMMANDS.md) - All bot commands
- [README.md](README.md) - Project overview
