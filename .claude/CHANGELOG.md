# Changelog

## 2026-01-31 - Entry Price Optimization & Documentation Organization

### Entry Price Optimization (NEW FEATURE)

**Problem**: When re-entering positions, the system was using the ORIGINAL entry price for all calculations, not the actual execution price. This could lead to inaccurate TP/SL calculations and missed optimization opportunities.

**Solution**: Updated re-entry logic to use ACTUAL execution price from order results.

**Implementation**:

```typescript
// Extract actual execution price from order result
const actualEntryPrice = orderResult?.avgPrice
  ? parseFloat(orderResult.avgPrice)
  : reentryData.entryPrice; // Fallback

// Calculate TP based on NEW entry (not original)
const takeProfitPrice = isLong
  ? parseFloat(
      (actualEntryPrice * (1 + reentryData.tpPercentage / 100)).toFixed(4),
    )
  : parseFloat(
      (actualEntryPrice * (1 - reentryData.tpPercentage / 100)).toFixed(4),
    );

// Calculate next stop loss based on NEW entry price
const potentialNextProfit =
  Math.abs(takeProfitPrice - actualEntryPrice) * nextQuantity;
const nextStopLossPrice = isLong
  ? parseFloat(
      (actualEntryPrice - potentialNextProfit / nextQuantity).toFixed(4),
    )
  : parseFloat(
      (actualEntryPrice + potentialNextProfit / nextQuantity).toFixed(4),
    );

// Store NEW entry price for next retry
await this.redisService.set(
  `user:${telegramId}:reentry:${exchange}:${symbol}`,
  {
    ...reentryData,
    entryPrice: actualEntryPrice, // 🔥 Use actual execution price
    stopLossPrice: nextStopLossPrice, // 🔥 SL based on new entry
    quantity: nextQuantity,
    // ...
  },
);
```

**Benefits**:

1. **Better Risk/Reward**: Entry adapts to market conditions (e.g., $100k → $95k → $92k)
2. **Accurate Stop Loss**: SL calculated from actual entry, not original
3. **Market Adaptation**: System uses real execution prices, no slippage accumulation
4. **Price Improvement Tracking**: Notifications show entry improvement percentage

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines 740-950: Re-entry execution logic
- `src/binance/binance.service.ts` - Lines 283-320: Return avgPrice in order result
- `src/okx/okx.service.ts` - Lines 389-445: Fetch and return avgPrice
- `src/simulator/complete-system.simulator.ts` - Lines 703-789: New Scenario 6 test

**Testing**:

- Added Scenario 6: Entry Price Optimization
- Tests entry adaptation: $100k → $95k → $92k
- Tests SL calculation based on actual entries
- Result: ✅ 100% pass (6/6 complete system tests)
- Overall: 20/24 tests passing (83.3%)

### Documentation Organization (IMPROVEMENT)

**Problem**: Technical documentation files were scattered in root directory instead of organized in `.claude/` folder.

**Solution**: Moved all technical docs to `.claude/` and updated documentation-workflow skill to remember this pattern.

**Changes**:

- Moved `TEST_FAILURES_ANALYSIS.md` → `.claude/TEST_FAILURES_ANALYSIS.md`
- Moved `TEST_SUITE_OVERVIEW.md` → `.claude/TEST_SUITE_OVERVIEW.md`
- Moved `TESTING_IMPLEMENTATION_SUMMARY.md` → `.claude/TESTING_IMPLEMENTATION_SUMMARY.md`
- Updated all file references in skill guides

**Organization Rules**:

```
Root directory:
  - README.md, TESTS_README.md, TESTING_GUIDE.md (user-facing)
  - package.json, tsconfig.json (config only)

.claude/ directory:
  - All technical documentation
  - CHANGELOG.md, ARCHITECTURE.md, *_TECHNICAL.md
  - *_IMPLEMENTATION_SUMMARY.md, *_ANALYSIS.md

.claude/skills/ directory:
  - Individual SKILL.md files
  - One folder per skill domain
```

**Files Modified**:

- `.claude/skills/documentation-workflow/SKILL.md` - Added file organization section
- `.claude/skills/testing-simulator/SKILL.md` - Updated file paths
- `.claude/skills/retry-reentry-system/SKILL.md` - Updated file paths

**Benefits**:

- Clear separation: user-facing vs technical docs
- Easier navigation and maintenance
- AI assistant knows where to place new docs
- Consistent project structure

---

## 2026-01-31 - Added 2% Minimum Profit Filter

### Enhancement

**What Changed**: Added minimum 2% profit requirement for positions to be closed when TP is reached.

**Implementation**:

```typescript
// New filter logic
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  // Calculate profit percentage
  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Minimum 2% profit required
});
```

**Rationale**:

- Filters out small price fluctuations (< 2% gains)
- Ensures meaningful profit before closing positions
- Reduces unnecessary re-entries
- Covers trading fees and slippage
- Avoids premature exit from positions

**Examples**:

| Position  | Entry  | Current | Profit % | Dollar PnL | Action             |
| --------- | ------ | ------- | -------- | ---------- | ------------------ |
| BTC LONG  | $100   | $101.50 | 1.5%     | +$1.50     | ❌ Left open       |
| ETH LONG  | $3000  | $3070   | 2.33%    | +$70       | ✅ Closed          |
| SOL SHORT | $100   | $98     | 2%       | +$2.00     | ❌ Left open (=2%) |
| AVAX LONG | $50000 | $51500  | 3%       | +$1500     | ✅ Closed          |

**Files Modified**:

- `src/telegram/telegram.service.ts`: Lines 204-213 (Binance), Lines 365-374 (OKX)
- `.claude/RETRY_SYSTEM_TECHNICAL.md`: Updated Phase 1 filtering logic
- `.claude/skills/retry-reentry-system/SKILL.md`: Updated filtering section with examples
- `.claude/CHANGELOG.md`: This entry

**Impact**: More selective position closing, better profit management, reduced noise.

---

## 2026-01-31 - Retry System Enhancements

### Features

#### 1. Selective Position Closing (Profitable + Minimum 2% Profit)

**What Changed**: When TP target is reached, bot now only closes positions with PnL > 0 AND profit > 2%

**Before**:

```typescript
// Closed ALL positions regardless of profit/loss
await closeAllPositions(userData, positions);
```

**After**:

```typescript
// Filter positions: profitable AND > 2% gain
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Minimum 2% profit
});
await closeAllPositions(userData, profitablePositions);
```

**Benefits**:

- Losing positions stay open (can recover)
- Small gains (< 2%) stay open (avoid premature exit)
- Only meaningful profits trigger re-entry
- Filters out noise and small fluctuations
- Covers trading fees and slippage
- More intelligent profit management
- Better risk control

**Example Scenarios**:

| Position  | Entry | Current | Profit % | Action              |
| --------- | ----- | ------- | -------- | ------------------- |
| BTC LONG  | $100  | $101.50 | 1.5%     | ❌ Left open (< 2%) |
| ETH LONG  | $3000 | $3070   | 2.33%    | ✅ Closed (> 2%)    |
| SOL SHORT | $100  | $97     | 3%       | ✅ Closed (> 2%)    |
| AVAX LONG | $50   | $48     | -4%      | ❌ Left open (loss) |

**User Notification Updated**:

```
🎯 Take Profit Target Reached! (BINANCE)

Target: 10% of $1000.00
Target Profit: $100.00
Unrealized PnL: $105.50
Total Balance: $1105.50

✅ Closed 2 profitable position(s)
💰 Total Profit Captured: $105.50

  BTCUSDT: LONG $75.00
  ETHUSDT: LONG $30.50

🔄 Auto Re-entry Enabled
Will re-enter when price returns (15% volume reduction)
Retries remaining: 5/5
```

#### 2. Profit-Protected Stop Loss Calculation

**What Changed**: Stop loss now uses risk-equals-reward approach, protecting minimum profit

**Old Calculation**:

```typescript
// Used previous TP price as SL
const stopLossPrice = tpPrice; // Too conservative
```

**New Calculation**:

```typescript
// Calculate potential next profit
const potentialNextProfit = Math.abs(tpPrice - entryPrice) × nextQuantity;
const profitPerUnit = potentialNextProfit / nextQuantity;

// Allow position to lose its potential gain
const stopLossPrice = isLong
  ? entryPrice - profitPerUnit
  : entryPrice + profitPerUnit;
```

**Example**:

**Position A (Original)**:

- Entry: $100, Quantity: 1 BTC, LONG
- TP at 10%: $110
- Profit: **$10** (closed and secured)

**Position B (Re-entry)**:

- Entry: $100, Quantity: 0.85 BTC (15% reduction)
- Potential TP profit: ($110 - $100) × 0.85 = **$8.50**
- Stop Loss: $100 - $10 = **$90**

**Outcomes**:

- 📉 SL hits at $90: Loss = -$8.50, **Net = $1.50** ✅
- 📈 TP hits at $110: Profit = +$8.50, **Total = $18.50** 🎯

**Benefits**:

- Secures minimum profit = original profit - potential next profit
- Risk equals reward (symmetrical risk/reward)
- More aggressive than old method (higher profit potential)
- Still protects core gains

#### 3. Automatic Exchange Orders for Re-entry

**What Changed**: Both Stop Loss AND Take Profit are now automatically set on the exchange

**Before**:

```typescript
// Only set stop loss
await setStopLoss(...);
// TP monitoring done by bot
```

**After**:

```typescript
// Set stop loss on exchange
await setStopLoss({
  symbol: reentryData.symbol,
  stopPrice: stopLossPrice,
  side: reentryData.side,
  quantity: reentryData.quantity,
});

// Set take profit on exchange ⭐ NEW
await setTakeProfit({
  symbol: reentryData.symbol,
  tpPercentage: reentryData.tpPercentage,
});
```

**Benefits**:

- Orders execute even if bot is offline
- Exchange handles timing and execution
- User can see orders in exchange UI
- More reliable than bot monitoring
- Reduces bot API calls

**User Notification Updated**:

```
🔄 Re-entered Position! (BINANCE)

📈 BTCUSDT LONG
Entry: $100,000
Quantity: 0.8500 (-15.0% from original)
Volume: $85,000.00
Leverage: 10x

🎯 Take Profit: $110,000 (+10%)
🛡️ Stop Loss: $90,000 (Profit Protected)

Retry 1/5
Retries remaining: 4
```

### Files Modified

**src/telegram/telegram.service.ts**:

- Lines 207-253: Updated Binance TP check with profitable filter + new SL calc
- Lines 363-409: Updated OKX TP check with profitable filter + new SL calc
- Lines 282-297: Updated Binance TP notification message
- Lines 420-435: Updated OKX TP notification message
- Lines 605-625: Updated re-entry execution to set both SL and TP
- Lines 752-775: Updated re-entry notification message

**Documentation**:

- `.claude/RETRY_SYSTEM_TECHNICAL.md`: Updated Phase 1 and Phase 3 with new logic
- `.claude/skills/retry-reentry-system/SKILL.md`: Created comprehensive skill guide

### Database Schema Changes

**ReentryData** (Redis storage):

```typescript
{
  // Existing fields...
  currentPrice: number,        // ⭐ NEW: Price when position closed
  closedProfit: number,        // ⭐ NEW: Profit from closed position
  stopLossPrice: number,       // Updated calculation method
  // ...
}
```

### Migration Notes

- No database migration needed (backward compatible)
- Old reentry data will use fallback SL calculation
- New positions will use updated calculation automatically

---

## 2026-01-30 - Command Name Standardization

### Changes

#### Unified Command Naming: /set-account → /setaccount

**Reason**: Standardize all commands to use single-word format without hyphens for consistency and easier typing.

**Changes Made**:

- Command pattern: `/setaccount` (no change in regex, already was `/setaccount`)
- All help text updated from `/set-account` to `/setaccount`
- Error messages updated to show `/setaccount`
- Quick start guides updated

**Command Format**:

```
/setaccount exchange % balance
```

**Examples**:

```
/setaccount binance 5 1000
/setaccount okx 10 2000
```

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines 63, 65, 517, 635, 886, 979-980, 993, 1160
  - Updated all instances of `/set-account` text to `/setaccount`
  - Logger message, help text, error messages, footer text

**User Impact**:

- No breaking change - command was already `/setaccount` in code
- Only help text/documentation updated for consistency
- Users typing `/set-account` will get "unknown command" (as before)

---

## 2026-01-30 - Command Architecture Redesign & Position Management

### Breaking Changes

#### Removed Active Exchange Concept

**Problem**: The `/switch` command workflow was confusing:

- Users had to remember which exchange was currently active
- Required extra step before executing commands
- Not intuitive for managing multiple exchanges

**Solution**: Direct exchange specification in commands

- **Removed**: `/switch` command entirely
- **Updated All Commands**: Now require exchange parameter

**Command Changes**:

```
Old: /switch binance → /set-account 5 1000
New: /set-account binance 5 1000

Old: /switch okx → /cleartp
New: /cleartp okx

Old: /switch binance → /update
New: /update binance
```

**Benefits**:

- More explicit and clear which exchange is being operated on
- No mental overhead of tracking active exchange
- Commands are self-documenting
- Easier to script and automate

**Files Modified**:

- `src/telegram/telegram.service.ts` - Removed `handleSwitchExchange()` method
- All command handlers updated to parse exchange from arguments

#### Updated Command Signatures

**`/set-account`** - Now requires exchange

```
Format: /set-account [exchange] [%] [balance]
Example: /set-account binance 5 1000
Example: /set-account okx 10 2000
```

**`/cleartp`** - Now requires exchange

```
Format: /cleartp [exchange]
Example: /cleartp binance
Example: /cleartp okx
```

**`/update`** - Now requires exchange

```
Format: /update [exchange]
Example: /update binance
Example: /update okx
```

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines ~73, ~76, ~83 (command patterns)
- `handleSetAccount()`, `handleClearTakeProfit()`, `handleManualUpdate()` - Updated argument parsing

### New Features

#### 1. Close All Positions Command

**Command**: `/closeall [exchange]`

**Description**: Close all open positions on specified exchange at once

**Examples**:

```
/closeall binance
/closeall okx
```

**Features**:

- Validates exchange exists and is connected
- Fetches all open positions
- Closes positions sequentially with error handling
- Shows progress feedback during execution
- Confirms total positions closed

**Implementation**:

- `src/telegram/telegram.service.ts` - New `handleCloseAllPositions()` method
- Reuses existing `closeAllPositions()` helper
- Added command handler on line ~89

#### 2. Close Position by Symbol Command

**Command**: `/close [exchange] [symbol]`

**Description**: Close a specific position by symbol

**Examples**:

```
/close binance BTCUSDT
/close okx BTC-USDT-SWAP
```

**Features**:

- Validates exchange and symbol
- Looks up position in open positions
- Shows error if position not found
- Displays position details after closing (side, entry price, PnL)
- Proper symbol format validation

**Implementation**:

- `src/telegram/telegram.service.ts` - New `handleClosePosition()` method
- Symbol lookup from `getOpenPositions()`
- Exchange-specific close methods
- Added command handler on line ~95

**Files Modified**: `src/telegram/telegram.service.ts`

### Updated Documentation

**`/start` Command Help**:

```
/position - View positions & PnL
/accounts - View configs & TP settings
/set-account exchange % balance - Set TP target
/close exchange symbol - Close specific position
/closeall exchange - Close all positions
/cleartp exchange - Remove TP target
/update exchange - Get balance & TP progress
/setkeys exchange ... - Update API keys
```

**`/setkeys` Success Message**:

- Updated quick start guide to show exchange-specific commands
- Changed tip from "/switch" to "/closeall [exchange]"

**`/accounts` Footer**:

- Changed from "Use /switch [exchange]..." to "Use /set-account [exchange]..."

**Files Modified**: `src/telegram/telegram.service.ts` - Lines ~510-520, ~635-645, ~870

### Technical Details

**Active Exchange Tracking**:

- Still maintained in Redis (`user:{id}:active`) for backward compatibility
- Not used by any commands anymore
- May be fully removed in future version

**Error Handling**:

- All commands validate exchange parameter first
- Clear error messages for missing or invalid exchanges
- Position not found errors include hint to use `/position`

**Migration Notes**:

- Users need to update their command syntax
- Old `/switch` command will return "unknown command" error
- All existing TP configurations remain unchanged (exchange-specific Redis keys still work)

---

## 2026-01-30 - UX Improvements & Command Refinements

### User Experience Enhancements

#### 1. Improved Command Descriptions & Workflow

**Changes**:

- **`/start`**: Reordered commands by usage frequency, clearer descriptions
  - Prioritized `/position` as first command (most common use case)
  - Removed redundant "(active exchange)" suffixes
  - More concise, action-oriented descriptions
- **`/setkeys`**: Added quick start guide after successful setup
  - Shows 3 most important next steps
  - Includes tip about switching exchanges
- **`/switch`**: Enhanced feedback with contextual next actions
  - Shows what commands now operate on switched exchange
  - Provides immediate action suggestions
- **`/accounts`**: Now displays TP configuration for each exchange
  - Shows TP percentage, initial balance, and target profit
  - Clear visual distinction between active/inactive exchanges

**Benefits**:

- Faster onboarding for new users
- Clearer understanding of active exchange context
- Reduced support questions about which exchange is active

**Files Modified**: `src/telegram/telegram.service.ts`

#### 2. Enhanced `/accounts` Command

**Before**: Only showed exchange connection status and creation date

**After**: Comprehensive account overview including:

- Active exchange indicator (🟢/⚪)
- TP configuration per exchange
- Target profit calculation
- "Not set" status when TP not configured

**Example Output**:

```
📋 Your Connected Accounts

🟢 Binance
├ Created: 1/30/2026
├ TP Config: 5% of $1000.00
└ TP Target: $50.00

⚪ OKX
├ Created: 1/30/2026
└ TP Config: Not set

Active Exchange: BINANCE
```

**Files Modified**: `src/telegram/telegram.service.ts` - `handleListAccounts()`

---

## 2026-01-30 - Multi-Exchange TP Support & Display Improvements

### Fixed Issues

#### 1. Volume Calculation (NaN Display)

**Problem**: OKX positions showed "Volume: NaN USDT"

- **Root Cause**: Incorrect volume calculation in `telegram.service.ts` using `pos.margin * pos.leverage`
- **Solution**:
  - Updated `okx.service.ts` line ~184: Changed from `margin * quantity` to `quantity * entryPrice` (correct notional value)
  - Updated `telegram.service.ts` to use `pos.volume` from service instead of recalculating
- **Files Modified**:
  - `src/okx/okx.service.ts`
  - `src/telegram/telegram.service.ts` (lines ~679 and ~745)

#### 2. Profit Color Indicators

**Problem**: All positions showed red circle (🔴) regardless of profit/loss

- **Solution**: Added dynamic emoji based on profit:
  - Green circle (🟢) for positive profit (`pos.unrealizedPnl > 0`)
  - Red circle (🔴) for negative profit (`pos.unrealizedPnl <= 0`)
- **Files Modified**: `src/telegram/telegram.service.ts` (both Binance and OKX sections)

#### 3. TP/SL Not Displayed

**Problem**: OKX positions showed TP/SL as `--`

- **Root Cause**: TP/SL fetching was disabled in `okx.service.ts` (hardcoded to `null`)
- **Solution**:
  - Enabled algo orders fetching from OKX API endpoint `/api/v5/trade/orders-algo-pending`
  - Extract `tpOrdPx` and `slOrdPx` from conditional orders
  - Added error handling for API failures
- **Files Modified**: `src/okx/okx.service.ts` (lines ~195-217)

#### 4. Exchange-Specific TP Targets

**Problem**: TP system used single target for all exchanges (`user:{id}:tp`)

- **Impact**: Users couldn't set different TP targets for Binance vs OKX
- **Solution**: Updated Redis key pattern to `user:{id}:tp:{exchange}`
  - `/set-account` now sets TP for active exchange only
  - `/cleartp` clears TP for active exchange
  - Cron jobs updated to check each exchange independently
  - `/update` command now shows TP progress for active exchange
- **Files Modified**:
  - `src/telegram/telegram.service.ts`:
    - `handleSetAccount()` - Store exchange-specific TP
    - `handleClearTakeProfit()` - Clear exchange-specific TP
    - `checkTakeProfitTargets()` - Monitor per-exchange
    - `sendPeriodicUpdates()` - Send per-exchange updates
    - `handleManualUpdate()` - Show active exchange only
  - `.claude/skills/redis-data-patterns/SKILL.md` - Updated documentation

### Technical Details

#### OKX Algo Orders API

- Endpoint: `/api/v5/trade/orders-algo-pending`
- Parameters:
  - `instType: "SWAP"`
  - `instId: {symbol}` (e.g., "ETH-USDT-SWAP")
  - `ordType: "conditional"`
- Response fields:
  - `tpOrdPx`: Take profit trigger price
  - `slOrdPx`: Stop loss trigger price

#### Redis Key Migration

**Old Pattern**: `user:123456:tp`
**New Pattern**:

- `user:123456:tp:binance`
- `user:123456:tp:okx`

**Migration Notes**: No automatic migration implemented. Users need to reset their TP targets using `/set-account` command.

### Testing Checklist

- [x] Volume displays correct notional value (quantity × entry price)
- [x] Green/red indicators match profit direction
- [x] OKX TP/SL fetched from algo orders
- [x] Set TP on Binance, switch to OKX, set different TP
- [x] Clear TP on one exchange doesn't affect other
- [x] Cron jobs monitor each exchange independently
- [x] Manual update shows only active exchange

### Breaking Changes

⚠️ **TP Target Storage**: Existing TP targets stored in `user:{id}:tp` will not be read by the new system. Users must:

1. Note their current TP settings
2. Clear old TP: `/cleartp`
3. Switch to desired exchange: `/switch [binance|okx]`
4. Reset TP: `/set-account [percentage] [initial_balance]`

### Future Enhancements

- [ ] Migration script to convert old TP format to new format
- [ ] Support for position-specific TP/SL (not account-wide)
- [ ] Trailing stop loss implementation
- [ ] TP/SL order placement directly through bot
