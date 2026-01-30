---
name: debugging-guide
description: Step-by-step guide for debugging common issues in the trading bot. Use when investigating errors, unexpected behavior, or when tests fail.
---

# Debugging Guide

## Common Issues & Solutions

### 1. "Invalid percentage value" Error

**Symptom**: User gets error when using `/setaccount` or `/set-account` command

**Root Cause**: Command regex mismatch

**Location**: [src/telegram/telegram.service.ts](../../src/telegram/telegram.service.ts)

**Check**:

```typescript
// Find this line (around line 70):
this.bot.onText(/\/setaccount (.+)/, async (msg, match) => {
```

**Problem**: Regex expects `/setaccount` (no hyphen) but docs show `/set-account` (with hyphen)

**Solution**: Update regex to accept both:

```typescript
this.bot.onText(/\/set-?account (.+)/, async (msg, match) => {
```

### 2. Position Not Closing Automatically

**Symptom**: TP target reached but positions not closing

**Debug Steps**:

1. **Check if TP target is set**

```bash
# In Redis CLI or code
redis.get('user:{telegramId}:tp')
```

2. **Check if cron job is running**

```typescript
// In telegram.service.ts, find:
@Cron(CronExpression.EVERY_30_SECONDS)
async checkTakeProfitTargets()
```

3. **Check logs for errors**

```bash
# Look for error logs in console
grep "Error checking TP" logs
```

4. **Verify API keys are valid**

```typescript
// Test exchange connection
const account = await this.binanceService.getFuturesAccount(telegramId);
```

5. **Check position amounts**

```typescript
// Positions with 0 amount are filtered out
const activePositions = positions.filter(
  (p) => Math.abs(parseFloat(p.positionAmt || "0")) > 0,
);
```

### 3. API Key Errors

**Symptom**: "Invalid API keys" or "Signature verification failed"

**Common Causes**:

- Keys have trailing/leading spaces
- Wrong exchange selected (Binance keys used for OKX or vice versa)
- Keys don't have required permissions
- IP whitelist restrictions

**Debug**:

1. Check stored keys in Redis (they're encrypted)
2. Verify permissions on exchange:
   - Binance: Futures trading, Read account info
   - OKX: Trade, Read
3. Test with simple API call:

```typescript
const account = await service.getFuturesAccount(telegramId);
console.log("Account Balance:", account.totalWalletBalance);
```

### 4. Exchange Switch Not Working

**Symptom**: Bot still uses old exchange after `/switch`

**Check**:

1. Verify active exchange is stored:

```typescript
const active = await this.redisService.get(`user:${telegramId}:active`);
console.log("Active exchange:", active.exchange);
```

2. Ensure both exchanges have keys:

```bash
redis.get('user:{telegramId}:keys:binance')
redis.get('user:{telegramId}:keys:okx')
```

### 5. Redis Connection Issues

**Symptom**: "Connection refused" or "Redis is not available"

**Check**:

1. Verify Redis is running:

```bash
redis-cli ping
# Should return: PONG
```

2. Check connection settings in `.env`:

```
REDIS_HOST=localhost
REDIS_PORT=6379
```

3. Test connection:

```typescript
await this.redisService.set("test", { data: "value" });
const result = await this.redisService.get("test");
```

## Debugging Techniques

### 1. Add Strategic Logs

```typescript
// Before API call
this.logger.debug(`Fetching positions for user ${telegramId} on ${exchange}`);

// After calculation
this.logger.debug(`PnL: ${pnl}, Target: ${target}, Reached: ${pnl >= target}`);

// In error handler
this.logger.error(`Failed to close positions: ${error.message}`, error.stack);
```

### 2. Use TypeScript's Type System

```typescript
// Add explicit types to catch errors
const position: {
  symbol: string;
  positionAmt: string;
  unRealizedProfit: string;
} = await getPosition();
```

### 3. Test Exchange Calls Independently

Create a test script:

```typescript
// test/test-exchange.ts
import { BinanceService } from "../src/binance/binance.service";

async function test() {
  const service = new BinanceService(/* deps */);
  const positions = await service.getFuturesPositions(telegramId);
  console.log("Positions:", positions);
}
```

### 4. Check Scheduled Jobs

Verify cron expressions are correct:

```typescript
@Cron(CronExpression.EVERY_30_SECONDS)  // Check TP
@Cron('0 */10 * * * *')                 // Every 10 minutes
```

### 5. Validate User Input

Always check user input format:

```typescript
const percentage = parseFloat(args[0]);
if (isNaN(percentage) || percentage <= 0) {
  // Return helpful error message
  await this.bot.sendMessage(
    chatId,
    "❌ Invalid percentage. Example: /setaccount 5 1000",
  );
  return;
}
```

## Error Patterns

### Pattern 1: Undefined Property Access

```typescript
// Bad
const pnl = position.unRealizedProfit;

// Good
const pnl = parseFloat(position.unRealizedProfit || "0");
```

### Pattern 2: Missing Error Handlers

```typescript
// Always wrap API calls in try-catch
try {
  const result = await exchangeAPI.call();
} catch (error) {
  this.logger.error(`API call failed: ${error.message}`);
  await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
}
```

### Pattern 3: Race Conditions

```typescript
// Multiple cron jobs might process same user simultaneously
// Solution: Use Redis locks or check/set atomic operations
```

## Performance Issues

### Slow Response Times

- Check if too many API calls in sequence
- Use Promise.all() for parallel calls:

```typescript
const [binanceData, okxData] = await Promise.all([
  this.binanceService.getPositions(id),
  this.okxService.getPositions(id),
]);
```

### Memory Leaks

- Ensure event listeners are cleaned up
- Check for unclosed connections
- Monitor with: `process.memoryUsage()`

## Quick Debug Checklist

- [ ] Check environment variables are set
- [ ] Verify Redis is running
- [ ] Confirm API keys are valid and have permissions
- [ ] Look at error logs
- [ ] Test with simple API call
- [ ] Verify regex patterns match expected input
- [ ] Check cron jobs are triggering
- [ ] Validate user input parsing
- [ ] Ensure proper error handling exists
- [ ] Confirm TypeScript types are correct
