# Quick Reference - Bot Commands

## User Commands

### Initial Setup

**Start the bot:**

```
/start
```

**Set Binance API Keys:**

```
/setkeys binance YOUR_API_KEY YOUR_API_SECRET
```

**Set OKX API Keys:**

```
/setkeys okx YOUR_API_KEY YOUR_API_SECRET YOUR_PASSPHRASE
```

### Trading Operations

**View Open Positions:**

```
/position
```

Shows all open positions, unrealized PnL, and account balance.

**Set Take Profit Target:**

```
/set-account <percentage> <initial_balance>
```

Example: `/set-account 5 1000`

- Closes ALL positions when unrealized PnL reaches 5% of $1000 ($50 profit)

**Clear Take Profit Target:**

```
/cleartp
```

Removes the automatic TP target.

**Manual Status Update:**

```
/update
```

Get immediate status update (useful for testing).

## Automated Features

### Take Profit Monitoring

- **Frequency:** Every 30 seconds
- **Action:** Checks if unrealized PnL reaches target
- **Result:** Automatically closes all positions when target is hit

### Periodic Updates

- **Frequency:** Every 10 minutes
- **Action:** Sends progress update to users with TP targets set
- **Content:** Current balance, unrealized PnL, progress toward TP target

## API Key Requirements

### Binance

- Futures trading permission
- Read account information
- Place/cancel orders

### OKX

- API v5
- Trade permission
- Read permission
- Optional: IP whitelist for security

## Exchange-Specific Notes

### Binance

- Supports Futures (Perpetual)
- Symbol format: BTCUSDT, ETHUSDT, etc.
- Uses binance-api-node library

### OKX

- Supports SWAP contracts (Perpetual)
- Symbol format: BTC-USDT-SWAP, ETH-USDT-SWAP, etc.
- Uses direct REST API (axios)
- Requires passphrase in addition to API key and secret

## Example Workflow

1. Start bot: `/start`
2. Set API keys: `/setkeys binance YOUR_KEY YOUR_SECRET`
3. Open positions on exchange (manually or via another bot)
4. Check positions: `/position`
5. Set TP target: `/set-account 5 1000` (5% of $1000 = $50 target)
6. Bot monitors every 30 seconds
7. Bot closes all positions when PnL reaches $50
8. You receive notification with summary

## Security Notes

- API key messages are automatically deleted after processing
- Store passphrase securely (for OKX users)
- Use IP whitelist when possible
- Enable only required permissions (Trade + Read)
- Never share your API keys or passphrases

## Troubleshooting

**"You need to register first"**

- Run `/start` first
- Then set API keys with `/setkeys`

**"Invalid API keys"**

- Double-check your keys
- Verify exchange type is correct (binance vs okx)
- Ensure permissions are enabled
- For OKX: verify passphrase is correct

**"No positions found"**

- Ensure you have open positions on the exchange
- Check if you're using the correct exchange
- Verify API has read permissions

**Position info not updating**

- Check internet connection
- Verify exchange API is operational
- Check bot logs for errors
