# OKX Integration Guide

## Overview

Your bot now supports both Binance and OKX exchanges! Users can choose which exchange to use when setting their API keys.

## Installation

After updating the code, install the new dependency:

```bash
npm install axios
```

Or install all dependencies:

```bash
npm install
```

## Bot Commands

### Setting Up API Keys

**For Binance:**

```
/setkeys binance <api_key> <api_secret>
```

**For OKX:**

```
/setkeys okx <api_key> <api_secret> <passphrase>
```

Note: OKX requires an additional passphrase that you set when creating the API key.

### Other Commands (Work with both exchanges)

- `/start` - Start the bot and see welcome message
- `/position` - View all open positions and account balance
- `/set-account <tp_%> <initial_balance>` - Set take profit target
- `/cleartp` - Clear take profit target
- `/update` - Manual update of current status

## Features

### Multi-Exchange Support

- Users can connect to either Binance or OKX
- The bot automatically uses the correct exchange based on stored user preferences
- All features work seamlessly across both exchanges:
  - Position monitoring
  - Take profit targets
  - Automatic position closing
  - Periodic updates

### OKX-Specific Implementation

- Uses OKX V5 API
- Supports SWAP (perpetual) contracts
- Implements proper signature authentication
- Handles conditional orders for take profit

### Architecture Changes

#### New Files

- `src/okx/okx.service.ts` - OKX API integration service
- `src/okx/okx.module.ts` - OKX module

#### Modified Files

- `src/interfaces/user.interface.ts` - Added `exchange` and `passphrase` fields
- `src/app.module.ts` - Imported OKX module
- `src/telegram/telegram.module.ts` - Added OKX service dependency
- `src/telegram/telegram.service.ts` - Updated all handlers to support both exchanges
- `package.json` - Added axios dependency

## OKX API Setup

To use OKX with the bot:

1. Log in to your OKX account
2. Go to Settings → API → Create API Key
3. Choose API v5
4. Set permissions:
   - Trade (required for placing/closing orders)
   - Read (required for viewing positions)
5. Set IP whitelist (recommended for security)
6. Save your API Key, Secret Key, and Passphrase securely
7. Use the `/setkeys okx` command with these credentials

## Testing

Start the bot:

```bash
npm run start:dev
```

Test with a user:

1. `/start` - Initialize
2. `/setkeys okx <key> <secret> <passphrase>` - Set OKX keys
3. `/position` - View positions
4. `/set-account 5 1000` - Set 5% TP target on $1000 initial balance

## Key Differences: Binance vs OKX

| Feature        | Binance                | OKX                           |
| -------------- | ---------------------- | ----------------------------- |
| API Key Parts  | API Key + Secret       | API Key + Secret + Passphrase |
| Symbol Format  | BTCUSDT                | BTC-USDT-SWAP                 |
| Order Types    | TAKE_PROFIT_MARKET     | Conditional Orders            |
| Position API   | futuresPositionRisk    | /api/v5/account/positions     |
| Authentication | Query string signature | Header-based signature        |

## Notes

- The bot stores the exchange type with user data, so switching between exchanges requires re-running `/setkeys`
- Each user can only be connected to one exchange at a time
- All monetary values are in USDT for both exchanges
- The cron jobs (30-second TP check and 10-minute updates) work for all users regardless of exchange

## Troubleshooting

**"Cannot find module 'axios'"**

- Run `npm install axios`

**"Invalid OKX API keys"**

- Ensure you're using API v5 keys
- Check that the passphrase is correct
- Verify API permissions include Trade and Read

**"OKX API Error: ..."**

- Check OKX API status
- Ensure your IP is whitelisted (if configured)
- Verify your account has futures trading enabled
