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
├── MongooseModule (Global, MongoDB)
├── RedisModule
├── BinanceModule
├── OkxModule
├── UserModule            ← persistent user settings (MongoDB)
├── TelegramModule        ← imports UserModule
└── SignalModule          ← imports TelegramModule, hosts TCP controller
```

## Data Flow

### 1. Bot Signal Auto-Trade Flow

```
bot-signal service
    ↓  TCP port 8010 (cmd: bot-receive-signal)
SignalController.handleSignal()
    ↓
TelegramBotService.handleIncomingSignal(signal)
    ↓  MongoDB: userSettingsService.findUsersWithBot(botType)
    For each user with signal.botType enabled:
        ↓
    executeSignalTrade(telegramId, exchange, signal, botConfig)
        ├→ getCurrentPrice()
        ├→ openPosition(symbol, side, qty, leverage)
        ├→ setStopLoss() [fire-and-forget]
        └→ Notify user via Telegram
```

### 2. User Command Flow

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
        Get Users with TP Config from MongoDB (findAllUsersWithTp)
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
Cron (30s) → checkReentryOpportunities()
                ↓
        Get All Pending Re-entries (SCAN)
                ↓
        For Each Re-entry:
                ↓
        ① Cooldown Check (30 min, pure math — NO API call)
                ↓ (passes)
        ② Get Current Price
                ↓
        ③ checkReentrySafety():
            - Price range (5–25% from entry)
            - EMA9/EMA21 alignment (30 klines)
            - Buy/sell volume pressure (last 20 candles)
                ↓ (all pass)
        executeReentry()
                ↓
        ┌───────┴───────┐
        ▼               ▼
    Open Position   Set Stop Loss
    (Reduced Volume) (At Previous TP)
        ▼
    Set Take Profit on Exchange
        ▼
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

### UserSettingsService

**Responsibilities:**

- Persistent user settings storage in MongoDB (`user_settings` collection)
- Single document per user (keyed by `telegramId`)

**Stored in MongoDB:**

```
user_settings collection (one document per user):
  telegramId, chatId, activeExchange, updatesDisabled
  binance/okx:
    apiKey, apiSecret, passphrase, createdAt
    tpPercentage, tpInitialBalance, tpSetAt
    tpMode, tpIndividualPercentage, tpIndividualSetAt
    bots[] (botType, enabled, volume, leverage, TP/SL %)
    retryMaxRetry, retryCurrentCount, retryVolumeReductionPercent, retryEnabled
    maxPositions
```

**Cron query helpers:**

- `findAllUsersWithTp()` — replaces Redis SCAN `user:*:tp:*`
- `findAllUsersWithBots()` — replaces Redis SCAN `user:*:bots:*`
- `findUsersWithBot(botType)` — replaces SCAN + filter loop

### RedisService

**Responsibilities:**

- Ephemeral position state (short-lived, position-scoped)
- Key-value operations

**Ephemeral Redis Keys (NOT migrated):**

```
user:{id}:reentry:{exchange}:{symbol} → Re-entry data (position lifecycle)
user:{id}:tpsl:{exchange}:{symbol}    → TP/SL prices for scheduler
user:{id}:opentime:{exchange}:{symbol} → Position open timestamp
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
- **Concurrency guard:** `processingLocks` Set prevents double-processing same user+exchange
- **Purpose:** Monitor unrealized PnL vs TP target
- **Actions:**
  - Fetch `retryConfig` once (reused for both re-entry storage and notification)
  - Close all profitable positions (> 2% profit) if target reached
  - Store re-entry data if retry enabled
  - Send notifications

### checkReentryOpportunities

- **Frequency:** Every 30 seconds
- **Purpose:** Check for re-entry conditions after TP
- **Order of checks (fail-fast, cheapest first):**
  1. Cooldown check — 30 min since close (pure date math, no API)
  2. Current price fetch
  3. Price range check (5–25% from original entry)
  4. EMA9/EMA21 alignment (30 × 15m klines)
  5. Volume pressure (>55% buy for LONG, >45% for SHORT)
- **On pass:** Execute re-entry, set SL + TP on exchange

### sendPeriodicUpdates

- **Frequency:** Every 5 minutes
- **Message label:** "5-Minute Update"
- **Purpose:** Send balance updates to users with TP configured
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

- Stored in MongoDB (`user_settings` collection, `binance.apiKey` / `okx.apiKey`)
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

- Persistent user settings in MongoDB (no TTL)
- Ephemeral position state in Redis (reentry, tpsl, opentime)
- Exchange API responses not cached (always fresh)

### Rate Limiting

- Binance: Handled by SDK
- OKX: Handled by API
- Bot: No internal rate limiting

### Async Operations

- All file I/O is async
- Non-blocking logging
- `/position` fetches Binance and OKX concurrently via top-level `Promise.all`
- `BinanceService.getOpenPositions`: all open orders fetched once, grouped by symbol (eliminates N+1 per-position calls)
- `BinanceService.getAccountBalance`: uses `futuresAccountInfo()` (1 call) — no secondary `getOpenPositions` call
- `OkxService.getAccountBalance`: uses `upl` field from balance response (1 call) — no secondary `getOpenPositions` call
- Redis `keys()` uses non-blocking SCAN cursor loop instead of blocking `KEYS` command

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

1. WebSocket for real-time updates
2. Horizontal scaling support
3. Real-time monitoring dashboard
4. Automated backup system
