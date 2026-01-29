# Binance Telegram Bot

A NestJS-based Telegram bot to monitor and manage Binance Futures positions with automated take profit monitoring.

## Features

- 📊 View all open positions with detailed information
- 🎯 Set take profit targets based on total balance percentage
- 🤖 Automatic monitoring and position closing when TP target is reached
- 🔐 Secure API key storage in Redis (prefix: `binance-telebot`)
- 💰 Real-time balance and PnL tracking
- 👤 User-specific data isolation (by Telegram ID)

## Commands

- `/start` - Register and get started
- `/setkeys <api_key> <api_secret>` - Save your Binance API credentials
- `/position` - Show all open positions, TP target progress, and account balance
- `/tp <percentage>` - Set take profit target (e.g., `/tp 5` for 5% profit target)
- `/cleartp` - Remove the current take profit target

## How Take Profit Works

When you set a TP target using `/tp <percentage>`:

1. **Initial Balance Recorded**: Your current total balance is saved as the baseline
2. **Continuous Monitoring**: Bot checks every 10 seconds if your balance has reached the target
3. **Automatic Closure**: When `(current_balance - initial_balance) / initial_balance >= target_percentage`, ALL positions are closed automatically
4. **Notification**: You receive a detailed message when TP target is reached

**Example:**

- Initial Balance: $1000
- TP Target: 5%
- Target Balance: $1050
- When your balance reaches $1050 or more, all positions close automatically

## Setup

### Prerequisites

- Node.js (v18+)
- Redis server
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Binance API keys with Futures trading permissions

### Installation

1. **Install dependencies:**

```bash
npm install
```

2. **Configure environment:**

```bash
cp .env.example .env
```

Edit `.env` and add your configuration:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

3. **Start Redis:**

```bash
redis-server
```

4. **Run the bot:**

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Redis Data Structure

All data is stored with prefix `binance-telebot:`:

- `binance-telebot:user:{telegramId}` - User API keys and info
- `binance-telebot:user:{telegramId}:tp` - Take profit target data

## Position Display

When you use `/position`, you'll see:

```
📊 Open Positions

1. BTCUSDT 📈
├ Entry: $42500.0000
├ Current: $43200.0000
├ Quantity: 0.5
├ Leverage: 10x
├ Margin: $2125.00
├ Volume: $1062.50
├ PnL: 🟢 $350.00 (16.47%)
├ TP: Not set
├ SL: Not set
└ Liq. Price: $38000.0000

💰 Account Summary
├ Total Balance: $10350.00
├ Available: $8225.00
└ Total Unrealized PnL: 🟢 $350.00

🎯 TP Target
├ Target: 5%
├ Current: 3.5%
├ Initial: $10000.00
└ Profit: $350.00
```

## Security Notes

- ⚠️ API keys are stored in Redis - ensure Redis is properly secured
- 🔒 Messages containing API keys are automatically deleted
- 👤 Each user can only access their own data
- 🔐 Never share your bot token or API keys
- ✅ Recommend using API keys with IP whitelist and read-only for withdrawals

## Development

```bash
# Watch mode
npm run start:dev

# Build
npm run build

# Format code
npm run format
```

## Architecture

- **NestJS Framework**: Modular structure with dependency injection
- **Redis**: Fast key-value store for user data and TP targets
- **Telegram Bot API**: Real-time command handling and notifications
- **Binance API**: Futures trading data and position management
- **Monitoring Service**: Background job checking TP targets every 10 seconds

## License

ISC
