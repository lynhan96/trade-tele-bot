import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import TelegramBot = require("node-telegram-bot-api");
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { OkxService } from "../okx/okx.service";
import { UserApiKeys, UserActiveExchange } from "../interfaces/user.interface";

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private binanceService: BinanceService,
    private okxService: OkxService,
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

    // Command: /setkeys - now with exchange type
    this.bot.onText(/\/setkeys[\s\S]+/, async (msg, match) => {
      this.logger.debug(`Command /setkeys from user ${msg.from.id}`);
      await this.handleSetKeys(msg, match);
    });

    // Command: /accounts - list all connected accounts
    this.bot.onText(/\/accounts/, async (msg) => {
      this.logger.debug(`Command /accounts from user ${msg.from.id}`);
      await this.handleListAccounts(msg);
    });

    // Command: /position
    this.bot.onText(/\/position/, async (msg) => {
      this.logger.debug(`Command /position from user ${msg.from.id}`);
      await this.handlePosition(msg);
    });

    // Command: /set-account [exchange] [tp_percentage] [initial_balance]
    this.bot.onText(/\/setaccount (.+)/, async (msg, match) => {
      this.logger.debug(`Command /set-account from user ${msg.from.id}`);
      await this.handleSetAccount(msg, match);
    });

    // Command: /cleartp [exchange]
    this.bot.onText(/\/cleartp(.*)/, async (msg, match) => {
      this.logger.debug(`Command /cleartp from user ${msg.from.id}`);
      await this.handleClearTakeProfit(msg, match);
    });

    // Command: /update [exchange] (manual trigger for testing)
    this.bot.onText(/\/update(.*)/, async (msg, match) => {
      this.logger.debug(`Command /update from user ${msg.from.id}`);
      await this.handleManualUpdate(msg, match);
    });

    // Command: /closeall [exchange] - close all positions
    this.bot.onText(/\/closeall(.*)/, async (msg, match) => {
      this.logger.debug(`Command /closeall from user ${msg.from.id}`);
      await this.handleCloseAllPositions(msg, match);
    });

    // Command: /close [exchange] [symbol] - close specific position
    this.bot.onText(/\/close (.+)/, async (msg, match) => {
      this.logger.debug(`Command /close from user ${msg.from.id}`);
      await this.handleClosePosition(msg, match);
    });
  }

  // Helper: Get active exchange for a user (defaults to first found if not set)
  private async getActiveExchange(
    telegramId: number,
  ): Promise<"binance" | "okx" | null> {
    const activeData = await this.redisService.get<UserActiveExchange>(
      `user:${telegramId}:active`,
    );

    if (activeData) {
      return activeData.exchange;
    }

    // If no active exchange is set, check which accounts exist
    const binanceExists = await this.redisService.exists(
      `user:${telegramId}:binance`,
    );
    const okxExists = await this.redisService.exists(`user:${telegramId}:okx`);

    // Default to binance if it exists, otherwise okx
    if (binanceExists) return "binance";
    if (okxExists) return "okx";
    return null;
  }

  // Helper: Set active exchange for a user
  private async setActiveExchange(
    telegramId: number,
    exchange: "binance" | "okx",
  ): Promise<void> {
    await this.redisService.set(`user:${telegramId}:active`, {
      exchange,
      setAt: new Date().toISOString(),
    });
  }

  // Helper: Get user data for a specific exchange
  private async getUserData(
    telegramId: number,
    exchange: "binance" | "okx",
  ): Promise<UserApiKeys | null> {
    return await this.redisService.get<UserApiKeys>(
      `user:${telegramId}:${exchange}`,
    );
  }

  // Helper: Get user data for active exchange
  private async getActiveUserData(
    telegramId: number,
  ): Promise<UserApiKeys | null> {
    const activeExchange = await this.getActiveExchange(telegramId);
    if (!activeExchange) return null;
    return await this.getUserData(telegramId, activeExchange);
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  private async checkTakeProfitTargets() {
    try {
      // Get all users with TP set (exchange-specific)
      const keys = await this.redisService.keys("user:*:tp:*");

      for (const key of keys) {
        // Key format: binance-bot:user:{telegramId}:tp:{exchange}
        const parts = key.split(":");
        const telegramId = parts[2];
        const exchange = parts[4] as "binance" | "okx";

        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
        }>(`user:${telegramId}:tp:${exchange}`);

        if (!tpData) continue;

        const userData = await this.getUserData(parseInt(telegramId), exchange);
        if (!userData) continue;

        // Check account based on exchange
        if (exchange === "binance") {
          try {
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
              `User ${telegramId} (BINANCE): Unrealized PnL $${unrealizedPnl.toFixed(2)} / Target $${targetProfit.toFixed(2)} (${profitPercentage.toFixed(2)}% / ${tpData.percentage}%)`,
            );

            if (unrealizedPnl >= targetProfit) {
              this.logger.log(
                `TP Target reached for user ${telegramId} (BINANCE): Unrealized PnL $${unrealizedPnl.toFixed(2)}`,
              );

              const positions = await this.binanceService.getOpenPositions(
                userData.apiKey,
                userData.apiSecret,
              );

              if (positions.length > 0) {
                await this.closeAllPositions(userData, positions);
              }

              await this.bot.sendMessage(
                userData.chatId,
                `🎯 *Take Profit Target Reached! (BINANCE)*\n\n` +
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
              `Error checking TP for user ${telegramId} (BINANCE):`,
              error.message,
            );
          }
        }

        // Check OKX account
        if (exchange === "okx") {
          try {
            const balance = await this.okxService.getAccountBalance(
              userData.apiKey,
              userData.apiSecret,
              userData.passphrase,
            );

            const unrealizedPnl = balance.totalUnrealizedProfit;
            const targetProfit =
              (tpData.initialBalance * tpData.percentage) / 100;
            const profitPercentage =
              (unrealizedPnl / tpData.initialBalance) * 100;

            this.logger.debug(
              `User ${telegramId} (OKX): Unrealized PnL $${unrealizedPnl.toFixed(2)} / Target $${targetProfit.toFixed(2)} (${profitPercentage.toFixed(2)}% / ${tpData.percentage}%)`,
            );

            if (unrealizedPnl >= targetProfit) {
              this.logger.log(
                `TP Target reached for user ${telegramId} (OKX): Unrealized PnL $${unrealizedPnl.toFixed(2)}`,
              );

              const positions = await this.okxService.getOpenPositions(
                userData.apiKey,
                userData.apiSecret,
                userData.passphrase,
              );

              if (positions.length > 0) {
                await this.closeAllPositions(userData, positions);
              }

              await this.bot.sendMessage(
                userData.chatId,
                `🎯 *Take Profit Target Reached! (OKX)*\n\n` +
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
              `Error checking TP for user ${telegramId} (OKX):`,
              error.message,
            );
          }
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
      // Get all users with TP set (exchange-specific)
      const keys = await this.redisService.keys("user:*:tp:*");
      this.logger.log(
        `Found ${keys.length} users with TP set for periodic updates`,
      );

      for (const key of keys) {
        // Key format: binance-bot:user:{telegramId}:tp:{exchange}
        const parts = key.split(":");
        const telegramId = parts[2];
        const exchange = parts[4] as "binance" | "okx";
        this.logger.debug(
          `Processing periodic update for user ${telegramId} (${exchange})`,
        );
        this.logger.debug(`Full key: ${key}`);

        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
        }>(`user:${telegramId}:tp:${exchange}`);

        if (!tpData) {
          this.logger.warn(
            `No TP data found for user ${telegramId} (${exchange})`,
          );
          continue;
        }

        const userData = await this.getUserData(parseInt(telegramId), exchange);
        if (!userData) {
          this.logger.warn(
            `No user data found for user ${telegramId} (${exchange})`,
          );
          continue;
        }

        // Send update based on exchange
        if (exchange === "binance") {
          try {
            this.logger.debug(
              `Fetching balance for user ${telegramId} (BINANCE)`,
            );
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
              `User ${telegramId} (BINANCE): PnL=$${unrealizedPnl.toFixed(2)}, Target=$${targetProfit.toFixed(2)}, Progress=${currentPercentage.toFixed(2)}%`,
            );

            await this.bot.sendMessage(
              userData.chatId,
              `${progressEmoji} *10-Minute Update (BINANCE)*\n\n` +
                `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
                `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
                `🎯 TP Target Progress:\n` +
                `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
                `├ Current: ${currentPercentage.toFixed(2)}%\n` +
                `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`,
              { parse_mode: "Markdown" },
            );

            this.logger.log(
              `✅ Successfully sent periodic update to user ${telegramId} (BINANCE)`,
            );
          } catch (error) {
            this.logger.error(
              `Error sending periodic update to user ${telegramId} (BINANCE):`,
              error.message,
            );
          }
        }

        // Send update for OKX
        if (exchange === "okx") {
          try {
            this.logger.debug(`Fetching balance for user ${telegramId} (OKX)`);
            const balance = await this.okxService.getAccountBalance(
              userData.apiKey,
              userData.apiSecret,
              userData.passphrase,
            );

            const unrealizedPnl = balance.totalUnrealizedProfit;
            const targetProfit =
              (tpData.initialBalance * tpData.percentage) / 100;
            const currentPercentage =
              (unrealizedPnl / tpData.initialBalance) * 100;
            const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

            this.logger.log(
              `User ${telegramId} (OKX): PnL=$${unrealizedPnl.toFixed(2)}, Target=$${targetProfit.toFixed(2)}, Progress=${currentPercentage.toFixed(2)}%`,
            );

            await this.bot.sendMessage(
              userData.chatId,
              `${progressEmoji} *10-Minute Update (OKX)*\n\n` +
                `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
                `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
                `🎯 TP Target Progress:\n` +
                `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
                `├ Current: ${currentPercentage.toFixed(2)}%\n` +
                `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`,
              { parse_mode: "Markdown" },
            );

            this.logger.log(
              `✅ Successfully sent periodic update to user ${telegramId} (OKX)`,
            );
          } catch (error) {
            this.logger.error(
              `Error sending periodic update to user ${telegramId} (OKX):`,
              error.message,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error("Error in sendPeriodicUpdates:", error.message);
    }
  }

  private async closeAllPositions(userData: UserApiKeys, positions: any[]) {
    this.logger.log(`Closing ${positions.length} positions`);

    for (const position of positions) {
      try {
        if (userData.exchange === "okx") {
          await this.okxService.closePosition(
            userData.apiKey,
            userData.apiSecret,
            userData.passphrase,
            position.symbol,
            position.quantity,
            position.side,
          );
        } else {
          await this.binanceService.closePosition(
            userData.apiKey,
            userData.apiSecret,
            position.symbol,
            position.quantity,
            position.side,
          );
        }
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
      // Update chatId for all exchange accounts
      const binanceData = await this.getUserData(telegramId, "binance");
      const okxData = await this.getUserData(telegramId, "okx");

      if (binanceData && !binanceData.chatId) {
        this.logger.log(
          `Updating Binance account for user ${telegramId} with chatId: ${chatId}`,
        );
        binanceData.chatId = chatId;
        await this.redisService.set(`user:${telegramId}:binance`, binanceData);
      }

      if (okxData && !okxData.chatId) {
        this.logger.log(
          `Updating OKX account for user ${telegramId} with chatId: ${chatId}`,
        );
        okxData.chatId = chatId;
        await this.redisService.set(`user:${telegramId}:okx`, okxData);
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

    const binanceExists = await this.redisService.exists(
      `user:${telegramId}:binance`,
    );
    const okxExists = await this.redisService.exists(`user:${telegramId}:okx`);

    if (binanceExists || okxExists) {
      // Ensure chatId is stored for existing users
      await this.ensureChatIdStored(telegramId, chatId);

      const activeExchange = await this.getActiveExchange(telegramId);
      const tpData = activeExchange
        ? await this.redisService.get<{
            percentage: number;
            initialBalance: number;
          }>(`user:${telegramId}:tp:${activeExchange}`)
        : null;

      let accountInfo = "📊 *Your Accounts*\n\n";
      if (binanceExists) accountInfo += "✅ Binance connected\n";
      if (okxExists) accountInfo += "✅ OKX connected\n";
      accountInfo += `\n🟢 Active: *${activeExchange?.toUpperCase() || "None"}*\n`;

      if (tpData && activeExchange) {
        const targetProfit = (tpData.initialBalance * tpData.percentage) / 100;
        accountInfo += `📈 TP: ${tpData.percentage}% ($${targetProfit.toFixed(2)}) on ${activeExchange.toUpperCase()}\n`;
      } else {
        accountInfo += "📈 TP: Not set\n";
      }

      await this.bot.sendMessage(
        chatId,
        "👋 Welcome back!\n\n" +
          accountInfo +
          "\n*Commands:*\n" +
          "/position - View positions & PnL\n" +
          "/accounts - View configs & TP settings\n" +
          "/setaccount exchange % balance - Set TP target\n" +
          "/close exchange symbol - Close specific position\n" +
          "/closeall exchange - Close all positions\n" +
          "/cleartp exchange - Remove TP target\n" +
          "/update exchange - Get balance & TP progress\n" +
          "/setkeys exchange ... - Update API keys",
        { parse_mode: "Markdown" },
      );
    } else {
      await this.bot.sendMessage(
        chatId,
        "👋 Welcome to Crypto Trading Bot!\n\n" +
          "To get started, please set your API keys:\n\n" +
          "*For Binance:*\n" +
          "/setkeys binance [api_key] [api_secret]\n\n" +
          "*For OKX:*\n" +
          "/setkeys okx [api_key] [api_secret] [passphrase]\n\n" +
          "⚠️ Make sure your API key has Futures trading permissions enabled.",
        { parse_mode: "Markdown" },
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

    if (parts.length < 3) {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid format.\n\n" +
          "*For Binance:*\n" +
          "/setkeys binance <api_key> <api_secret>\n\n" +
          "*For OKX:*\n" +
          "/setkeys okx <api_key> <api_secret> <passphrase>\n\n" +
          "You can put them on the same line or separate lines.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const exchange = parts[0].toLowerCase() as "binance" | "okx";
    const apiKey = parts[1];
    const apiSecret = parts[2];
    const passphrase = parts[3]; // Only for OKX

    if (exchange !== "binance" && exchange !== "okx") {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid exchange. Please use 'binance' or 'okx'.",
      );
      return;
    }

    if (exchange === "okx" && !passphrase) {
      await this.bot.sendMessage(
        chatId,
        "❌ OKX requires a passphrase. Use:\n/setkeys okx <api_key> <api_secret> <passphrase>",
      );
      return;
    }

    try {
      // Test the API keys
      this.logger.log(
        `Validating ${exchange.toUpperCase()} API keys for user ${telegramId}`,
      );

      if (exchange === "okx") {
        await this.okxService.getAccountBalance(apiKey, apiSecret, passphrase);
      } else {
        await this.binanceService.getAccountBalance(apiKey, apiSecret);
      }

      // Store in Redis
      const userData: UserApiKeys = {
        telegramId,
        chatId,
        apiKey,
        apiSecret,
        passphrase: exchange === "okx" ? passphrase : undefined,
        exchange,
        createdAt: new Date().toISOString(),
      };

      await this.redisService.set(`user:${telegramId}:${exchange}`, userData);
      this.logger.log(
        `Stored ${exchange.toUpperCase()} user data for ${telegramId} with chatId ${chatId}`,
      );

      // Set as active exchange if it's the first or if switching
      const currentActive = await this.getActiveExchange(telegramId);
      if (!currentActive) {
        await this.setActiveExchange(telegramId, exchange);
        this.logger.log(
          `Set ${exchange.toUpperCase()} as active exchange for user ${telegramId}`,
        );
      }

      // Delete the message containing API keys for security
      await this.bot.deleteMessage(chatId, msg.message_id);

      await this.bot.sendMessage(
        chatId,
        `✅ ${exchange.toUpperCase()} API keys saved successfully!\n\n` +
          "Your message has been deleted for security.\n\n" +
          "*Quick Start:*\n" +
          "/position - View your positions\n" +
          `/set-account ${exchange} % balance - Set TP target\n` +
          `/close ${exchange} symbol - Close specific position\n` +
          "/accounts - View all settings\n\n" +
          `💡 Tip: Use /closeall ${exchange} to close all positions`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Invalid ${exchange.toUpperCase()} API keys or insufficient permissions.\n` +
          "Please check your keys and try again.",
      );
      this.logger.error(
        `Error validating ${exchange.toUpperCase()} API keys for user ${telegramId}:`,
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
      const binanceData = await this.getUserData(telegramId, "binance");
      const okxData = await this.getUserData(telegramId, "okx");

      if (!binanceData && !okxData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No accounts connected.\nUse /setkeys to connect an exchange.",
        );
        return;
      }

      await this.bot.sendMessage(chatId, "⏳ Fetching your positions...");

      let allMessages = [];

      // Fetch Binance positions if connected
      if (binanceData) {
        try {
          const [positions, balance] = await Promise.all([
            this.binanceService.getOpenPositions(
              binanceData.apiKey,
              binanceData.apiSecret,
            ),
            this.binanceService.getAccountBalance(
              binanceData.apiKey,
              binanceData.apiSecret,
            ),
          ]);

          const totalPnl = positions.reduce(
            (sum, pos) => sum + pos.unrealizedPnl,
            0,
          );

          let message = `🟢 *BINANCE*\nbabywatermelon đang có các vị thế:\n`;

          if (positions.length === 0) {
            message += `\nKhông có vị thế nào.\n\n`;
          } else {
            positions.forEach((pos) => {
              const sideText = pos.side === "LONG" ? "Long" : "Short";
              const profitEmoji = pos.unrealizedPnl > 0 ? "🟢" : "🔴";

              const tpValue = pos.takeProfit
                ? parseFloat(pos.takeProfit).toLocaleString("en-US", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 4,
                  })
                : "--";
              const slValue = pos.stopLoss
                ? parseFloat(pos.stopLoss).toLocaleString("en-US", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 4,
                  })
                : "--";

              message += `${profitEmoji} ${sideText} ${pos.symbol} x ${pos.leverage}\n`;
              message += `Entry: ${pos.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}\n`;
              message += `TP/SL: ${tpValue}/${slValue}\n`;
              message += `Volume: ${pos.volume.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT\n`;
              message += `Profit: ${pos.unrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT\n\n`;
            });
          }

          message += `Lãi/lỗ chưa ghi nhận: ${totalPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
          message += `Balance hiện tại: ${balance.totalBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          allMessages.push(message);
        } catch (error) {
          allMessages.push(
            `🟢 *BINANCE*\n❌ Error fetching positions: ${error.message}`,
          );
          this.logger.error(
            `Error fetching Binance positions for user ${telegramId}:`,
            error.message,
          );
        }
      }

      // Fetch OKX positions if connected
      if (okxData) {
        try {
          const [positions, balance] = await Promise.all([
            this.okxService.getOpenPositions(
              okxData.apiKey,
              okxData.apiSecret,
              okxData.passphrase,
            ),
            this.okxService.getAccountBalance(
              okxData.apiKey,
              okxData.apiSecret,
              okxData.passphrase,
            ),
          ]);

          const totalPnl = positions.reduce(
            (sum, pos) => sum + pos.unrealizedPnl,
            0,
          );

          let message = `🟠 *OKX*\nbabywatermelon đang có các vị thế:\n`;

          if (positions.length === 0) {
            message += `\nKhông có vị thế nào.\n\n`;
          } else {
            positions.forEach((pos) => {
              const sideText = pos.side === "LONG" ? "Long" : "Short";
              const profitEmoji = pos.unrealizedPnl > 0 ? "🟢" : "🔴";

              const tpValue = pos.takeProfit
                ? parseFloat(pos.takeProfit).toLocaleString("en-US", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 4,
                  })
                : "--";
              const slValue = pos.stopLoss
                ? parseFloat(pos.stopLoss).toLocaleString("en-US", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 4,
                  })
                : "--";

              message += `${profitEmoji} ${sideText} ${pos.symbol} x ${pos.leverage}\n`;
              message += `Entry: ${pos.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}\n`;
              message += `TP/SL: ${tpValue}/${slValue}\n`;
              message += `Volume: ${pos.volume.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT\n`;
              message += `Profit: ${pos.unrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT\n\n`;
            });
          }

          message += `Lãi/lỗ chưa ghi nhận: ${totalPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
          message += `Balance hiện tại: ${balance.totalBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          allMessages.push(message);
        } catch (error) {
          allMessages.push(
            `🟠 *OKX*\n❌ Error fetching positions: ${error.message}`,
          );
          this.logger.error(
            `Error fetching OKX positions for user ${telegramId}:`,
            error.message,
          );
        }
      }

      // Send all messages
      for (const message of allMessages) {
        await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      }
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        "❌ Error fetching positions. Please try again.",
      );
      this.logger.error(
        `Error in handlePosition for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleListAccounts(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      const binanceData = await this.getUserData(telegramId, "binance");
      const okxData = await this.getUserData(telegramId, "okx");
      const activeExchange = await this.getActiveExchange(telegramId);

      if (!binanceData && !okxData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No accounts connected.\nUse /setkeys to connect an exchange.",
        );
        return;
      }

      let message = "📋 *Your Connected Accounts*\n\n";

      if (binanceData) {
        const isActive = activeExchange === "binance";
        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
          setAt: string;
        }>(`user:${telegramId}:tp:binance`);

        message += `${isActive ? "🟢" : "⚪"} *Binance*\n`;
        message += `├ Created: ${new Date(binanceData.createdAt).toLocaleDateString()}\n`;

        if (tpData) {
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          message += `├ TP Config: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n`;
          message += `└ TP Target: $${targetProfit.toFixed(2)}\n\n`;
        } else {
          message += `└ TP Config: Not set\n\n`;
        }
      }

      if (okxData) {
        const isActive = activeExchange === "okx";
        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
          setAt: string;
        }>(`user:${telegramId}:tp:okx`);

        message += `${isActive ? "🟢" : "⚪"} *OKX*\n`;
        message += `├ Created: ${new Date(okxData.createdAt).toLocaleDateString()}\n`;

        if (tpData) {
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          message += `├ TP Config: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n`;
          message += `└ TP Target: $${targetProfit.toFixed(2)}\n\n`;
        } else {
          message += `└ TP Config: Not set\n\n`;
        }
      }

      message += `Active Exchange: *${activeExchange?.toUpperCase() || "None"}*\n\n`;
      message +=
        "Use /set-account [exchange] to configure TP for each exchange.";

      await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        "❌ Error fetching accounts information.",
      );
      this.logger.error(
        `Error listing accounts for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleSwitchExchange(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    if (!match || match.length < 2) {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid format. Use:\n/switch [exchange]\n\nExample:\n/switch binance\n/switch okx",
      );
      return;
    }

    const exchange = match[1].toLowerCase() as "binance" | "okx";

    if (exchange !== "binance" && exchange !== "okx") {
      await this.bot.sendMessage(
        chatId,
        "❌ Invalid exchange. Please use 'binance' or 'okx'.",
      );
      return;
    }

    try {
      const userData = await this.getUserData(telegramId, exchange);

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          `❌ ${exchange.toUpperCase()} account not found.\nUse /setkeys ${exchange} to connect.`,
        );
        return;
      }

      await this.setActiveExchange(telegramId, exchange);

      await this.bot.sendMessage(
        chatId,
        `✅ Switched to *${exchange.toUpperCase()}*\n\n` +
          `All commands now operate on this exchange.\n\n` +
          `*What you can do:*\n` +
          `/position - View ${exchange.toUpperCase()} positions\n` +
          `/set-account % balance - Set ${exchange.toUpperCase()} TP target\n` +
          `/accounts - See all exchange configs`,
        { parse_mode: "Markdown" },
      );

      this.logger.log(
        `User ${telegramId} switched to ${exchange.toUpperCase()}`,
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error switching to ${exchange.toUpperCase()}.`,
      );
      this.logger.error(
        `Error switching exchange for user ${telegramId}:`,
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
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/set-account exchange % balance\n\n" +
            "Examples:\n/set-account binance 5 1000\n/set-account okx 10 2000\n\n" +
            "This will set TP target for the specified exchange.",
          { parse_mode: "Markdown" },
        );
        return;
      }

      const args = match[1].trim().split(/\s+/);

      if (args.length < 3) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please provide exchange, TP percentage and initial balance.\n" +
            "Example: /set-account binance 5 1000",
        );
        return;
      }

      const exchange = args[0].toLowerCase() as "binance" | "okx";
      const percentage = parseFloat(args[1]);
      const initialBalance = parseFloat(args[2]);

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      const userData = await this.getUserData(telegramId, exchange);
      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          `❌ ${exchange.toUpperCase()} account not found.\nUse /setkeys ${exchange} to connect.`,
        );
        return;
      }

      if (isNaN(percentage) || percentage <= 0) {
        await this.bot.sendMessage(chatId, "❌ Invalid percentage value.");
        return;
      }

      if (isNaN(initialBalance) || initialBalance <= 0) {
        await this.bot.sendMessage(chatId, "❌ Invalid initial balance value.");
        return;
      }

      const targetProfit = (initialBalance * percentage) / 100;

      // Store TP percentage and initial balance in Redis (exchange-specific)
      await this.redisService.set(`user:${telegramId}:tp:${exchange}`, {
        percentage,
        initialBalance,
        setAt: new Date().toISOString(),
      });

      await this.bot.sendMessage(
        chatId,
        `✅ *TP Target Set for ${exchange.toUpperCase()}*\n\n` +
          `TP Percentage: ${percentage}%\n` +
          `Initial Balance: $${initialBalance.toFixed(2)}\n` +
          `Target Profit: $${targetProfit.toFixed(2)}\n\n` +
          `🤖 Bot will monitor ${exchange.toUpperCase()} account.\n` +
          `All positions will close when unrealized PnL ≥ $${targetProfit.toFixed(2)}\n\n` +
          `Use /cleartp ${exchange} to remove`,
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

  private async handleClearTakeProfit(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const args = match[1]?.trim();

      if (!args) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please specify exchange.\n\nExamples:\n/cleartp binance\n/cleartp okx",
        );
        return;
      }

      const exchange = args.toLowerCase() as "binance" | "okx";

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      const tpKey = `user:${telegramId}:tp:${exchange}`;
      const tpExists = await this.redisService.exists(tpKey);

      if (!tpExists) {
        await this.bot.sendMessage(
          chatId,
          `ℹ️ No take profit target is set for ${exchange.toUpperCase()}.`,
        );
        return;
      }

      await this.redisService.delete(tpKey);

      await this.bot.sendMessage(
        chatId,
        `✅ Take profit target for ${exchange.toUpperCase()} has been cleared.`,
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

  private async handleManualUpdate(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const args = match[1]?.trim();

      if (!args) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please specify exchange.\n\nExamples:\n/update binance\n/update okx",
        );
        return;
      }

      const exchange = args.toLowerCase() as "binance" | "okx";

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      const tpData = await this.redisService.get<{
        percentage: number;
        initialBalance: number;
      }>(`user:${telegramId}:tp:${exchange}`);

      if (!tpData) {
        await this.bot.sendMessage(
          chatId,
          `❌ No take profit target set for ${exchange.toUpperCase()}. Use /set-account first.`,
        );
        return;
      }

      const userData = await this.getUserData(telegramId, exchange);
      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          `❌ No ${exchange.toUpperCase()} account data found.`,
        );
        return;
      }

      // Get balance based on exchange
      if (exchange === "binance") {
        try {
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

          await this.bot.sendMessage(
            chatId,
            `${progressEmoji} *Manual Update (BINANCE)*\n\n` +
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
            `📊 *BINANCE*\n❌ Error fetching balance: ${error.message}`,
            { parse_mode: "Markdown" },
          );
          this.logger.error(
            `Error fetching Binance balance for user ${telegramId}:`,
            error.message,
          );
        }
      } else if (exchange === "okx") {
        try {
          const balance = await this.okxService.getAccountBalance(
            userData.apiKey,
            userData.apiSecret,
            userData.passphrase,
          );

          const unrealizedPnl = balance.totalUnrealizedProfit;
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          const currentPercentage =
            (unrealizedPnl / tpData.initialBalance) * 100;
          const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

          await this.bot.sendMessage(
            chatId,
            `${progressEmoji} *Manual Update (OKX)*\n\n` +
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
            `📊 *OKX*\n❌ Error fetching balance: ${error.message}`,
            { parse_mode: "Markdown" },
          );
          this.logger.error(
            `Error fetching OKX balance for user ${telegramId}:`,
            error.message,
          );
        }
      }
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

  private async handleCloseAllPositions(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    await this.ensureChatIdStored(telegramId, chatId);

    try {
      const args = match[1]?.trim();

      if (!args) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please specify exchange.\n\nExamples:\n/closeall binance\n/closeall okx",
        );
        return;
      }

      const exchange = args.toLowerCase() as "binance" | "okx";

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      const userData = await this.getUserData(telegramId, exchange);
      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          `❌ ${exchange.toUpperCase()} account not found.\nUse /setkeys ${exchange} to connect.`,
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        `⏳ Fetching ${exchange.toUpperCase()} positions...`,
      );

      let positions;
      if (exchange === "binance") {
        positions = await this.binanceService.getOpenPositions(
          userData.apiKey,
          userData.apiSecret,
        );
      } else {
        positions = await this.okxService.getOpenPositions(
          userData.apiKey,
          userData.apiSecret,
          userData.passphrase,
        );
      }

      if (positions.length === 0) {
        await this.bot.sendMessage(
          chatId,
          `ℹ️ No open positions found on ${exchange.toUpperCase()}.`,
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        `🔄 Closing ${positions.length} position(s) on ${exchange.toUpperCase()}...`,
      );

      await this.closeAllPositions(userData, positions);

      await this.bot.sendMessage(
        chatId,
        `✅ Successfully closed all positions on ${exchange.toUpperCase()}!`,
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error closing positions: ${error.message}`,
      );
      this.logger.error(
        `Error in handleCloseAllPositions for user ${telegramId}:`,
        error.message,
      );
    }
  }

  private async handleClosePosition(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    await this.ensureChatIdStored(telegramId, chatId);

    try {
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/close exchange symbol\n\n" +
            "Examples:\n/close binance BTCUSDT\n/close okx BTC-USDT-SWAP",
        );
        return;
      }

      const args = match[1].trim().split(/\s+/);

      if (args.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please provide both exchange and symbol.\n" +
            "Example: /close binance BTCUSDT",
        );
        return;
      }

      const exchange = args[0].toLowerCase() as "binance" | "okx";
      const symbol = args[1].toUpperCase();

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      const userData = await this.getUserData(telegramId, exchange);
      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          `❌ ${exchange.toUpperCase()} account not found.\nUse /setkeys ${exchange} to connect.`,
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        `⏳ Fetching ${symbol} position on ${exchange.toUpperCase()}...`,
      );

      let positions;
      if (exchange === "binance") {
        positions = await this.binanceService.getOpenPositions(
          userData.apiKey,
          userData.apiSecret,
        );
      } else {
        positions = await this.okxService.getOpenPositions(
          userData.apiKey,
          userData.apiSecret,
          userData.passphrase,
        );
      }

      const position = positions.find((p) => p.symbol === symbol);

      if (!position) {
        await this.bot.sendMessage(
          chatId,
          `❌ Position ${symbol} not found on ${exchange.toUpperCase()}.\nUse /position to see open positions.`,
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        `🔄 Closing ${symbol} position on ${exchange.toUpperCase()}...`,
      );

      if (exchange === "okx") {
        await this.okxService.closePosition(
          userData.apiKey,
          userData.apiSecret,
          userData.passphrase,
          position.symbol,
          position.quantity,
          position.side,
        );
      } else {
        await this.binanceService.closePosition(
          userData.apiKey,
          userData.apiSecret,
          position.symbol,
          position.quantity,
          position.side,
        );
      }

      await this.bot.sendMessage(
        chatId,
        `✅ Successfully closed ${symbol} position on ${exchange.toUpperCase()}!\n\n` +
          `Side: ${position.side}\n` +
          `Entry: ${position.entryPrice.toFixed(4)}\n` +
          `PnL: ${position.unrealizedPnl.toFixed(2)} USDT`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error closing position: ${error.message}`,
      );
      this.logger.error(
        `Error in handleClosePosition for user ${telegramId}:`,
        error.message,
      );
    }
  }
}
