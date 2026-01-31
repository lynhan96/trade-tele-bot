---
name: command-handler
description: Guide for adding, modifying, or debugging Telegram bot commands. Use when implementing new commands or fixing command-related issues.
---

# Command Handler Guide

## Adding a New Command

### Step 1: Register Command Pattern

In `src/telegram/telegram.service.ts`, add to `setupCommands()` method:

```typescript
private setupCommands() {
  // ... existing commands ...

  // Command: /yourcommand [args]
  this.bot.onText(/\/yourcommand(.*)/, async (msg, match) => {
    this.logger.debug(`Command /yourcommand from user ${msg.from.id}`);
    await this.handleYourCommand(msg, match);
  });
}
```

### Step 2: Create Handler Method

```typescript
private async handleYourCommand(
  msg: TelegramBot.Message,
  match: RegExpExecArray | null,
) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  // Ensure chatId is stored
  await this.ensureChatIdStored(telegramId, chatId);

  try {
    // 1. Parse arguments
    if (!match || !match[1]) {
      await this.bot.sendMessage(
        chatId,
        "❌ Usage: /yourcommand [args]\nExample: /yourcommand value"
      );
      return;
    }

    const args = match[1].trim().split(/\s+/);

    // 2. Validate input
    if (args.length < 1) {
      await this.bot.sendMessage(chatId, "❌ Missing required arguments");
      return;
    }

    // 3. Get active exchange
    const exchange = await this.getActiveExchange(telegramId);
    if (!exchange) {
      await this.bot.sendMessage(
        chatId,
        "❌ No exchange configured. Use /setkeys first."
      );
      return;
    }

    // 4. Execute your logic
    const result = await this.doSomething(telegramId, exchange, args);

    // 5. Send response
    await this.bot.sendMessage(
      chatId,
      `✅ Success!\n\nResult: ${result}`,
      { parse_mode: "Markdown" }
    );

  } catch (error) {
    await this.bot.sendMessage(
      chatId,
      `❌ Error: ${error.message}`
    );
    this.logger.error(
      `Error in handleYourCommand for user ${telegramId}:`,
      error.message
    );
  }
}
```

### Step 3: Update Help Commands

Add your command to:

1. `/start` message
2. `/accounts` message (if relevant)

```typescript
const helpMessage =
  "Available commands:\n" +
  "/yourcommand [args] - Your description\n" +
  // ... other commands ...
```

## Command Patterns

### Pattern 1: Simple Command (No Args)

```typescript
this.bot.onText(/\/command/, async (msg) => {
  // Handle command
});
```

### Pattern 2: Command with Required Args

```typescript
this.bot.onText(/\/command (.+)/, async (msg, match) => {
  // match[1] contains all arguments
  const args = match[1].trim().split(/\s+/);
});
```

### Pattern 3: Command with Optional Args

```typescript
this.bot.onText(/\/command(.*)/, async (msg, match) => {
  // match[1] might be empty
  const input = match[1]?.trim() || "";
});
```

### Pattern 4: Command with Multiline Input

```typescript
this.bot.onText(/\/command[\s\S]+/, async (msg, match) => {
  // Captures everything including newlines
});
```

### Pattern 5: Command with Flexible Format

```typescript
// Accepts both /set-account and /setaccount
this.bot.onText(/\/set-?account (.+)/, async (msg, match) => {
  // Handle either format
});
```

## Common Command Patterns

### Exchange-Specific Command

```typescript
private async handleExchangeCommand(
  msg: TelegramBot.Message,
  match: RegExpExecArray | null,
) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const exchange = await this.getActiveExchange(telegramId);
  if (!exchange) {
    await this.bot.sendMessage(chatId, "❌ No exchange configured.");
    return;
  }

  if (exchange === 'binance') {
    // Binance-specific logic
    const result = await this.binanceService.doSomething(telegramId);
  } else if (exchange === 'okx') {
    // OKX-specific logic
    const result = await this.okxService.doSomething(telegramId);
  }
}
```

### Data Storage Command

```typescript
private async handleStorageCommand(
  msg: TelegramBot.Message,
  match: RegExpExecArray | null,
) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  // Store data in Redis
  await this.redisService.set(`user:${telegramId}:data`, {
    value: someValue,
    timestamp: new Date().toISOString(),
  });

  await this.bot.sendMessage(chatId, "✅ Data saved!");
}
```

### Query Command

```typescript
private async handleQueryCommand(msg: TelegramBot.Message) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  // Retrieve data
  const data = await this.redisService.get(`user:${telegramId}:data`);

  if (!data) {
    await this.bot.sendMessage(chatId, "❌ No data found.");
    return;
  }

  await this.bot.sendMessage(
    chatId,
    `📊 Your Data:\n\nValue: ${data.value}\nSaved: ${data.timestamp}`
  );
}
```

## Input Validation

### Numeric Input

```typescript
const value = parseFloat(args[0]);
if (isNaN(value) || value <= 0) {
  await this.bot.sendMessage(chatId, "❌ Invalid number. Must be positive.");
  return;
}
```

### String Input

```typescript
const symbol = args[0].toUpperCase();
if (!/^[A-Z]+$/.test(symbol)) {
  await this.bot.sendMessage(chatId, "❌ Invalid symbol format.");
  return;
}
```

### Multiple Arguments

```typescript
if (args.length < 3) {
  await this.bot.sendMessage(
    chatId,
    "❌ Expected 3 arguments.\nUsage: /command arg1 arg2 arg3",
  );
  return;
}

const [arg1, arg2, arg3] = args;
```

### Optional Arguments

```typescript
const requiredArg = args[0];
const optionalArg = args[1] || "default-value";
```

## Error Handling

### Standard Error Pattern

```typescript
try {
  // Command logic
} catch (error) {
  await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  this.logger.error(`Error in handler: ${error.message}`, error.stack);
}
```

### User-Friendly Errors

```typescript
try {
  const result = await apiCall();
} catch (error) {
  let userMessage = "❌ Something went wrong.";

  if (error.code === "INVALID_API_KEY") {
    userMessage = "❌ Invalid API keys. Use /setkeys to update.";
  } else if (error.code === "INSUFFICIENT_BALANCE") {
    userMessage = "❌ Insufficient balance to execute this order.";
  }

  await this.bot.sendMessage(chatId, userMessage);
  this.logger.error(`API Error: ${error.message}`);
}
```

## Response Formatting

### Basic Text

```typescript
await this.bot.sendMessage(chatId, "Your message here");
```

### Markdown Formatting

```typescript
await this.bot.sendMessage(
  chatId,
  `*Bold Text*\n` +
    `_Italic Text_\n` +
    `\`Code\`\n` +
    `[Link](https://example.com)`,
  { parse_mode: "Markdown" },
);
```

### Structured Response

```typescript
const message =
  `📊 *Report*\n\n` +
  `Balance: $${balance.toFixed(2)}\n` +
  `PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
  `Positions: ${count}\n\n` +
  `_Last updated: ${new Date().toLocaleString()}_`;

await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
```

### Progress Indicators

```typescript
// Send initial message
const sentMsg = await this.bot.sendMessage(chatId, "⏳ Processing...");

// Do work
await doSomeLongTask();

// Update message
await this.bot.editMessageText("✅ Complete!", {
  chat_id: chatId,
  message_id: sentMsg.message_id,
});
```

## Testing Commands

### Manual Testing

1. Run bot: `npm run start:dev`
2. Open Telegram
3. Send command to bot
4. Check response and logs

### Test Invalid Input

```typescript
// Test these scenarios:
/command                    // Missing args
/command invalid            // Wrong format
/command 0                  // Invalid value (if number expected)
/command -1                 // Negative (if positive expected)
/command arg1 arg2 arg3 arg4  // Too many args
```

### Test Error Conditions

- No API keys set
- Invalid exchange selected
- Network errors
- Insufficient permissions

## Common Issues

### Issue 1: Command Not Triggering

**Cause**: Regex doesn't match
**Fix**: Check regex pattern, test with regex101.com

### Issue 2: "undefined" in Response

**Cause**: Accessing property that doesn't exist
**Fix**: Use optional chaining and defaults:

```typescript
const value = data?.property || "default";
```

### Issue 3: Command Triggered Multiple Times

**Cause**: Multiple regex patterns match the same input
**Fix**: Make patterns more specific, order them correctly

### Issue 4: Arguments Not Parsing

**Cause**: Regex capture group incorrect
**Fix**: Verify match[1] captures what you expect

## Best Practices

1. ✅ Always validate user input
2. ✅ Provide clear error messages
3. ✅ Use try-catch for all async operations
4. ✅ Log command execution for debugging
5. ✅ Store chat ID on first interaction
6. ✅ Check if exchange is configured before exchange operations
7. ✅ Use Markdown for formatted responses
8. ✅ Keep command handlers focused and small
9. ✅ Extract complex logic into separate methods
10. ✅ Document expected command format in help text
11. ✅ **Write a simulator test for every new command!**

## Testing Your Command

**IMPORTANT**: After implementing a command, add a test to the simulator!

### Add to Skills Simulator

File: `src/simulator/skills.simulator.ts`

```typescript
private testYourCommand(): TestResult {
  console.log("\n📊 TEST: Your Command");
  console.log("━".repeat(60));

  try {
    // Test 1: Valid command parsing
    const validCmd = "/yourcommand arg1 arg2";
    const match = validCmd.match(/\/yourcommand\s+(\S+)\s+(\S+)/);

    if (!match || match[1] !== "arg1") {
      throw new Error("Command parsing failed");
    }

    // Test 2: Invalid command (missing args)
    const invalidCmd = "/yourcommand";
    const invalidMatch = invalidCmd.match(/\/yourcommand\s+(\S+)\s+(\S+)/);

    if (invalidMatch) {
      throw new Error("Should reject incomplete command");
    }

    // Test 3: Validation logic
    const arg1 = parseInt(match[1]);
    if (arg1 < 1 || arg1 > 100) {
      throw new Error("Validation should reject out of range");
    }

    console.log("✅ Command parsing works");
    console.log("✅ Validation works");
    console.log("✅ Error cases handled");

    return {
      scenario: "Your Command",
      passed: true,
      details: "Command implementation validated",
    };
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return {
      scenario: "Your Command",
      passed: false,
      details: error.message,
    };
  }
}
```

### Add to Test Suite

In `runAllTests()` method:

```typescript
const results: TestResult[] = [
  this.testCommandParsing(),
  // ... other tests ...
  this.testYourCommand(), // 👈 Add here
];
```

### Run Tests

```bash
npm run test:skills
```

You should see:

```
✅ PASS - Your Command
   Command implementation validated
```

**See**: [Testing & Simulation Skill Guide](../testing-simulator/SKILL.md) for complete testing guide
