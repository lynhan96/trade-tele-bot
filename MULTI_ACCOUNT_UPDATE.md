# Multi-Account Update - Both Exchanges Simultaneously

## Overview

Updated the bot to support **BOTH Binance and OKX accounts simultaneously** for each Telegram user. Commands now fetch and display data from **all connected accounts**, not just one active exchange.

## Key Changes

### Redis Storage Structure

**Old:** `user:{telegramId}` - Only one exchange per user
**New:** `user:{telegramId}:{exchange}` - Multiple exchanges per user

Example:

- `user:123456:binance` - User's Binance credentials
- `user:123456:okx` - User's OKX credentials
- `user:123456:active` - Current active exchange (used for legacy/optional features)
- `user:123456:tp` - Take profit settings (applies to all exchanges)

## Updated Commands

### `/position` - Show All Positions

Now displays positions from **both exchanges** if connected:

```
🟢 BINANCE
#babywatermelon đang có các vị thế:
[Binance positions here...]

🟠 OKX
#babywatermelon đang có các vị thế:
[OKX positions here...]
```

### `/update` - Manual Update for All

Shows progress for **both exchanges**:

```
📊 Manual Update (BINANCE)
💰 Current Balance: $...
📈 Unrealized PnL: $...
🎯 TP Target Progress: ...

📊 Manual Update (OKX)
💰 Current Balance: $...
📈 Unrealized PnL: $...
🎯 TP Target Progress: ...
```

### `/accounts` - List All Connected Accounts

Shows which exchanges are connected:

```
📋 Your Connected Accounts

🟢 Binance
└ Created: 01/29/2026

🟠 OKX
└ Created: 01/29/2026

Active Exchange: BINANCE

Use /switch <exchange> to change active exchange.
```

### `/switch <exchange>` - Switch Active Exchange

Changes which exchange is considered "active" (for future features):

```
/switch binance
/switch okx
```

### `/setkeys` - Add/Update Exchange Keys

Same format, now stores to exchange-specific keys:

```
/setkeys binance <api_key> <api_secret>
/setkeys okx <api_key> <api_secret> <passphrase>
```

## Automated Features

### Take Profit Monitoring (Every 30 seconds)

- Checks **both Binance AND OKX** accounts if connected
- Monitors each exchange independently
- Closes positions on the exchange that reaches target
- Sends separate notifications for each exchange

**Example:**

```
🎯 Take Profit Target Reached! (BINANCE)
Target: 5% of $1000.00
Target Profit: $50.00
Unrealized PnL: $51.23
Total Balance: $1051.23

✅ All positions have been closed!
```

### Periodic Updates (Every 10 minutes)

- Sends updates for **both exchanges** if TP is set
- Each exchange gets its own message
- Shows individual progress for each account

## How It Works

### User Flow Example

1. **Connect Binance:**

   ```
   /setkeys binance YOUR_KEY YOUR_SECRET
   ✅ BINANCE API keys saved successfully!
   ```

2. **Connect OKX:**

   ```
   /setkeys okx YOUR_KEY YOUR_SECRET YOUR_PASSPHRASE
   ✅ OKX API keys saved successfully!
   ```

3. **Set TP Target (applies to both):**

   ```
   /set-account 5 1000
   ✅ Account TP Target Set
   ```

4. **Check Positions (both exchanges):**

   ```
   /position

   🟢 BINANCE
   [Shows Binance positions...]

   🟠 OKX
   [Shows OKX positions...]
   ```

5. **Manual Update (both exchanges):**

   ```
   /update

   📊 Manual Update (BINANCE)
   [Shows Binance progress...]

   📊 Manual Update (OKX)
   [Shows OKX progress...]
   ```

## Benefits

### ✅ True Multi-Account Support

- One Telegram user can have both Binance and OKX
- No need to switch between exchanges
- See everything at once

### ✅ Independent Monitoring

- Each exchange monitored separately
- TP target applies to both
- Positions closed independently when each reaches target

### ✅ Complete Visibility

- All positions visible with one command
- All balances shown simultaneously
- No hidden data

### ✅ Flexible Setup

- Can connect only Binance
- Can connect only OKX
- Can connect both
- Can update credentials anytime

## Technical Implementation

### Helper Methods Added

```typescript
getActiveExchange(telegramId) - Get user's active exchange
setActiveExchange(telegramId, exchange) - Set active exchange
getUserData(telegramId, exchange) - Get credentials for specific exchange
getActiveUserData(telegramId) - Get credentials for active exchange
```

### Storage Keys

```
user:{telegramId}:binance - Binance account data
user:{telegramId}:okx - OKX account data
user:{telegramId}:active - Active exchange preference
user:{telegramId}:tp - TP settings (shared)
```

### Cron Jobs Updated

1. **checkTakeProfitTargets()** - Checks both exchanges independently
2. **sendPeriodicUpdates()** - Sends separate updates for each exchange

## Migration Notes

### For Existing Users

Old data stored as `user:{telegramId}` needs migration or re-setup:

- Users will need to re-run `/setkeys` command
- Old data won't automatically convert to new structure
- This is by design to ensure clean multi-account setup

### For New Users

- Simply connect any exchange with `/setkeys`
- Can add second exchange anytime
- All features work immediately

## Testing Checklist

- [ ] Connect Binance account
- [ ] Connect OKX account
- [ ] Run `/position` - verify both show up
- [ ] Run `/update` - verify both show updates
- [ ] Run `/accounts` - verify both listed
- [ ] Set TP target with `/set-account`
- [ ] Verify cron sends updates for both
- [ ] Test TP trigger on Binance only
- [ ] Test TP trigger on OKX only
- [ ] Switch between exchanges with `/switch`

## Important Notes

⚠️ **TP Target is Shared:** One TP percentage and initial balance applies to both exchanges. Each exchange is monitored separately against this target.

⚠️ **Independent Closing:** When Binance reaches TP target, only Binance positions close. OKX positions remain open until OKX also reaches target.

⚠️ **Chat ID:** Both exchange accounts share the same chatId (Telegram user).

## Example Scenario

**Setup:**

- User has $1000 on Binance
- User has $1000 on OKX
- TP target set: 5% of $1000 = $50

**Monitoring:**

- Bot checks Binance every 30 seconds
- Bot checks OKX every 30 seconds
- Both checked independently

**Result:**

- If Binance unrealized PnL reaches $50 → Close Binance positions
- If OKX unrealized PnL reaches $50 → Close OKX positions
- Each happens independently

**Updates:**

- Every 10 minutes, receive 2 messages:
  - One for Binance progress
  - One for OKX progress
