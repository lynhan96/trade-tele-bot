# Quick Start - Error Logging System

## ✅ System is Ready

The error logging system is now fully integrated and ready to use.

## What Was Added

1. **Winston Logger** - Professional logging library with file rotation
2. **Error Logs** - All errors automatically saved to `logs/error-YYYY-MM-DD.log`
3. **Combined Logs** - All activity saved to `logs/combined-YYYY-MM-DD.log`
4. **Automatic Cleanup** - Old logs deleted automatically (30 days for errors, 14 days for combined)

## No Configuration Needed

The system works automatically when you start the bot:

```bash
npm run start
# or
npm run start:dev
```

## Checking Logs

### View Real-time Errors

```bash
# In a new terminal while bot is running
tail -f logs/error-$(date +%Y-%m-%d).log
```

### View All Activity

```bash
tail -f logs/combined-$(date +%Y-%m-%d).log
```

### Search for User Issues

```bash
# Replace 123456789 with actual Telegram user ID
grep '"userId":123456789' logs/error-*.log
```

### Search for Exchange Issues

```bash
# Binance errors
grep '"exchange":"binance"' logs/error-*.log

# OKX errors
grep '"exchange":"okx"' logs/error-*.log
```

## When Users Report Issues

1. Ask for their Telegram ID
2. Note the time of the issue
3. Search the logs:
   ```bash
   grep '"userId":123456789' logs/error-$(date +%Y-%m-%d).log | grep "10:30"
   ```
4. Send the relevant log entries to developers

## Log Files Location

```
binance-tele-bot/
└── logs/                           # Created automatically
    ├── error-2024-01-15.log       # Errors only
    ├── error-2024-01-16.log
    ├── combined-2024-01-15.log    # All logs
    └── combined-2024-01-16.log
```

## What Gets Logged

- ❌ API errors (Binance, OKX)
- ❌ Re-entry failures
- ❌ Stop loss errors
- ❌ Position closing errors
- ❌ Command processing errors
- ❌ Cron job failures
- ✅ Successful operations (in combined logs)
- ✅ Important events (in combined logs)

## Important Notes

- **Safe for Git**: `logs/` directory is ignored
- **No Secrets**: API keys and passwords are NOT logged
- **Automatic**: No manual intervention needed
- **Performance**: Async logging, no slowdown
- **Space**: Auto-deletes old files, won't fill disk

## Troubleshooting

### If logs directory doesn't exist

It will be created automatically on first run.

### If logs are empty

Check that the bot is running and errors are occurring.

### If files are too large

They auto-rotate at 20MB or daily, whichever comes first.

## Advanced Usage

See [ERROR_LOGGING.md](ERROR_LOGGING.md) for:

- Detailed log format
- Advanced search queries
- JSON parsing with `jq`
- Integration with log analysis tools

---

**You're all set! The bot will now log all errors to files automatically.** 🎉
