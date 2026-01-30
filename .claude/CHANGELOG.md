# Changelog

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
