import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import TelegramBot = require("node-telegram-bot-api");
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { UserApiKeys } from "../interfaces/user.interface";

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private binanceService: BinanceService,
  ) {}

  async onModuleInit() {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

    if (!token) {
      this.logger.error(
        "TELEGRAM_BOT_TOKEN is not set in environment variables",
      );
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.logger.debug("Telegram bot initialized");

    this.setupCommands();
  }

  private setupCommands() {
    // Command: /start
    this.bot.onText(/\/start/, async (msg) => {
      this.logger.debug(`Command /start from user ${msg.from.id}`);
      await this.handleStart(msg);
    });

    // Command: /setkeys
    this.bot.onText(/\/setkeys[\s\S]+/, async (msg, match) => {
      this.logger.debug(`Command /setkeys from user ${msg.from.id}`);
      await this.handleSetKeys(msg, match);
    });

    // Command: /position
    this.bot.onText(/\/position/, async (msg) => {
      this.logger.debug(`Command /position from user ${msg.from.id}`);
      await this.handlePosition(msg);
    });

    // Command: /set-account <tp_percentage> <initial_balance>
    this.bot.onText(/\/set-account (.+)/, async (msg, match) => {
      this.logger.debug(`Command /set-account from user ${msg.from.id}`);
      await this.handleSetAccount(msg, match);
    });

    // Command: /cleartp
    this.bot.onText(/\/cleartp/, async (msg) => {
      this.logger.debug(`Command /cleartp from user ${msg.from.id}`);
      await this.handleClearTakeProfit(msg);
    });

    // Command: /update (manual trigger for testing)
    this.bot.onText(/\/update/, async (msg) => {
      this.logger.debug(`Command /update from user ${msg.from.id}`);
      await this.handleManualUpdate(msg);
    });
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  private async checkTakeProfitTargets() {
    try {
      // Get all users with TP set
      const keys = await this.redisService.keys("user:*:tp");

      for (const key of keys) {
        // Key format: binance-bot:user:{telegramId}:tp
        const parts = key.split(":");
        const telegramId = parts[2];
        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
        }>(`user:${telegramId}:tp`);

        if (!tpData) continue;

        const userData = await this.redisService.get<UserApiKeys>(
          `user:${telegramId}`,
        );
        if (!userData) continue;

        try {
          // First, check account balance to get unrealized PnL
          const balance = await this.binanceService.getAccountBalance(
            userData.apiKey,
            userData.apiSecret,
          );

          const unrealizedPnl = balance.totalUnrealizedProfit;
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          const profitPercentage =
            (unrealizedPnl / tpData.initialBalance) * 100;

          this.logger.debug(
            `User ${telegramId}: Unrealized PnL $${unrealizedPnl.toFixed(2)} / Target $${targetProfit.toFixed(2)} (${profitPercentage.toFixed(2)}% / ${tpData.percentage}%)`,
          );

          // If unrealized PnL reaches target, get positions and close them
          if (unrealizedPnl >= targetProfit) {
            this.logger.log(
              `TP Target reached for user ${telegramId}: Unrealized PnL $${unrealizedPnl.toFixed(2)}`,
            );

            // Now get positions to close them
            const positions = await this.binanceService.getOpenPositions(
              userData.apiKey,
              userData.apiSecret,
            );

            if (positions.length > 0) {
              // Close all positions
              await this.closeAllPositions(
                userData.apiKey,
                userData.apiSecret,
                positions,
              );
            }

            // Notify user using stored chatId
            this.logger.log(
              `Sending TP notification to user ${telegramId} (chatId: ${userData.chatId})`,
            );
            await this.bot.sendMessage(
              userData.chatId,
              `🎯 *Take Profit Target Reached!*\n\n` +
                `Target: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n` +
                `Target Profit: $${targetProfit.toFixed(2)}\n` +
                `Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n` +
                `Total Balance: $${balance.totalBalance.toFixed(2)}\n\n` +
                `✅ All positions have been closed!`,
              { parse_mode: "Markdown" },
            );
          }
        } catch (error) {
          this.logger.error(
            `Error checking TP for user ${telegramId}:`,
            error.message,
          );
        }
      }
    } catch (error) {
      this.logger.error("Error in checkTakeProfitTargets:", error.message);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  private async sendPeriodicUpdates() {
    this.logger.log(
      "========== Running sendPeriodicUpdates cron job ==========",
    );
    try {
      // Get all users with TP set
      const keys = await this.redisService.keys("user:*:tp");
      this.logger.log(
        `Found ${keys.length} users with TP set for periodic updates`,
      );

      for (const key of keys) {
        // Key format: binance-bot:user:{telegramId}:tp
        const parts = key.split(":");
        const telegramId = parts[2];
        this.logger.debug(`Processing periodic update for user ${telegramId}`);
        this.logger.debug(`Full key: ${key}`);

        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
        }>(`user:${telegramId}:tp`);

        if (!tpData) {
          this.logger.warn(`No TP data found for user ${telegramId}`);
          continue;
        }

        const userData = await this.redisService.get<UserApiKeys>(
          `user:${telegramId}`,
        );
        if (!userData) {
          this.logger.warn(`No user data found for user ${telegramId}`);
          continue;
        }

        this.logger.debug(`User ${telegramId} has chatId: ${userData.chatId}`);

        try {
          // Get account balance
          this.logger.debug(`Fetching balance for user ${telegramId}`);
          const balance = await this.binanceService.getAccountBalance(
            userData.apiKey,
            userData.apiSecret,
          );

          const unrealizedPnl = balance.totalUnrealizedProfit;
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          const currentPercentage =
            (unrealizedPnl / tpData.initialBalance) * 100;
          const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

          this.logger.log(
            `User ${telegramId}: PnL=$${unrealizedPnl.toFixed(2)}, Target=$${targetProfit.toFixed(2)}, Progress=${currentPercentage.toFixed(2)}%`,
          );

          // Send periodic update using stored chatId
          this.logger.debug(`Sending message to chatId ${userData.chatId}`);
          await this.bot.sendMessage(
            userData.chatId,
            `${progressEmoji} *30-Minute Update*\n\n` +
              `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
              `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
              `🎯 TP Target Progress:\n` +
              `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
              `├ Current: ${currentPercentage.toFixed(2)}%\n` +
              `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`,
            { parse_mode: "Markdown" },
          );

          this.logger.log(
            `✅ Successfully sent periodic update to user ${telegramId} (chatId: ${userData.chatId})`,
          );
        } catch (error) {
          this.logger.error(
            `Error sending periodic update to user ${telegramId}:`,
            error.message,
          );
        }
      }
    } catch (error) {
      this.logger.error("Error in sendPeriodicUpdates:", error.message);
    }
  }

  private async closeAllPositions(
    apiKey: string,
    apiSecret: string,
    positions: any[],
  ) {
    this.logger.log(`Closing ${positions.length} positions`);

    for (const position of positions) {
      try {
        await this.binanceService.closePosition(
          apiKey,
          apiSecret,
          position.symbol,
          position.quantity,
          position.side,
        );
        this.logger.log(`Closed position: ${position.symbol}`);
      } catch (error) {
        this.logger.error(`Error closing ${position.symbol}:`, error.message);
      }
    }
  }

  private async ensureChatIdStored(
    telegramId: number,
    chatId: number,
  ): Promise<void> {
    try {
      const userData = await this.redisService.get<UserApiKeys>(
        `user:${telegramId}`,
      );

      if (userData && !userData.chatId) {
        this.logger.log(
          `Updating user ${telegramId} with missing chatId: ${chatId}`,
        );
        userData.chatId = chatId;
        await this.redisService.set(`user:${telegramId}`, userData);
        this.logger.log(`✅ ChatId stored for user ${telegramId}`);
      }
    } catch (error) {
      this.logger.error(
        `Error ensuring chatId for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleStart(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    const userExists = await this.redisService.exists(`user:${telegramId}`);

    if (userExists) {
      // Ensure chatId is stored for existing users
      await this.ensureChatIdStored(telegramId, chatId);

      await this.bot.sendMessage(
        chatId,
        "✅ You are already registered!\n\n" +
          "Available commands:\n" +
          "/position - View all open positions and balance\n" +
          "/set-account <tp_%> <initial_balance> - Set TP target\n" +
          "/cleartp - Clear take profit target\n" +
          "/setkeys <api_key> <api_secret> - Update API keys",
      );
    } else {
      await this.bot.sendMessage(
        chatId,
        "👋 Welcome to Binance Trading Bot!\n\n" +
          "To get started, please set your Binance API keys:\n" +
          "/setkeys <your_api_key> <your_api_secret>\n\n" +
          "⚠️ Make sure your API key has Futures trading permissions enabled.",
      );
    }
  }

  private async handleSetKeys(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Extract keys from message text (handle both space-separated and newline-separated)
    const text = msg.text || "";
    const parts = text
      .replace("/setkeys", "")
      .trim()
      .split(/[\s\n]+/);

    if (parts.length < 2) {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid format. Use:\n/setkeys <api_key> <api_secret>\n\nYou can put them on the same line or separate lines.",
      );
      return;
    }

    const apiKey = parts[0];
    const apiSecret = parts[1];

    try {
      // Test the API keys
      this.logger.log(`Validating API keys for user ${telegramId}`);
      await this.binanceService.getAccountBalance(apiKey, apiSecret);

      // Store in Redis
      const userData: UserApiKeys = {
        telegramId,
        chatId,
        apiKey,
        apiSecret,
        createdAt: new Date().toISOString(),
      };

      await this.redisService.set(`user:${telegramId}`, userData);
      this.logger.log(
        `Stored user data for ${telegramId} with chatId ${chatId}`,
      );

      // Delete the message containing API keys for security
      await this.bot.deleteMessage(chatId, msg.message_id);

      await this.bot.sendMessage(
        chatId,
        "✅ API keys saved successfully!\n\n" +
          "Your message has been deleted for security.\n\n" +
          "Available commands:\n" +
          "/position - View all open positions\n" +
          "/set-account <tp_%> <initial_balance> - Set TP target",
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid API keys or insufficient permissions.\n" +
          "Please check your keys and try again.",
      );
      this.logger.error(
        `Error validating API keys for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handlePosition(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const userData = await this.redisService.get<UserApiKeys>(
        `user:${telegramId}`,
      );

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          "❌ You need to register first.\nUse /start to begin.",
        );
        return;
      }

      await this.bot.sendMessage(chatId, "⏳ Fetching your positions...");

      const [positions, balance] = await Promise.all([
        this.binanceService.getOpenPositions(
          userData.apiKey,
          userData.apiSecret,
        ),
        this.binanceService.getAccountBalance(
          userData.apiKey,
          userData.apiSecret,
        ),
      ]);

      if (positions.length === 0) {
        await this.bot.sendMessage(
          chatId,
          `📊 *Account Summary*\n\n` +
            `💰 Total Balance: $${balance.totalBalance.toFixed(2)}\n` +
            `💵 Available Balance: $${balance.availableBalance.toFixed(2)}\n\n` +
            `No open positions.`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      let message = `📊 *Open Positions*\n\n`;

      positions.forEach((pos, index) => {
        const pnlEmoji = pos.unrealizedPnl >= 0 ? "🟢" : "🔴";
        const pnlPercent = ((pos.unrealizedPnl / pos.margin) * 100).toFixed(2);

        message += `*${index + 1}. ${pos.symbol}* ${pos.side === "LONG" ? "📈" : "📉"}\n`;
        message += `├ Entry: $${pos.entryPrice.toFixed(4)}\n`;
        message += `├ Current: $${pos.currentPrice.toFixed(4)}\n`;
        message += `├ Quantity: ${pos.quantity}\n`;
        message += `├ Leverage: ${pos.leverage}x\n`;
        message += `├ Margin: $${pos.margin.toFixed(2)}\n`;
        message += `├ Volume: $${pos.volume.toFixed(2)}\n`;
        message += `├ PnL: ${pnlEmoji} $${pos.unrealizedPnl.toFixed(2)} (${pnlPercent}%)\n`;

        if (pos.takeProfit) {
          message += `├ TP: $${parseFloat(pos.takeProfit).toFixed(4)}\n`;
        } else {
          message += `├ TP: Not set\n`;
        }

        if (pos.stopLoss) {
          message += `├ SL: $${parseFloat(pos.stopLoss).toFixed(4)}\n`;
        } else {
          message += `├ SL: Not set\n`;
        }

        message += `└ Liq. Price: $${pos.liquidationPrice.toFixed(4)}\n\n`;
      });

      const totalPnl = positions.reduce(
        (sum, pos) => sum + pos.unrealizedPnl,
        0,
      );
      const totalPnlEmoji = totalPnl >= 0 ? "🟢" : "🔴";

      message += `💰 *Account Summary*\n`;
      message += `├ Total Balance: $${balance.totalBalance.toFixed(2)}\n`;
      message += `├ Available: $${balance.availableBalance.toFixed(2)}\n`;
      message += `└ Total Unrealized PnL: ${totalPnlEmoji} $${totalPnl.toFixed(2)}\n`;

      // Check if TP is set
      const tpData = await this.redisService.get<{
        percentage: number;
        initialBalance: number;
      }>(`user:${telegramId}:tp`);
      if (tpData) {
        const unrealizedPnl = balance.totalUnrealizedProfit;
        const targetProfit = (tpData.initialBalance * tpData.percentage) / 100;
        const currentPercentage = (unrealizedPnl / tpData.initialBalance) * 100;
        const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

        message += `\n${progressEmoji} *TP Target*\n`;
        message += `├ Target: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n`;
        message += `├ Target Profit: $${targetProfit.toFixed(2)}\n`;
        message += `├ Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n`;
        message += `└ Progress: ${currentPercentage.toFixed(2)}%\n`;
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        "❌ Error fetching positions. Please check your API keys.",
      );
      this.logger.error(
        `Error fetching positions for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleSetAccount(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const userData = await this.redisService.get<UserApiKeys>(
        `user:${telegramId}`,
      );

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          "❌ You need to register first.\nUse /start to begin.",
        );
        return;
      }

      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/set-account <tp_percentage> <initial_balance>\n\n" +
            "Example:\n/set-account 5 1000\n\n" +
            "This will close ALL positions when unrealized PnL reaches 5% of $1000",
        );
        return;
      }

      const args = match[1].trim().split(/\s+/);

      if (args.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please provide both TP percentage and initial balance.\n" +
            "Example: /set-account 5 1000",
        );
        return;
      }

      const percentage = parseFloat(args[0]);
      const initialBalance = parseFloat(args[1]);

      if (isNaN(percentage) || percentage <= 0) {
        await this.bot.sendMessage(chatId, "❌ Invalid percentage value.");
        return;
      }

      if (isNaN(initialBalance) || initialBalance <= 0) {
        await this.bot.sendMessage(chatId, "❌ Invalid initial balance value.");
        return;
      }

      const targetProfit = (initialBalance * percentage) / 100;

      // Store TP percentage and initial balance in Redis
      await this.redisService.set(`user:${telegramId}:tp`, {
        percentage,
        initialBalance,
        setAt: new Date().toISOString(),
      });

      await this.bot.sendMessage(
        chatId,
        `✅ *Account TP Target Set*\n\n` +
          `TP Percentage: ${percentage}%\n` +
          `Initial Balance: $${initialBalance.toFixed(2)}\n` +
          `Target Profit: $${targetProfit.toFixed(2)}\n\n` +
          `🤖 Bot will monitor unrealized PnL and close ALL positions when it reaches $${targetProfit.toFixed(2)}.\n\n` +
          `Use /cleartp to remove the target.`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error setting account target: ${error.message}`,
      );
      this.logger.error(
        `Error setting account TP for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleClearTakeProfit(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const userData = await this.redisService.get<UserApiKeys>(
        `user:${telegramId}`,
      );

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          "❌ You need to register first.\nUse /start to begin.",
        );
        return;
      }

      const tpExists = await this.redisService.exists(`user:${telegramId}:tp`);

      if (!tpExists) {
        await this.bot.sendMessage(chatId, "ℹ️ No take profit target is set.");
        return;
      }

      await this.redisService.delete(`user:${telegramId}:tp`);

      await this.bot.sendMessage(
        chatId,
        "✅ Take profit target has been cleared.",
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error clearing take profit: ${error.message}`,
      );
      this.logger.error(
        `Error clearing TP for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleManualUpdate(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const userData = await this.redisService.get<UserApiKeys>(
        `user:${telegramId}`,
      );

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          "❌ You need to register first.\nUse /start to begin.",
        );
        return;
      }

      const tpData = await this.redisService.get<{
        percentage: number;
        initialBalance: number;
      }>(`user:${telegramId}:tp`);

      if (!tpData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No take profit target set. Use /set-account first.",
        );
        return;
      }

      // Get account balance
      const balance = await this.binanceService.getAccountBalance(
        userData.apiKey,
        userData.apiSecret,
      );

      const unrealizedPnl = balance.totalUnrealizedProfit;
      const targetProfit = (tpData.initialBalance * tpData.percentage) / 100;
      const currentPercentage = (unrealizedPnl / tpData.initialBalance) * 100;
      const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

      await this.bot.sendMessage(
        chatId,
        `${progressEmoji} *Manual Update*\n\n` +
          `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
          `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
          `🎯 TP Target Progress:\n` +
          `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
          `├ Current: ${currentPercentage.toFixed(2)}%\n` +
          `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error getting update: ${error.message}`,
      );
      this.logger.error(
        `Error in manual update for user ${telegramId}:`,
        error.message,
      );
    }
  }
}
