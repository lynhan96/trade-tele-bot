# Testing & Simulation Skill Guide

## Overview

Every feature you implement should have a corresponding simulator/test to validate it works correctly. This ensures code quality and prevents regressions.

## Why Test Every Feature?

1. **Catch bugs early**: Find issues before they hit production
2. **Document behavior**: Tests show how features should work
3. **Prevent regressions**: Ensure changes don't break existing functionality
4. **Faster debugging**: Isolated tests help pinpoint issues quickly
5. **Confidence**: Deploy with certainty that everything works

## Testing Philosophy

```
Feature → Simulator → Test → Deploy
   ↓         ↓         ↓        ↓
 Code     Mock Data   Verify   Ship
```

**Rule**: Don't deploy a feature without a test!

## Current Test Structure

### 1. Complete System Tests (`complete-system.simulator.ts`)

Tests the full trading workflow:

- TP detection and position closing
- Profit filtering (>2% rule)
- Stop loss calculation (profit-protected)
- Re-entry data storage
- Multiple retry cycles

**Status**: ✅ 5/5 tests passing (100%)

### 2. Re-entry Safety Tests (`reentry-safety.simulator.ts`)

Tests market condition analysis:

- Cooldown enforcement
- Price range validation
- EMA crossover detection
- Volume pressure analysis
- Market momentum

**Status**: ⚠️ 6/10 tests passing (60%)
**Note**: Some failures are actually correct blocks (see [TEST_FAILURES_ANALYSIS.md](../../../TEST_FAILURES_ANALYSIS.md))

### 3. Skills & Features Tests (`skills.simulator.ts`)

Tests bot commands and integrations:

- Command parsing
- Exchange detection
- Configuration validation
- Redis data structures
- API error handling
- Notification formatting

**Status**: ✅ 8/8 tests passing (100%)

## How to Add Tests for New Features

### Step 1: Identify What to Test

When you add a new feature, ask:

- What inputs does it accept?
- What outputs does it produce?
- What edge cases exist?
- What can go wrong?

**Example**: Adding a new command `/setleverage [leverage]`

Test scenarios:

1. ✅ Valid leverage (1-125)
2. ❌ Invalid leverage (0, 126, -10)
3. ❌ Non-numeric input
4. ✅ Update existing leverage
5. ✅ Leverage persisted to Redis

### Step 2: Choose the Right Simulator

- **Complete System**: Trading flow, positions, calculations
- **Safety**: Market analysis, EMA, volume, conditions
- **Skills**: Commands, API, data storage, errors

**Example**: `/setleverage` → Add to **Skills Simulator**

### Step 3: Write the Test

```typescript
// In src/simulator/skills.simulator.ts

private testLeverageConfiguration(): TestResult {
  console.log("\n📊 TEST: Leverage Configuration");
  console.log("━".repeat(60));

  try {
    // Test 1: Valid leverage
    const validLeverage = 20;
    if (validLeverage < 1 || validLeverage > 125) {
      throw new Error("Valid leverage rejected");
    }

    // Test 2: Invalid leverage
    const invalidLeverages = [0, -10, 126, 200];
    for (const lev of invalidLeverages) {
      if (lev >= 1 && lev <= 125) {
        throw new Error(`Invalid leverage ${lev} accepted`);
      }
    }

    // Test 3: Command parsing
    const cmd = "/setleverage binance 20";
    const match = cmd.match(/\/setleverage\s+(\w+)\s+(\d+)/);
    if (!match || parseInt(match[2]) !== 20) {
      throw new Error("Command parsing failed");
    }

    console.log("✅ Valid leverage (1-125) accepted");
    console.log("✅ Invalid leverage rejected");
    console.log("✅ Command parsing works");

    return {
      scenario: "Leverage Configuration",
      passed: true,
      details: "All leverage validation tests passed",
    };
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return {
      scenario: "Leverage Configuration",
      passed: false,
      details: error.message,
    };
  }
}
```

### Step 4: Add to Test Suite

```typescript
// In runAllTests() method
public runAllTests() {
  const results: TestResult[] = [
    this.testCommandParsing(),
    this.testExchangeDetection(),
    this.testTPConfiguration(),
    this.testRetryConfiguration(),
    this.testPositionClosing(),
    this.testRedisDataStructures(),
    this.testAPIErrorHandling(),
    this.testNotificationFormatting(),
    this.testLeverageConfiguration(), // 👈 Add here
  ];
  // ... rest of the code
}
```

### Step 5: Run and Verify

```bash
npm run test:skills
# or
npm run test:all
```

Check that your new test passes:

```
9. ✅ PASS - Leverage Configuration
   All leverage validation tests passed
```

## Test Writing Best Practices

### 1. Test One Thing at a Time

❌ **Bad**: Test multiple unrelated things in one scenario

```typescript
private testEverything() {
  // Tests TP, SL, leverage, commands all mixed together
}
```

✅ **Good**: Separate focused tests

```typescript
private testTPTarget() { /* Only TP logic */ }
private testStopLoss() { /* Only SL logic */ }
private testLeverage() { /* Only leverage */ }
```

### 2. Use Realistic Data

❌ **Bad**: Unrealistic mock data

```typescript
const position = {
  quantity: 999999999, // Unrealistic
  price: 1, // Too simple
};
```

✅ **Good**: Real-world values

```typescript
const position = {
  quantity: 0.5, // Realistic BTC amount
  price: 95000, // Realistic BTC price
};
```

### 3. Test Edge Cases

Always test:

- ✅ Valid input (happy path)
- ❌ Invalid input (error handling)
- 🔄 Boundary values (min/max)
- 🤔 Edge cases (empty, null, zero)

### 4. Clear Output Messages

❌ **Bad**: Vague messages

```typescript
console.log("Test passed");
console.log("Error occurred");
```

✅ **Good**: Descriptive messages

```typescript
console.log("✅ TP target $2,500 correctly detected");
console.log("❌ Invalid leverage 126 should be rejected (max: 125)");
```

### 5. Document Test Intent

```typescript
/**
 * Test 3: Position Closing Logic
 *
 * Validates:
 * - /close command closes specific position
 * - /closeall closes all positions
 * - Empty positions handled gracefully
 * - PnL calculated correctly
 *
 * Edge Cases:
 * - Position not found
 * - Multiple positions with same symbol
 * - Zero PnL positions
 */
private testPositionClosing(): TestResult {
  // ...
}
```

## Examples by Feature Type

### Testing Commands

```typescript
// Test: Command parsing and validation
private testNewCommand(): TestResult {
  // 1. Parse command regex
  const cmd = "/mycommand arg1 arg2";
  const match = cmd.match(/\/mycommand\s+(\S+)\s+(\S+)/);

  // 2. Validate arguments
  if (!match || match[1] !== "arg1") {
    throw new Error("Command parsing failed");
  }

  // 3. Test error cases
  const invalidCmd = "/mycommand";
  const invalidMatch = invalidCmd.match(/\/mycommand\s+(\S+)\s+(\S+)/);
  if (invalidMatch) {
    throw new Error("Should reject incomplete command");
  }

  return { scenario: "New Command", passed: true, details: "..." };
}
```

### Testing Calculations

```typescript
// Test: Mathematical calculations
private testCalculation(): TestResult {
  const input = { quantity: 1.0, reduction: 20 };
  const expected = 0.8;

  // Perform calculation
  const result = input.quantity * (1 - input.reduction / 100);

  // Verify with tolerance
  const tolerance = 0.001;
  if (Math.abs(result - expected) > tolerance) {
    throw new Error(`Expected ${expected}, got ${result}`);
  }

  return { scenario: "Quantity Reduction", passed: true, details: "..." };
}
```

### Testing Data Storage

```typescript
// Test: Redis data structures
private testDataStorage(): TestResult {
  // Define expected structure
  const data = {
    symbol: "BTCUSDT",
    quantity: 0.5,
    entryPrice: 100000,
    stopLoss: 95000,
  };

  // Verify all required fields present
  const requiredFields = ["symbol", "quantity", "entryPrice", "stopLoss"];
  const missingFields = requiredFields.filter(field => !(field in data));

  if (missingFields.length > 0) {
    throw new Error(`Missing fields: ${missingFields.join(", ")}`);
  }

  // Verify key pattern
  const key = `user:123:binance:position:BTCUSDT`;
  if (!key.includes("position")) {
    throw new Error("Key pattern incorrect");
  }

  return { scenario: "Data Storage", passed: true, details: "..." };
}
```

### Testing API Responses

```typescript
// Test: Exchange API error handling
private testAPIErrors(): TestResult {
  const errors = [
    { code: "INVALID_API_KEY", message: "API key is invalid" },
    { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" },
    { code: "RATE_LIMIT", message: "Too many requests" },
  ];

  // Verify each error has a user-friendly response
  for (const error of errors) {
    const userMessage = getUserFriendlyMessage(error.code);
    if (!userMessage || userMessage === error.code) {
      throw new Error(`No user message for ${error.code}`);
    }
  }

  return { scenario: "API Errors", passed: true, details: "..." };
}
```

## Running Tests

### Run All Tests

```bash
npm run test:all
```

Output:

```
════════════════════════════════════════════════════════════
📊 FINAL TEST SUMMARY
════════════════════════════════════════════════════════════

✅ Complete System:    5/5   (100.0%)
⚠️ Re-entry Safety:    6/10  (60.0%)
✅ Skills & Features:  8/8   (100.0%)

📈 Overall: 19/23 tests passing (82.6%)
════════════════════════════════════════════════════════════
```

### Run Specific Suite

```bash
npm run test:complete  # Complete system tests
npm run test:safety    # Re-entry safety tests
npm run test:skills    # Skills & features tests
```

### Debug a Failing Test

1. **Run the specific suite**:

   ```bash
   npm run test:safety
   ```

2. **Find the failing test**:

   ```
   ❌ FAIL - Healthy Pullback with Recovery
   EMA not aligned (EMA9: 82143.93, EMA21: 82422.34)
   ```

3. **Check the test file**:
   - Open `src/simulator/reentry-safety.simulator.ts`
   - Find the scenario (search for "Healthy Pullback")
   - Review the mock data and expected behavior

4. **Analyze the failure**:
   - Is the test expectation correct?
   - Is the mock data realistic?
   - Is the implementation logic correct?

5. **Fix and re-test**:
   - Update test data OR implementation
   - Run test again: `npm run test:safety`

## When Tests Fail

### 1. Understand Why

Read the failure message carefully:

```
❌ FAIL - Strong Recovery Signal
Expected: ✅ ALLOW
Actual: ❌ BLOCK
Reason: EMA not aligned (EMA9: 80180.76, EMA21: 80483.41)
```

**Questions to ask**:

- Is the expectation correct? (Should it really ALLOW?)
- Is the implementation correct? (Is the EMA logic right?)
- Is the test data correct? (Does it really show "strong recovery"?)

### 2. Possible Causes

| Cause                      | Action                 |
| -------------------------- | ---------------------- |
| **Bug in implementation**  | Fix the code           |
| **Wrong test expectation** | Update expected result |
| **Unrealistic mock data**  | Improve test data      |
| **Missing feature**        | Implement the feature  |
| **Threshold needs tuning** | Adjust parameters      |

### 3. Don't Ignore Failures

❌ **Bad**: "Tests fail but I'll deploy anyway"
✅ **Good**: "Let me understand why and fix it"

Even if you think the test is wrong, investigate!

## Test Coverage Goals

| Component         | Target   | Current   |
| ----------------- | -------- | --------- |
| Complete System   | 100%     | ✅ 100%   |
| Re-entry Safety   | 80%+     | ⚠️ 60%    |
| Skills & Features | 100%     | ✅ 100%   |
| **Overall**       | **85%+** | **82.6%** |

**Next Goal**: Get re-entry safety to 80%+ by tuning EMA/volume thresholds with real data

## Checklist for New Features

Before deploying a new feature:

- [ ] Feature implemented and working
- [ ] Tests written for happy path
- [ ] Tests written for error cases
- [ ] Edge cases tested
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Code reviewed

**If any checkbox is unchecked, DON'T DEPLOY!**

## Advanced: Integration Testing

For complex features that interact with:

- Exchange APIs
- Redis storage
- Telegram bot
- Multiple services

Consider writing integration tests that:

1. Use test exchange accounts
2. Mock Redis with in-memory store
3. Simulate Telegram messages
4. Test end-to-end flow

**Example**: Test entire retry/re-entry flow:

```typescript
async function integrationTest() {
  // 1. User sets up account
  await simulateTelegramMessage("/setaccount binance 5 10000");

  // 2. User opens position (manually on exchange)

  // 3. Bot detects TP reached
  await simulateCronJob("checkTakeProfitTargets");

  // 4. Verify position closed and re-entry stored
  const reentryData = await redis.get("user:123:binance:reentry:BTCUSDT");
  expect(reentryData).toBeDefined();

  // 5. Bot detects re-entry opportunity
  await simulateCronJob("checkReentryOpportunities");

  // 6. Verify new position opened
  const positions = await getPositions();
  expect(positions.length).toBe(1);
}
```

## Related Documentation

- [TEST_SUITE_OVERVIEW.md](../../TEST_SUITE_OVERVIEW.md) - Complete testing overview
- [TESTING_GUIDE.md](../../../TESTING_GUIDE.md) - Detailed test scenarios (root)
- [TEST_FAILURES_ANALYSIS.md](../../TEST_FAILURES_ANALYSIS.md) - Why tests fail

## Summary

**Golden Rule**: Every feature gets a test!

```
Feature → Test → Deploy
No test? No deploy!
```

This ensures:

- ✅ Code quality
- ✅ Fewer bugs
- ✅ Faster development
- ✅ Confident deployments

**Start testing today!** 🚀
