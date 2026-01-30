# Error Logging System

## Overview

The bot now includes comprehensive file-based error logging using Winston with daily file rotation. All errors are automatically logged to files for debugging and analysis.

## Log File Structure

```
logs/
├── error-2024-01-15.log      # Error logs only
├── error-2024-01-16.log
├── combined-2024-01-15.log   # All logs (info, warn, error)
└── combined-2024-01-16.log
```

## Log Configuration

- **Error Logs**: Retained for 30 days
- **Combined Logs**: Retained for 14 days
- **Max File Size**: 20 MB per file
- **Format**: JSON with timestamps
- **Console Output**: Colored, human-readable format

## Log Types

### 1. API Errors

Logs errors from exchange API calls (Binance, OKX):

```json
{
  "type": "API_ERROR",
  "exchange": "binance",
  "operation": "checkTakeProfitTargets",
  "userId": 123456789,
  "symbol": "BTCUSDT",
  "errorMessage": "Insufficient margin",
  "errorCode": "INSUFFICIENT_BALANCE",
  "errorResponse": {...},
  "stack": "...",
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### 2. Business Logic Errors

Logs errors from business operations:

```json
{
  "type": "BUSINESS_ERROR",
  "operation": "handleSetRetry",
  "userId": 123456789,
  "errorMessage": "Invalid retry configuration",
  "stack": "...",
  "timestamp": "2024-01-15T10:30:45.123Z",
  "exchange": "binance",
  "maxRetry": 5,
  "volumeReductionPercent": 15
}
```

### 3. Cron Job Errors

Logs errors from scheduled tasks:

```json
{
  "operation": "checkReentryOpportunities",
  "type": "CRON_ERROR",
  "errorMessage": "Redis connection failed",
  "stack": "...",
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

## Logged Operations

### API Operations

- `checkTakeProfitTargets` - TP monitoring
- `checkReentryOpportunities` - Re-entry checks
- `setStopLoss` - Stop loss setting
- `executeReentry` - Position re-entry
- `closeAllOpenPositions` - Closing positions
- `getPositions` - Fetching positions
- `setKeys` - API key validation
- `handleCloseAllPositions` - Close all command
- `handleClosePosition` - Close specific position

### Business Operations

- `handlePosition` - Position display
- `handleListAccounts` - Account listing
- `handleSetAccount` - TP configuration
- `handleManualUpdate` - Manual updates
- `handleSetRetry` - Retry configuration
- `handleClearRetry` - Retry cleanup

### Cron Jobs

- `checkTakeProfitTargets` - Every 30 seconds
- `checkReentryOpportunities` - Every 15 seconds
- `sendPeriodicUpdates` - Every 5 minutes

## Viewing Logs

### View Recent Errors

```bash
tail -f logs/error-$(date +%Y-%m-%d).log
```

### View All Recent Logs

```bash
tail -f logs/combined-$(date +%Y-%m-%d).log
```

### Search for Specific User Errors

```bash
grep '"userId":123456789' logs/error-*.log
```

### Search for Specific Exchange Errors

```bash
grep '"exchange":"binance"' logs/error-*.log | tail -20
```

### Search by Operation

```bash
grep '"operation":"executeReentry"' logs/error-*.log
```

### View JSON Pretty

```bash
cat logs/error-$(date +%Y-%m-%d).log | jq '.'
```

## Error Analysis Tips

1. **Check API Errors First**: Most issues come from exchange APIs
2. **Look for Patterns**: Repeated errors on same symbol/user
3. **Check Timestamps**: Correlate with user reports
4. **Review Stack Traces**: Identify exact error location
5. **Check Additional Data**: Context variables help debug

## Log Rotation

- Files automatically rotate daily at midnight
- Old files are compressed
- Files older than retention period are deleted automatically
- No manual cleanup needed

## Environment Variables

You can configure logging level via environment variable:

```env
LOG_LEVEL=info    # Options: error, warn, info, debug, verbose
```

Default is `info` which logs everything.

## Debugging Production Issues

When a user reports an issue:

1. **Get user's Telegram ID** from their report
2. **Note the time** of the issue
3. **Search logs** for that user and timeframe:
   ```bash
   grep '"userId":123456789' logs/error-$(date +%Y-%m-%d).log | \
   grep "10:30" | jq '.'
   ```
4. **Check operation context** in the error details
5. **Review stack trace** to identify code location

## Sharing Logs for Debug

To share logs with developers:

```bash
# Today's errors only
cat logs/error-$(date +%Y-%m-%d).log > error-report.log

# Last 100 errors
tail -100 logs/error-$(date +%Y-%m-%d).log > error-report.log

# Specific user's errors
grep '"userId":123456789' logs/error-*.log > user-errors.log
```

## Important Notes

- **Console logs still work** - Both console and file logging are active
- **No performance impact** - Async file writing
- **Automatic cleanup** - No disk space issues
- **Git ignored** - logs/ directory is in .gitignore
- **Privacy**: Contains user IDs but not API keys or sensitive data
