# Command Reference

## User Commands

### Account Setup

#### /start

**Description:** Welcome message and command list

**Usage:**

```
/start
```

**Response:** List of available commands with descriptions

---

#### /setkeys [exchange] [api_key] [api_secret] [passphrase]

**Description:** Configure API keys for an exchange

**Usage:**

```
Binance:
/setkeys binance YOUR_API_KEY YOUR_API_SECRET

OKX:
/setkeys okx YOUR_API_KEY YOUR_API_SECRET YOUR_PASSPHRASE
```

**Notes:**

- Message is deleted after processing for security
- Validates API keys before storing
- Overwrites existing keys

**Errors:**

- ❌ Invalid API keys or insufficient permissions
- ❌ Invalid exchange name

---

### Account Management

#### /accounts

**Description:** List all connected exchanges and their configurations

**Usage:**

```
/accounts
```

**Shows:**

- Connected exchanges (Binance, OKX)
- Balance for each exchange
- TP configuration
- Retry configuration
- Active exchange

**Example Response:**

```
🟢 BINANCE
├ Balance: $10,523.45
├ TP Target: 5% ($500.00)
├ 🔄 Retry: 5/5 (-15% vol)
└

Active Exchange: BINANCE
```

---

#### /setaccount [exchange] [tp_percentage] [initial_balance]

**Description:** Configure Take Profit target for an exchange

**Usage:**

```
/setaccount binance 5 10000
/setaccount okx 3 5000
```

**Parameters:**

- `exchange`: binance or okx
- `tp_percentage`: Target profit percentage (e.g., 5 = 5%)
- `initial_balance`: Starting balance in USDT

**Effect:**

- Enables automatic TP monitoring
- Bot checks every 30 seconds
- Closes all positions when target reached

**Example Response:**

```
✅ BINANCE TP target set!

Configuration:
├ Target: 5% profit
├ Initial Balance: $10,000.00
├ Target Profit: $500.00
└ Status: Active

Bot will monitor and close positions automatically.
```

---

#### /cleartp [exchange]

**Description:** Remove Take Profit configuration

**Usage:**

```
/cleartp binance
/cleartp okx
```

**Effect:**

- Disables TP monitoring
- Keeps positions open
- Can reconfigure with /setaccount

---

### Position Management

#### /position

**Description:** View all open positions across exchanges

**Usage:**

```
/position
```

**Shows:**

- All open positions per exchange
- Entry price, leverage, volume
- Current PnL
- TP/SL levels
- Total unrealized PnL
- Current balance

**Example Response:**

```
🟢 BINANCE

📈 LONG BTCUSDT x 10
Entry: 45,000.00
TP/SL: 47,250.00/43,200.00
Volume: 5,000.0000 USDT
Profit: 225.50 USDT

Lãi/lỗ chưa ghi nhận: 225.50
Balance hiện tại: 10,225.50
```

---

#### /close [exchange] [symbol]

**Description:** Close a specific position

**Usage:**

```
/close binance BTCUSDT
/close okx BTC-USDT-SWAP
```

**Effect:**

- Market order to close position
- Shows final PnL

**Example Response:**

```
✅ Successfully closed BTCUSDT position on BINANCE!

Side: LONG
Entry: 45000.0000
PnL: 225.50 USDT
```

---

#### /closeall [exchange]

**Description:** Close all positions on an exchange

**Usage:**

```
/closeall binance
/closeall okx
```

**Effect:**

- Closes all open positions
- Market orders
- Shows count closed

**Example Response:**

```
🔄 Closing 3 position(s) on BINANCE...
✅ Successfully closed all positions on BINANCE!
```

---

### Retry System

#### /setretry [exchange] [max_retry] [volume_reduction%]

**Description:** Enable automatic re-entry after TP

**Usage:**

```
/setretry binance 5
→ 5 retries with 15% volume reduction (default)

/setretry okx 3 20
→ 3 retries with 20% volume reduction

/setretry binance 10 10
→ 10 retries with 10% reduction each time
```

**Parameters:**

- `exchange`: binance or okx
- `max_retry`: 1-10 retries
- `volume_reduction`: 1-50% (optional, default 15%)

**How It Works:**

1. TP target reached → Close all positions
2. Store position data with entry prices
3. When price returns to entry (±0.5%) → Re-enter
4. Each retry reduces volume by configured %
5. Stop loss set at previous TP price (risk-free!)

**Example Response:**

```
✅ Retry enabled for BINANCE!

📊 Configuration:
├ Max Retries: 5
├ Volume Reduction: 15% per retry
└ Status: Active

When TP is reached, positions will be re-entered
automatically when price returns to entry level.
```

---

#### /clearretry [exchange]

**Description:** Disable retry system and clear pending re-entries

**Usage:**

```
/clearretry binance
/clearretry okx
```

**Effect:**

- Disables automatic re-entry
- Deletes all pending re-entries
- Shows count of cleared entries

**Example Response:**

```
✅ Retry disabled for BINANCE

Cleared 3 pending re-entries.
Use /setretry binance to re-enable.
```

---

### Manual Updates

#### /update [exchange]

**Description:** Manually trigger balance and TP progress update

**Usage:**

```
/update binance
/update okx
```

**Shows:**

- Current balance
- Unrealized PnL
- TP target progress
- Percentage to target

**Example Response:**

```
📊 Manual Update (BINANCE)

💰 Current Balance: $10,225.50
📈 Unrealized PnL: $225.50

🎯 TP Target Progress:
├ Target: 5% ($500.00)
├ Current: 2.26%
└ Remaining: $274.50 (54.91%)
```

---

## Command Examples by Workflow

### Initial Setup

```
1. /start
2. /setkeys binance YOUR_KEY YOUR_SECRET
3. /setaccount binance 5 10000
4. /setretry binance 5 15
```

### Check Status

```
/accounts     → See all configurations
/position     → View open positions
/update binance → Manual progress check
```

### Modify Settings

```
/setaccount binance 10 15000  → Change TP target
/setretry binance 3 20        → Change retry config
/cleartp binance              → Disable TP
/clearretry binance           → Disable retry
```

### Position Management

```
/close binance BTCUSDT    → Close one position
/closeall binance         → Close all positions
```

---

## Automatic Operations

### TP Monitoring (Every 30s)

- Checks unrealized PnL vs target
- Closes all positions when reached
- Stores re-entry data if retry enabled
- Sends notification

### Re-entry Check (Every 15s)

- Monitors price vs stored entry
- Re-enters when within ±0.5%
- Sets stop loss at previous TP
- Reduces volume per retry config
- Sends notification

### Periodic Updates (Every 5 min)

- Sends balance update
- Shows TP progress
- Only if TP configured

---

## Error Messages

### Common Errors

**❌ Please set up your account first with /setkeys**

- Need to configure API keys

**❌ Invalid [EXCHANGE] API keys or insufficient permissions**

- Wrong API key/secret
- Missing trading permissions
- API keys need Futures/Margin enabled

**❌ [EXCHANGE] account not found**

- Use /setkeys first

**❌ No take profit target is set**

- Use /setaccount to set TP

**❌ Invalid exchange. Please use 'binance' or 'okx'**

- Typo in exchange name
- Only binance and okx supported

**❌ Max retry must be between 1 and 10**

- Invalid retry count

**❌ Volume reduction must be between 1% and 50%**

- Invalid reduction percentage

---

## Tips & Best Practices

### API Key Setup

1. Create API key with Futures/Margin trading enabled
2. Restrict to your IP if possible
3. Enable only necessary permissions
4. Never share your API keys

### Take Profit Strategy

1. Start with 3-5% target
2. Adjust based on market conditions
3. Higher % = longer to reach
4. Lower % = frequent closes

### Retry Configuration

1. Start with 3-5 retries
2. 15-20% volume reduction recommended
3. More retries = more opportunities
4. Higher reduction = lower risk

### Risk Management

1. Monitor positions regularly
2. Use stop losses (auto-set with retries)
3. Don't over-leverage
4. Close positions manually if needed

### Performance

1. Commands respond immediately
2. Cron jobs run automatically
3. Check logs if issues occur
4. /accounts shows all status

---

## Notifications

### Automatic Notifications

**TP Reached:**

```
🎯 Take Profit Target Reached! (BINANCE)

Closed 3 position(s)
💰 Profit: $525.30
📊 Balance: $10,525.30

🔄 Auto Re-entry Enabled
Will re-enter when price returns (15% volume reduction)
Retries remaining: 5/5
```

**Re-entry Executed:**

```
🔄 Re-entered Position! (BINANCE)

📈 LONG BTCUSDT x10
Entry: $45,000.00
Quantity: 0.0850 (-15.0% from original)
Volume: $3,825.00
Leverage: 10x
🛡️ Stop Loss: $47,250.00 (Previous TP - No loss risk!)

Retry 1/5
Retries remaining: 4
```

**Retry Exhausted:**

```
🔄 Re-entered Position! (BINANCE)

📈 LONG BTCUSDT x10
Entry: $45,000.00
Quantity: 0.0442 (-55.6% from original)
Volume: $1,989.00
Leverage: 10x
🛡️ Stop Loss: $47,250.00 (Previous TP - No loss risk!)

Retry 5/5
⚠️ This was the last retry!
```

---

## Command Permissions

All commands require:

- Valid Telegram user ID
- For trading commands: Configured API keys
- For TP/retry: Active exchange account

No admin/special permissions needed.

---

## Rate Limits

### Bot Limitations

- No internal rate limiting
- Exchange rate limits apply
- Cron jobs have fixed intervals

### Best Practices

- Don't spam commands
- Wait for responses
- Check /accounts for status
- Monitor /position regularly

---

## Troubleshooting

**Bot not responding:**

1. Check bot is running
2. Verify TELEGRAM_BOT_TOKEN
3. Check logs for errors

**Commands fail:**

1. Check API keys valid (/setkeys)
2. Verify exchange permissions
3. Check account balance
4. Review /accounts status

**TP not triggering:**

1. Verify TP configured (/setaccount)
2. Check balance vs target
3. Wait for next cron cycle (30s)
4. Review logs

**Re-entry not working:**

1. Check retry enabled (/setretry)
2. Verify price at entry level
3. Wait for next cron cycle (15s)
4. Check logs for errors

---

## Support

For issues or questions:

1. Check logs: `logs/error-YYYY-MM-DD.log`
2. Review documentation
3. Test commands manually
4. Check Redis data
5. Contact admin with log files
