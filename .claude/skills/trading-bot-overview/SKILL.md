---
name: trading-bot-overview
description: Understanding the Binance-Telegram trading bot architecture, components, and how they work together. Use when asked about the project structure, module relationships, or how the bot works.
---

# Trading Bot Overview

## Project Purpose

This is a NestJS-based Telegram bot that monitors trading positions on Binance and OKX exchanges, automatically closing positions when take-profit targets are reached.

## Architecture

### Core Modules

1. **Telegram Module** (`src/telegram/`)
   - Handles all user interactions via Telegram bot
   - Command handlers for user input
   - Scheduled jobs for monitoring and updates

2. **Binance Module** (`src/binance/`)
   - Integrates with Binance Futures API
   - Position management and account queries
   - Market order execution

3. **OKX Module** (`src/okx/`)
   - Integrates with OKX API v5
   - SWAP contract position management
   - Market order execution

4. **Redis Module** (`src/redis/`)
   - Stores user API keys (encrypted)
   - Stores user settings (TP targets, active exchange)
   - Session management

## Key Features

### Multi-Exchange Support

- Users can connect both Binance and OKX accounts
- Switch between exchanges with `/switch` command
- Separate configuration per exchange

### Take Profit Monitoring

- Users set TP target: percentage of initial balance
- Bot checks every 30 seconds
- Automatically closes ALL positions when target is reached
- Works independently on each connected exchange

### User Commands

```
/start              - Initialize bot
/setkeys            - Set API keys for an exchange
/accounts           - List connected accounts
/switch [exchange]  - Switch active exchange
/position           - View current positions and PnL
/setaccount [%] [balance] - Set TP target
/cleartp            - Remove TP target
/update             - Manual status update
```

## Data Flow

### 1. User Setup

```
User → /setkeys → Redis (store keys) → Exchange validation
```

### 2. Position Monitoring

```
Cron Job (30s) → Get active users → For each exchange:
  → Fetch positions → Calculate PnL → Check TP target
  → If reached: Close all positions → Notify user
```

### 3. Manual Updates

```
User → /position → Get active exchange → Fetch data
  → Format response → Send to user
```

## Key Files

- **src/app.module.ts** - Main application module, imports all modules
- **src/main.ts** - Application bootstrap, starts NestJS server
- **src/telegram/telegram.service.ts** - Core bot logic (1100+ lines)
- **src/binance/binance.service.ts** - Binance API integration
- **src/okx/okx.service.ts** - OKX API integration
- **src/redis/redis.service.ts** - Redis data operations

## Common Patterns

### Exchange Abstraction

The bot doesn't have a common exchange interface. Instead, it uses conditional logic:

```typescript
if (exchange === "binance") {
  // Binance-specific code
} else if (exchange === "okx") {
  // OKX-specific code
}
```

### User Data Storage

Redis keys follow pattern: `user:{telegramId}:{dataType}`

Examples:

- `user:123456:keys:binance` - Binance API keys
- `user:123456:keys:okx` - OKX API keys
- `user:123456:tp` - TP target configuration
- `user:123456:active` - Active exchange selection
- `user:123456:chatId` - Telegram chat ID

## Development Workflow

1. **Add new feature**: Modify telegram.service.ts command handlers
2. **Add exchange support**: Create new module, integrate in telegram service
3. **Add monitoring**: Use `@Cron()` decorator in telegram service
4. **Debug**: Check logs with `this.logger.debug()` calls

## Testing

Run the bot:

```bash
npm run start:dev
```

Interact via Telegram to test features.

## Related Skills

- [debugging-guide](../debugging-guide/SKILL.md) - For fixing bugs
- [api-integration](../api-integration/SKILL.md) - For adding new exchanges
- [command-handler](../command-handler/SKILL.md) - For adding new commands
