# Trading Bot Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Telegram Bot API                      │
│                  (User Interface Layer)                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              TelegramBotService                          │
│          (Business Logic & Orchestration)                │
│                                                          │
│  • Command Handlers                                      │
│  • Cron Jobs (TP Check, Re-entry, Updates)             │
│  • Position Management                                   │
│  • Retry Logic Orchestration                            │
└─┬─────────┬─────────┬─────────┬─────────┬──────────────┘
  │         │         │         │         │
  ▼         ▼         ▼         ▼         ▼
┌────┐   ┌────┐   ┌─────┐   ┌─────┐   ┌──────┐
│Redis│   │Binance│ │ OKX │   │Logger│  │Config│
│Svc  │   │  Svc  │ │ Svc │   │ Svc  │  │ Svc  │
└────┘   └────┘   └─────┘   └─────┘   └──────┘
  │         │         │         │
  ▼         ▼         ▼         ▼
┌────┐   ┌────┐   ┌─────┐   ┌─────┐
│Redis│   │Binance│ │ OKX │   │ Logs│
│  DB │   │  API  │ │ API │   │Files│
└────┘   └────┘   └─────┘   └─────┘
```

## Module Structure

### Core Modules

```typescript
AppModule
├── ConfigModule (Global)
├── ScheduleModule (Cron Jobs)
├── LoggerModule (Global)
├── RedisModule
├── BinanceModule
├── OkxModule
└── TelegramModule
```

## Data Flow

### 1. User Command Flow

```
User → Telegram → Bot API → TelegramBotService
                              ↓
                        Command Handler
                              ↓
                    ┌─────────┴──────────┐
                    ▼                     ▼
            Exchange Service        Redis Service
                    ▼                     ▼
              Exchange API           Store State
                    ▼                     ▼
            Response Back  ←──────  Update Cache
                    ▼
            Send to User
```

### 2. Take Profit Monitoring Flow

```
Cron (30s) → checkTakeProfitTargets()
                ↓
        Get Users with TP Config from Redis
                ↓
        For Each User/Exchange:
                ↓
        ┌───────┴───────┐
        ▼               ▼
    Binance API     OKX API
    (Get Balance)   (Get Balance)
        ▼               ▼
    Calculate PnL vs Target
        ▼
    If Target Reached:
        ├→ Close All Positions
        ├→ Calculate TP Price
        ├→ Store Re-entry Data
        └→ Notify User
```

### 3. Re-entry System Flow

```
Cron (15s) → checkReentryOpportunities()
                ↓
        Get All Pending Re-entries
                ↓
        For Each Re-entry:
                ↓
        Get Current Price
                ↓
        If Price ± 0.5% of Entry:
                ↓
        executeReentry()
                ↓
        ┌───────┴───────┐
        ▼               ▼
    Open Position   Set Stop Loss
    (Reduced Volume) (At Previous TP)
        ▼               ▼
    Store Next Re-entry Config
        ↓
    Decrement Retries
        ▼
    If Retries = 0:
        └→ Cleanup & Reset Counter
```

## Key Services

### TelegramBotService

**Responsibilities:**

- Handle Telegram commands
- Execute cron jobs
- Orchestrate business logic
- Manage user state
- Error handling & logging

**Key Methods:**

- `checkTakeProfitTargets()` - Monitor TP
- `checkReentryOpportunities()` - Check re-entry
- `executeReentry()` - Execute re-entry
- `closeAllPositions()` - Close positions
- Command handlers (handleXxx methods)

### BinanceService

**Responsibilities:**

- Binance Futures API integration
- Account balance queries
- Position management
- Order execution

**Key Methods:**

- `getAccountBalance()`
- `getAllPositions()`
- `closePosition()`
- `openPosition()`
- `setStopLoss()`
- `getCurrentPrice()`

### OkxService

**Responsibilities:**

- OKX API v5 integration
- Account queries
- Position management
- Order execution

**Key Methods:**

- `getAccountBalance()`
- `getAllPositions()`
- `closePosition()`
- `openPosition()`
- `setStopLoss()`
- `getCurrentPrice()`

### RedisService

**Responsibilities:**

- State persistence
- Cache management
- Key-value operations

**Key Data Structures:**

```
user:{id}:api:{exchange}          → API credentials
user:{id}:tp:{exchange}           → TP config
user:{id}:retry:{exchange}        → Retry config
user:{id}:reentry:{exchange}:{symbol} → Re-entry data
user:{id}:active:exchange         → Active exchange
user:{id}:chatId                  → Telegram chat ID
```

### FileLoggerService

**Responsibilities:**

- File-based error logging
- Daily log rotation
- Structured JSON logs
- Console output

**Log Types:**

- `logApiError()` - Exchange API errors
- `logBusinessError()` - Business logic errors
- `logError()` - General errors

## Configuration

### Environment Variables

```env
TELEGRAM_BOT_TOKEN=xxx          # Telegram Bot API token
REDIS_HOST=localhost            # Redis connection
REDIS_PORT=6379
REDIS_PASSWORD=                 # Optional
LOG_LEVEL=info                  # Logging level
```

### Retry System Configuration

```typescript
{
  maxRetry: 1-10,              // Number of retries
  currentRetryCount: number,   // Current count
  volumeReductionPercent: 1-50%, // Volume reduction
  enabled: boolean,
  setAt: timestamp
}
```

### Re-entry Data Structure

```typescript
{
  symbol: string,
  entryPrice: number,
  side: "LONG" | "SHORT",
  quantity: number,
  originalQuantity: number,
  leverage: number,
  margin: number,
  volume: number,
  originalVolume: number,
  closedAt: timestamp,
  tpPercentage: number,
  stopLossPrice: number,        // Previous TP price
  currentRetry: number,
  remainingRetries: number,
  volumeReductionPercent: number
}
```

## Cron Jobs

### checkTakeProfitTargets

- **Frequency:** Every 30 seconds
- **Purpose:** Monitor unrealized PnL vs TP target
- **Actions:**
  - Close all positions if target reached
  - Store re-entry data if retry enabled
  - Send notifications

### checkReentryOpportunities

- **Frequency:** Every 15 seconds
- **Purpose:** Check for price return to entry
- **Actions:**
  - Get current prices
  - Compare with stored entry prices (±0.5%)
  - Execute re-entry with reduced volume
  - Set stop loss at previous TP

### sendPeriodicUpdates

- **Frequency:** Every 5 minutes
- **Purpose:** Send balance updates to users
- **Actions:**
  - Fetch current balance
  - Calculate progress to TP
  - Send formatted message

## Error Handling

### Error Logging Strategy

1. **File Logging Only:** All errors logged to files
2. **Structured Data:** JSON format with context
3. **Daily Rotation:** Auto-rotate and cleanup
4. **Error Types:**
   - API Errors (Exchange failures)
   - Business Errors (Logic failures)
   - Cron Errors (Job failures)

### Error Recovery

- **Transient Failures:** Retry on next cron run
- **Configuration Errors:** User notification
- **Critical Errors:** Logged to file for investigation
- **Stop Loss Failures:** Continue execution, log error

## Security Considerations

### API Key Storage

- Stored in Redis with encryption support
- Never logged to files
- Transmitted only to exchange APIs

### User Data

- Only Telegram ID stored in logs
- No personal information
- No trading balances in logs

### Redis Security

- Password-protected connection
- Local network only
- Key prefixing for namespace isolation

## Performance Optimization

### Caching Strategy

- User data cached in Redis
- API credentials cached
- Configuration cached
- TTL not implemented (manual cleanup)

### Rate Limiting

- Binance: Handled by SDK
- OKX: Handled by API
- Bot: No internal rate limiting

### Async Operations

- All file I/O is async
- Non-blocking logging
- Parallel API calls where possible

## Deployment Considerations

### Dependencies

```json
{
  "@nestjs/core": "^10.x",
  "node-telegram-bot-api": "^0.x",
  "binance-api-node": "^0.x",
  "redis": "^4.x",
  "winston": "^3.x",
  "axios": "^1.x"
}
```

### System Requirements

- Node.js 18+
- Redis 6+
- 512MB RAM minimum
- 1GB disk space for logs

### Scaling

- Single instance (Telegram bot polling)
- Horizontal scaling not supported
- Redis can be clustered
- Logs can be shipped to external service

## Monitoring

### Health Checks

- Redis connection
- Telegram API connection
- Exchange API health

### Metrics to Monitor

- Error rate per exchange
- Re-entry success rate
- Average TP achievement time
- Cron job execution time

### Log Analysis

- Search by user ID
- Search by exchange
- Search by operation
- Time-based filtering

## Future Enhancements

### Planned Features

1. Multi-account support per exchange
2. Advanced TP strategies (trailing, multiple levels)
3. Position size calculator
4. Risk management tools
5. Performance analytics dashboard

### Technical Improvements

1. Database migration from Redis
2. WebSocket for real-time updates
3. Horizontal scaling support
4. Real-time monitoring dashboard
5. Automated backup system
