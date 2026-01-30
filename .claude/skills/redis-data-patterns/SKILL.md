---
name: redis-data-patterns
description: Data storage patterns and Redis key structures used in the trading bot. Use when working with user data, settings, or debugging storage issues.
---

# Redis Data Patterns

## Overview

The bot uses Redis for persistent storage of:

- User API keys (encrypted)
- User settings and preferences
- Active exchange selection
- Take profit targets
- Telegram chat IDs

## Key Naming Convention

Pattern: `user:{telegramId}:{dataType}:{subType?}`

### User API Keys

**Binance Keys**:

```
Key: user:123456:keys:binance
Value: {
  apiKey: string,
  apiSecret: string
}
```

**OKX Keys**:

```
Key: user:123456:keys:okx
Value: {
  apiKey: string,
  apiSecret: string,
  passphrase: string
}
```

### Active Exchange

```
Key: user:123456:active
Value: {
  exchange: "binance" | "okx",
  switchedAt: "2026-01-30T10:30:00.000Z"
}
```

### Take Profit Target

**Exchange-Specific (New)**:

```
Key: user:123456:tp:binance
Value: {
  percentage: number,        // e.g., 5 for 5%
  initialBalance: number,    // e.g., 1000
  setAt: "2026-01-30T10:30:00.000Z"
}

Key: user:123456:tp:okx
Value: {
  percentage: number,        // e.g., 3 for 3%
  initialBalance: number,    // e.g., 2000
  setAt: "2026-01-30T10:30:00.000Z"
}
```

> **Note**: TP targets are now exchange-specific. Each exchange can have its own TP target percentage and initial balance. The legacy `user:{id}:tp` format (without exchange suffix) is deprecated.

### Chat ID Mapping

```
Key: user:123456:chatId
Value: number (e.g., 123456789)
```

## Service Methods

The `RedisService` provides these methods:

### Set Data

```typescript
await this.redisService.set(key, value);

// Example
await this.redisService.set(`user:${telegramId}:tp`, {
  percentage: 5,
  initialBalance: 1000,
  setAt: new Date().toISOString(),
});
```

### Get Data

```typescript
const data = await this.redisService.get<Type>(key);

// Example
const tpData = await this.redisService.get<{
  percentage: number;
  initialBalance: number;
}>(`user:${telegramId}:tp`);
```

### Delete Data

```typescript
await this.redisService.del(key);

// Example
await this.redisService.del(`user:${telegramId}:tp`);
```

### Check Existence

```typescript
const exists = await this.redisService.exists(key);

// Example
const hasBinanceKeys = await this.redisService.exists(
  `user:${telegramId}:keys:binance`,
);
```

### Get All Users with Pattern

```typescript
const keys = await this.redisService.keys("user:*:tp");
// Returns: ['user:123456:tp', 'user:789012:tp', ...]
```

## Common Patterns

### Pattern 1: Check and Store

```typescript
// Check if user has keys
const existingKeys = await this.redisService.get(
  `user:${telegramId}:keys:binance`,
);

if (existingKeys) {
  // Keys already exist, ask to overwrite
} else {
  // Store new keys
  await this.redisService.set(`user:${telegramId}:keys:binance`, {
    apiKey,
    apiSecret,
  });
}
```

### Pattern 2: Get with Default

```typescript
// Get active exchange, fallback to first available
let exchange = await this.redisService.get<UserActiveExchange>(
  `user:${telegramId}:active`,
);

if (!exchange) {
  // Check for Binance keys
  const hasBinance = await this.redisService.exists(
    `user:${telegramId}:keys:binance`,
  );

  if (hasBinance) {
    exchange = { exchange: "binance" };
  }
}
```

### Pattern 3: Update Specific Field

```typescript
// Get existing data
const data = await this.redisService.get(`user:${telegramId}:tp`);

// Update and save
await this.redisService.set(`user:${telegramId}:tp`, {
  ...data,
  percentage: newPercentage,
});
```

### Pattern 4: Batch Get Multiple Users

```typescript
// Get all users with TP targets
const tpKeys = await this.redisService.keys("user:*:tp");

for (const key of tpKeys) {
  const telegramId = key.split(":")[1]; // Extract ID from key
  const tpData = await this.redisService.get(key);

  // Process each user
}
```

### Pattern 5: Conditional Storage

```typescript
// Only store if doesn't exist
const exists = await this.redisService.exists(`user:${telegramId}:chatId`);

if (!exists) {
  await this.redisService.set(`user:${telegramId}:chatId`, chatId);
}
```

## Data Lifecycle

### User Onboarding

```
1. User sends /start
   → Store chatId

2. User sends /setkeys
   → Validate keys
   → Store in user:{id}:keys:{exchange}
   → Set as active if first exchange

3. User sends /setaccount
   → Store in user:{id}:tp
```

### Active Usage

```
1. Cron job runs every 30s
   → Get all keys matching user:*:tp
   → For each user:
     - Get active exchange
     - Fetch positions
     - Check TP target
     - Close if reached

2. User requests /position
   → Get active exchange from user:{id}:active
   → Get keys from user:{id}:keys:{exchange}
   → Fetch and display data
```

### Exchange Switching

```
1. User sends /switch okx
   → Verify keys exist in user:{id}:keys:okx
   → Update user:{id}:active
```

## Querying Data

### Find All Users

```bash
redis-cli KEYS "user:*"
```

### Find Users with Binance Keys

```bash
redis-cli KEYS "user:*:keys:binance"
```

### Get User's TP Target

```bash
redis-cli GET "user:123456:tp"
```

### Count Active Users

```bash
redis-cli KEYS "user:*:tp" | wc -l
```

## Data Migration

### Rename Key Pattern

```typescript
const oldKeys = await this.redisService.keys("user:*:oldpattern");

for (const oldKey of oldKeys) {
  const value = await this.redisService.get(oldKey);
  const newKey = oldKey.replace(":oldpattern", ":newpattern");

  await this.redisService.set(newKey, value);
  await this.redisService.del(oldKey);
}
```

### Add Field to Existing Data

```typescript
const tpKeys = await this.redisService.keys("user:*:tp");

for (const key of tpKeys) {
  const data = await this.redisService.get(key);

  // Add new field
  await this.redisService.set(key, {
    ...data,
    newField: defaultValue,
  });
}
```

## Debugging Redis Issues

### Check Connection

```bash
redis-cli ping
# Expected: PONG
```

### View All Keys

```bash
redis-cli KEYS "*"
```

### View Key Type

```bash
redis-cli TYPE "user:123456:tp"
# Expected: string (stores JSON)
```

### Delete Test Data

```bash
redis-cli DEL "user:123456:tp"
```

### Flush All Data (DANGEROUS)

```bash
redis-cli FLUSHALL
```

## Best Practices

1. ✅ Always use consistent key patterns
2. ✅ Include timestamp in time-sensitive data
3. ✅ Use TypeScript interfaces for type safety
4. ✅ Handle missing keys gracefully
5. ✅ Don't store large objects (keep under 1MB)
6. ✅ Use meaningful key names
7. ✅ Document new key patterns
8. ✅ Consider key expiration for temporary data
9. ✅ Batch operations when possible
10. ✅ Test with missing/corrupted data

## Security Notes

- API keys should be encrypted before storage
- Never log Redis data containing sensitive info
- Use secure Redis connection in production
- Implement access control on Redis server
- Regular backups of Redis data
- Consider Redis AUTH password
