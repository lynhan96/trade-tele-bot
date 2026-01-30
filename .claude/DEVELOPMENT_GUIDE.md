# Development Guide

## Getting Started

### Prerequisites
```bash
Node.js >= 18.0.0
Redis >= 6.0.0
npm >= 9.0.0
```

### Installation
```bash
# Clone repository
git clone <repo-url>
cd binance-tele-bot

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your credentials
```

### Environment Configuration
```env
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here
REDIS_HOST=localhost
REDIS_PORT=6379

# Optional
REDIS_PASSWORD=
LOG_LEVEL=info
```

### Running the Bot

**Development Mode:**
```bash
npm run start:dev
```

**Production Mode:**
```bash
npm run build
npm run start:prod
```

**Debug Mode:**
```bash
npm run start:debug
```

## Project Structure

```
src/
├── main.ts                 # Application entry point
├── app.module.ts           # Root module
│
├── binance/               # Binance integration
│   ├── binance.module.ts
│   └── binance.service.ts
│
├── okx/                   # OKX integration
│   ├── okx.module.ts
│   └── okx.service.ts
│
├── redis/                 # Redis client
│   ├── redis.module.ts
│   └── redis.service.ts
│
├── logger/                # File logging
│   ├── logger.module.ts
│   └── logger.service.ts
│
├── telegram/              # Main bot logic
│   ├── telegram.module.ts
│   └── telegram.service.ts
│
└── interfaces/            # TypeScript interfaces
    └── user.interface.ts
```

## Adding a New Command

### 1. Add Command Handler Registration

**File:** `src/telegram/telegram.service.ts`

```typescript
private setupCommands() {
  // ... existing commands ...
  
  // Add your new command
  this.bot.onText(/\/mycommand (.+)/, async (msg, match) => {
    await this.handleMyCommand(msg, match);
  });
}
```

### 2. Implement Handler Method

```typescript
private async handleMyCommand(
  msg: TelegramBot.Message,
  match: RegExpExecArray,
) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  // Ensure chat ID is stored
  await this.ensureChatIdStored(telegramId, chatId);
  
  try {
    // Parse arguments
    const args = match[1]?.trim().split(/\s+/);
    
    if (!args || args.length < 1) {
      await this.bot.sendMessage(
        chatId,
        "❌ Usage: /mycommand <argument>",
      );
      return;
    }
    
    // Get user data
    const userData = await this.getActiveUserData(telegramId);
    if (!userData) {
      await this.bot.sendMessage(
        chatId,
        "❌ Please set up your account first with /setkeys",
      );
      return;
    }
    
    // Your logic here
    const result = await this.doSomething(userData, args[0]);
    
    // Respond to user
    await this.bot.sendMessage(
      chatId,
      `✅ Success: ${result}`,
      { parse_mode: "Markdown" }
    );
    
  } catch (error) {
    await this.bot.sendMessage(
      chatId,
      `❌ Error: ${error.message}`,
    );
    
    // Log error to file
    this.fileLogger.logBusinessError(
      'handleMyCommand',
      error,
      telegramId,
      { args: args }
    );
  }
}
```

### 3. Add Helper Methods

```typescript
private async doSomething(
  userData: UserApiKeys,
  arg: string,
): Promise<string> {
  // Implement your logic
  // Call exchange services if needed
  // Return result
}
```

### 4. Update Command List

Add to `/start` command response:
```typescript
"/mycommand - Description of my command\n"
```

## Adding Exchange Integration

### 1. Create Exchange Module

**File:** `src/myexchange/myexchange.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { MyExchangeService } from './myexchange.service';

@Module({
  providers: [MyExchangeService],
  exports: [MyExchangeService],
})
export class MyExchangeModule {}
```

### 2. Create Exchange Service

**File:** `src/myexchange/myexchange.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class MyExchangeService {
  private readonly baseUrl = 'https://api.myexchange.com';
  
  async getAccountBalance(
    apiKey: string,
    apiSecret: string,
  ): Promise<{ totalBalance: number; totalUnrealizedProfit: number }> {
    // Implement API call
    const response = await axios.get(`${this.baseUrl}/account`, {
      headers: {
        'API-KEY': apiKey,
        // Add authentication
      }
    });
    
    return {
      totalBalance: response.data.balance,
      totalUnrealizedProfit: response.data.unrealizedPnl
    };
  }
  
  async getAllPositions(
    apiKey: string,
    apiSecret: string,
  ): Promise<any[]> {
    // Implement position fetching
  }
  
  async closePosition(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quantity: number,
    side: string,
  ): Promise<void> {
    // Implement position closing
  }
  
  async getCurrentPrice(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<number> {
    // Implement price fetching
  }
  
  async openPosition(
    apiKey: string,
    apiSecret: string,
    params: {
      symbol: string;
      side: string;
      quantity: number;
      leverage: number;
    },
  ): Promise<any> {
    // Implement position opening
  }
  
  async setStopLoss(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    stopPrice: number,
    side: string,
    quantity: number,
  ): Promise<void> {
    // Implement stop loss
  }
}
```

### 3. Register in App Module

**File:** `src/app.module.ts`

```typescript
import { MyExchangeModule } from './myexchange/myexchange.module';

@Module({
  imports: [
    // ... existing modules
    MyExchangeModule,
  ],
})
export class AppModule {}
```

### 4. Integrate in Telegram Service

```typescript
constructor(
  // ... existing services
  private myExchangeService: MyExchangeService,
) {}

// Add exchange checks in cron jobs
// Add exchange handling in commands
```

## Adding New Cron Job

### 1. Add Cron Method

```typescript
@Cron('0 */30 * * * *')  // Every 30 minutes
private async myScheduledTask() {
  try {
    // Your logic here
    
  } catch (error) {
    this.fileLogger.logError(error, {
      operation: 'myScheduledTask',
      type: 'CRON_ERROR',
    });
  }
}
```

### Cron Syntax
```
* * * * * *
│ │ │ │ │ │
│ │ │ │ │ └─ day of week (0-7) (0 or 7 is Sun)
│ │ │ │ └─── month (1-12)
│ │ │ └───── day of month (1-31)
│ │ └─────── hour (0-23)
│ └───────── minute (0-59)
└─────────── second (0-59, optional)
```

**Examples:**
- `'*/15 * * * * *'` - Every 15 seconds
- `'0 */5 * * * *'` - Every 5 minutes
- `'0 0 * * * *'` - Every hour
- `'0 0 0 * * *'` - Every day at midnight

### Pre-defined Expressions
```typescript
import { CronExpression } from '@nestjs/schedule';

@Cron(CronExpression.EVERY_30_SECONDS)
@Cron(CronExpression.EVERY_MINUTE)
@Cron(CronExpression.EVERY_5_MINUTES)
@Cron(CronExpression.EVERY_HOUR)
@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
```

## Redis Operations

### Storing Data
```typescript
await this.redisService.set(
  `user:${telegramId}:mydata`,
  { key: 'value' }
);
```

### Retrieving Data
```typescript
const data = await this.redisService.get<MyType>(
  `user:${telegramId}:mydata`
);
```

### Deleting Data
```typescript
await this.redisService.delete(
  `user:${telegramId}:mydata`
);
```

### Pattern Matching
```typescript
const keys = await this.redisService.keys(
  `user:${telegramId}:*`
);
```

### Checking Existence
```typescript
const exists = await this.redisService.exists(
  `user:${telegramId}:mydata`
);
```

## Error Logging

### API Error
```typescript
this.fileLogger.logApiError(
  'binance',                    // exchange
  'closePosition',              // operation
  error,                        // error object
  telegramId,                   // user ID
  'BTCUSDT',                    // symbol (optional)
);
```

### Business Error
```typescript
this.fileLogger.logBusinessError(
  'handleSetAccount',           // operation
  error,                        // error object
  telegramId,                   // user ID
  { exchange, percentage },     // additional data
);
```

### General Error
```typescript
this.fileLogger.logError(error, {
  operation: 'myOperation',
  type: 'CUSTOM_ERROR',
  customField: 'value',
});
```

## Testing

### Manual Testing
1. Set up test account on exchange testnet
2. Configure bot with test API keys
3. Run bot in development mode
4. Test commands via Telegram

### Testing Commands
```bash
# In Telegram, send:
/start
/setkeys binance <test_api_key> <test_api_secret>
/position
/setaccount binance 5 1000
# etc.
```

### Checking Logs
```bash
# Terminal 1: Run bot
npm run start:dev

# Terminal 2: Watch logs
tail -f logs/combined-$(date +%Y-%m-%d).log
```

### Redis Inspection
```bash
# Connect to Redis
redis-cli

# List all keys
keys binance-bot:*

# Get specific key
get binance-bot:user:123456789:api:binance

# Delete key (for testing)
del binance-bot:user:123456789:api:binance
```

## Debugging

### Enable Debug Logs
```env
LOG_LEVEL=debug
```

### VS Code Debug Configuration

**File:** `.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Bot",
      "runtimeArgs": [
        "-r",
        "ts-node/register",
        "-r",
        "tsconfig-paths/register"
      ],
      "args": ["${workspaceFolder}/src/main.ts"],
      "env": {
        "NODE_ENV": "development"
      },
      "sourceMaps": true,
      "cwd": "${workspaceFolder}",
      "protocol": "inspector",
      "console": "integratedTerminal"
    }
  ]
}
```

### Common Issues

**Issue:** Bot not responding
- Check `TELEGRAM_BOT_TOKEN` in .env
- Verify bot is running
- Check logs for errors

**Issue:** Redis connection failed
- Verify Redis is running: `redis-cli ping`
- Check `REDIS_HOST` and `REDIS_PORT`
- Verify Redis password if set

**Issue:** Exchange API errors
- Verify API keys are valid
- Check API permissions (futures trading enabled)
- Review rate limits

**Issue:** Cron jobs not running
- Check logs for cron execution
- Verify `ScheduleModule` imported
- Check system time/timezone

## Code Style

### TypeScript Guidelines
- Use strict mode
- Define interfaces for all data structures
- Use async/await (not callbacks)
- Handle all errors explicitly

### Naming Conventions
- **Services:** `MyService`
- **Modules:** `MyModule`
- **Interfaces:** `MyInterface`
- **Methods:** `camelCase`
- **Constants:** `UPPER_SNAKE_CASE`
- **Private methods:** `_privateMethod` or just `private`

### Comments
```typescript
// Use comments for complex logic
// Explain WHY, not WHAT

/**
 * JSDoc for public methods
 * @param telegramId User's Telegram ID
 * @returns Promise<UserData>
 */
async getUserData(telegramId: number): Promise<UserData> {
  // Implementation
}
```

## Deployment

### Build for Production
```bash
npm run build
```

### Run Production
```bash
npm run start:prod
```

### Using PM2 (Process Manager)
```bash
# Install PM2
npm install -g pm2

# Start bot
pm2 start dist/main.js --name binance-bot

# View logs
pm2 logs binance-bot

# Restart
pm2 restart binance-bot

# Stop
pm2 stop binance-bot
```

### Environment-specific Configs
```bash
# Development
cp .env.development .env

# Production
cp .env.production .env
```

## Performance Tips

1. **Minimize Redis calls** - Cache frequently accessed data
2. **Batch operations** - Group multiple Redis ops
3. **Async everything** - Don't block the event loop
4. **Error boundaries** - Catch errors early
5. **Monitor memory** - Watch for leaks in long-running processes

## Security Best Practices

1. **Never log secrets** - API keys, passwords
2. **Validate all input** - User commands, API responses
3. **Use environment variables** - For all configuration
4. **Encrypt sensitive data** - In Redis if possible
5. **Rate limit user commands** - Prevent abuse
6. **Sanitize messages** - Prevent injection attacks

## Contributing Guidelines

1. Create feature branch
2. Write descriptive commit messages
3. Test thoroughly
4. Update documentation
5. Submit PR with description

## Support & Resources

- NestJS Docs: https://docs.nestjs.com
- Telegram Bot API: https://core.telegram.org/bots/api
- Binance API: https://binance-docs.github.io/apidocs/futures/en/
- OKX API: https://www.okx.com/docs-v5/en/
- Redis Docs: https://redis.io/documentation
