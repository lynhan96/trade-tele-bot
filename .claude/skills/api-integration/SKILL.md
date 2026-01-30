---
name: api-integration
description: Guide for integrating new exchange APIs or modifying existing exchange integrations. Use when adding support for new exchanges or updating API implementations.
---

# API Integration Guide

## Project Exchange Pattern

The bot uses separate modules for each exchange with similar structure.

### Module Structure

```
src/
├── binance/
│   ├── binance.module.ts    # Module definition
│   └── binance.service.ts   # API implementation
├── okx/
│   ├── okx.module.ts        # Module definition
│   └── okx.service.ts       # API implementation
```

## Adding a New Exchange

### Step 1: Create Exchange Module

Create directory: `src/your-exchange/`

**your-exchange.module.ts**:

```typescript
import { Module } from "@nestjs/common";
import { YourExchangeService } from "./your-exchange.service";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [RedisModule],
  providers: [YourExchangeService],
  exports: [YourExchangeService],
})
export class YourExchangeModule {}
```

### Step 2: Create Exchange Service

**your-exchange.service.ts**:

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { UserApiKeys } from "../interfaces/user.interface";

@Injectable()
export class YourExchangeService {
  private readonly logger = new Logger(YourExchangeService.name);

  constructor(private readonly redisService: RedisService) {}

  // Get API client for user
  private async getClient(telegramId: number) {
    const keys = await this.redisService.get<UserApiKeys>(
      `user:${telegramId}:keys:yourexchange`,
    );

    if (!keys) {
      throw new Error("API keys not configured");
    }

    // Initialize your exchange client
    return new YourExchangeClient({
      apiKey: keys.apiKey,
      apiSecret: keys.apiSecret,
      // ... other options
    });
  }

  // Required methods
  async getPositions(telegramId: number) {
    // Implementation
  }

  async getAccountBalance(telegramId: number) {
    // Implementation
  }

  async closeAllPositions(telegramId: number) {
    // Implementation
  }

  async validateKeys(apiKey: string, apiSecret: string): Promise<boolean> {
    // Implementation
  }
}
```

### Step 3: Update App Module

**src/app.module.ts**:

```typescript
import { YourExchangeModule } from "./your-exchange/your-exchange.module";

@Module({
  imports: [
    // ... existing imports
    YourExchangeModule,
    TelegramModule,
  ],
})
export class AppModule {}
```

### Step 4: Update Telegram Module

**src/telegram/telegram.module.ts**:

```typescript
import { YourExchangeModule } from "../your-exchange/your-exchange.module";

@Module({
  imports: [
    RedisModule,
    BinanceModule,
    OkxModule,
    YourExchangeModule, // Add here
  ],
  providers: [TelegramBotService],
})
export class TelegramModule {}
```

### Step 5: Update Telegram Service

**src/telegram/telegram.service.ts**:

1. Add to constructor:

```typescript
constructor(
  // ... existing services
  private yourExchangeService: YourExchangeService,
) {}
```

2. Update `getActiveExchange()` type:

```typescript
private async getActiveExchange(
  telegramId: number,
): Promise<"binance" | "okx" | "yourexchange" | null> {
  // ... existing logic
}
```

3. Add to command handlers:

```typescript
// In handleSetKeys
if (exchangeType === "yourexchange") {
  // Validate keys
  const isValid = await this.yourExchangeService.validateKeys(
    apiKey,
    apiSecret,
  );

  if (!isValid) {
    await this.bot.sendMessage(chatId, "❌ Invalid API keys");
    return;
  }

  // Store keys
  await this.redisService.set(`user:${telegramId}:keys:yourexchange`, {
    apiKey,
    apiSecret,
  });
}

// In handlePosition
if (exchange === "yourexchange") {
  const account = await this.yourExchangeService.getAccountBalance(telegramId);
  const positions = await this.yourExchangeService.getPositions(telegramId);
  // Format and send response
}

// In checkTakeProfitTargets (cron job)
if (exchange === "yourexchange") {
  const positions = await this.yourExchangeService.getPositions(telegramId);
  // Check TP logic
}
```

### Step 6: Update User Interface

**src/interfaces/user.interface.ts**:

```typescript
export interface UserActiveExchange {
  exchange: "binance" | "okx" | "yourexchange";
}
```

## Required Service Methods

Every exchange service should implement:

### 1. Get Positions

```typescript
async getPositions(telegramId: number): Promise<Position[]> {
  const client = await this.getClient(telegramId);
  const positions = await client.getPositions();

  // Normalize response format
  return positions.map(p => ({
    symbol: p.symbol,
    size: p.size,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    unrealizedPnl: p.pnl,
    side: p.side, // 'long' or 'short'
  }));
}
```

### 2. Get Account Balance

```typescript
async getAccountBalance(telegramId: number): Promise<Account> {
  const client = await this.getClient(telegramId);
  const account = await client.getAccount();

  return {
    totalBalance: account.balance,
    availableBalance: account.available,
    unrealizedPnl: account.unrealizedPnl,
  };
}
```

### 3. Close All Positions

```typescript
async closeAllPositions(telegramId: number): Promise<void> {
  const client = await this.getClient(telegramId);
  const positions = await this.getPositions(telegramId);

  for (const position of positions) {
    if (Math.abs(position.size) > 0) {
      await client.closePosition(position.symbol);
    }
  }
}
```

### 4. Validate API Keys

```typescript
async validateKeys(
  apiKey: string,
  apiSecret: string,
  passphrase?: string
): Promise<boolean> {
  try {
    const client = new YourExchangeClient({
      apiKey,
      apiSecret,
      passphrase,
    });

    // Try a simple API call
    await client.getAccount();
    return true;
  } catch (error) {
    this.logger.error(`Key validation failed: ${error.message}`);
    return false;
  }
}
```

## Exchange-Specific Considerations

### Binance

- Uses Futures API (Perpetual contracts)
- Symbol format: BTCUSDT, ETHUSDT
- Position amounts can be negative (short)
- Requires IP whitelist for security

**Key library**: `binance-api-node`

```typescript
import Binance from "binance-api-node";

const client = Binance({
  apiKey: keys.apiKey,
  apiSecret: keys.apiSecret,
});
```

### OKX

- Uses API v5
- Instrument type: SWAP (Perpetual)
- Position amounts always positive, check `posSide`
- Requires passphrase in addition to key/secret
- Uses REST + WebSocket

**Key library**: Custom fetch-based implementation

```typescript
const signature = this.generateSignature(
  timestamp + method + requestPath + body,
  apiSecret,
);

headers = {
  "OK-ACCESS-KEY": apiKey,
  "OK-ACCESS-SIGN": signature,
  "OK-ACCESS-TIMESTAMP": timestamp,
  "OK-ACCESS-PASSPHRASE": passphrase,
};
```

## Common Patterns

### Error Handling

```typescript
try {
  const result = await apiCall();
  return result;
} catch (error) {
  if (error.code === "INVALID_API_KEY") {
    throw new Error("Invalid API keys");
  } else if (error.code === "INSUFFICIENT_BALANCE") {
    throw new Error("Insufficient balance");
  } else {
    this.logger.error(`API Error: ${error.message}`, error.stack);
    throw new Error(`Exchange API error: ${error.message}`);
  }
}
```

### Rate Limiting

```typescript
private rateLimiter = {
  lastCall: 0,
  minInterval: 1000, // ms between calls
};

private async rateLimit() {
  const now = Date.now();
  const timeSinceLastCall = now - this.rateLimiter.lastCall;

  if (timeSinceLastCall < this.rateLimiter.minInterval) {
    await new Promise(resolve =>
      setTimeout(resolve, this.rateLimiter.minInterval - timeSinceLastCall)
    );
  }

  this.rateLimiter.lastCall = Date.now();
}
```

### Retry Logic

```typescript
async callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      this.logger.warn(`Retry ${i + 1}/${maxRetries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}
```

## Testing Exchange Integration

### 1. Test API Connection

```typescript
const isValid = await service.validateKeys(apiKey, apiSecret);
console.log("Keys valid:", isValid);
```

### 2. Test Position Fetching

```typescript
const positions = await service.getPositions(telegramId);
console.log("Positions:", positions);
```

### 3. Test Balance Query

```typescript
const balance = await service.getAccountBalance(telegramId);
console.log("Balance:", balance);
```

### 4. Test Error Cases

- Invalid API keys
- Network timeout
- Rate limit exceeded
- Insufficient permissions

## Documentation

Update these files when adding an exchange:

1. **README.md** - Add exchange to features list
2. **COMMANDS.md** - Update /setkeys examples
3. **OKX_INTEGRATION.md** - Or create similar for your exchange

## Security Considerations

1. ✅ Store API keys encrypted in Redis
2. ✅ Never log API keys or secrets
3. ✅ Validate keys before storing
4. ✅ Use read-only keys when possible
5. ✅ Implement rate limiting
6. ✅ Handle API errors gracefully
7. ✅ Use HTTPS for all API calls
8. ✅ Validate API responses
9. ✅ Implement request signing correctly
10. ✅ Document required API permissions
