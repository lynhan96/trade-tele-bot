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

    // Command: /switch [exchange] - switch active exchange
    this.bot.onText(/\/switch (.+)/, async (msg, match) => {
      this.logger.debug(`Command /switch from user ${msg.from.id}`);
      await this.handleSwitchExchange(msg, match);
    });

    // Command: /position
    this.bot.onText(/\/position/, async (msg) => {
      this.logger.debug(`Command /position from user ${msg.from.id}`);
      await this.handlePosition(msg);
    });

    // Command: /set-account [tp_percentage] [initial_balance]
    this.bot.onText(/\/setaccount (.+)/, async (msg, match) => {
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

        const binanceData = await this.getUserData(
          parseInt(telegramId),
          "binance",
        );
        const okxData = await this.getUserData(parseInt(telegramId), "okx");

        if (!binanceData && !okxData) continue;

        // Check Binance account
        if (binanceData) {
          try {
            const balance = await this.binanceService.getAccountBalance(
              binanceData.apiKey,
              binanceData.apiSecret,
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
                binanceData.apiKey,
                binanceData.apiSecret,
              );

              if (positions.length > 0) {
                await this.closeAllPositions(binanceData, positions);
              }

              await this.bot.sendMessage(
                binanceData.chatId,
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
        if (okxData) {
          try {
            const balance = await this.okxService.getAccountBalance(
              okxData.apiKey,
              okxData.apiSecret,
              okxData.passphrase,
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
                okxData.apiKey,
                okxData.apiSecret,
                okxData.passphrase,
              );

              if (positions.length > 0) {
                await this.closeAllPositions(okxData, positions);
              }

              await this.bot.sendMessage(
                okxData.chatId,
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

        const binanceData = await this.getUserData(
          parseInt(telegramId),
          "binance",
        );
        const okxData = await this.getUserData(parseInt(telegramId), "okx");

        if (!binanceData && !okxData) {
          this.logger.warn(`No user data found for user ${telegramId}`);
          continue;
        }

        // Send update for Binance if connected
        if (binanceData) {
          try {
            this.logger.debug(
              `Fetching balance for user ${telegramId} (BINANCE)`,
            );
            const balance = await this.binanceService.getAccountBalance(
              binanceData.apiKey,
              binanceData.apiSecret,
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
              binanceData.chatId,
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

        // Send update for OKX if connected
        if (okxData) {
          try {
            this.logger.debug(`Fetching balance for user ${telegramId} (OKX)`);
            const balance = await this.okxService.getAccountBalance(
              okxData.apiKey,
              okxData.apiSecret,
              okxData.passphrase,
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
              okxData.chatId,
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

      let accountInfo = "📊 *Your Accounts*\n\n";
      if (binanceExists) accountInfo += "✅ Binance connected\n";
      if (okxExists) accountInfo += "✅ OKX connected\n";

      await this.bot.sendMessage(
        chatId,
        "👋 Welcome back!\n\n" +
          accountInfo +
          "\n*Available Commands:*\n" +
          "/accounts - List all connected accounts\n" +
          "/switch [exchange] - Switch active exchange\n" +
          "/position - View positions (all accounts)\n" +
          "/set-account [tp_%] [balance] - Set TP target\n" +
          "/cleartp - Clear take profit target\n" +
          "/update - Manual update (all accounts)\n" +
          "/setkeys [exchange] ... - Add/update API keys",
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
          "Available commands:\n" +
          "/accounts - List all accounts\n" +
          "/switch [exchange] - Switch active exchange\n" +
          "/position - View positions\n" +
          "/set-account [tp_%] [initial_balance] - Set TP target",
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
              const volume = pos.margin * pos.leverage;

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

              message += `🔴 ${sideText} ${pos.symbol} x ${pos.leverage}\n`;
              message += `Entry: ${pos.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}\n`;
              message += `TP/SL: ${tpValue}/${slValue}\n`;
              message += `Volume: ${volume.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT\n`;
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
              const volume = pos.margin * pos.leverage;

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

              message += `🔴 ${sideText} ${pos.symbol} x ${pos.leverage}\n`;
              message += `Entry: ${pos.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}\n`;
              message += `TP/SL: ${tpValue}/${slValue}\n`;
              message += `Volume: ${volume.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT\n`;
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
        message += `${isActive ? "🟢" : "⚪"} *Binance*\n`;
        message += `└ Created: ${new Date(binanceData.createdAt).toLocaleDateString()}\n\n`;
      }

      if (okxData) {
        const isActive = activeExchange === "okx";
        message += `${isActive ? "🟢" : "⚪"} *OKX*\n`;
        message += `└ Created: ${new Date(okxData.createdAt).toLocaleDateString()}\n\n`;
      }

      message += `Active Exchange: *${activeExchange?.toUpperCase() || "None"}*\n\n`;
      message += "Use /switch [exchange] to change active exchange.";

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
        `✅ Switched to *${exchange.toUpperCase()}*\n\nAll commands will now use this exchange.`,
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
      const binanceData = await this.getUserData(telegramId, "binance");
      const okxData = await this.getUserData(telegramId, "okx");

      if (!binanceData && !okxData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No accounts connected.\nUse /setkeys to connect an exchange first.",
        );
        return;
      }

      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/set-account [tp_percentage] [initial_balance]\n\n" +
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
          `🤖 Bot will monitor unrealized PnL on ALL connected exchanges.\n` +
          `Positions will be closed when each exchange reaches $${targetProfit.toFixed(2)}.\n\n` +
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
      const userData = await this.getActiveUserData(telegramId);

      if (!userData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No active account found.\nUse /setkeys to connect an exchange.",
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
      const binanceData = await this.getUserData(telegramId, "binance");
      const okxData = await this.getUserData(telegramId, "okx");

      if (!binanceData && !okxData) {
        await this.bot.sendMessage(
          chatId,
          "❌ No accounts connected.\nUse /setkeys to connect an exchange.",
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

      let allMessages = [];

      // Get Binance balance if connected
      if (binanceData) {
        try {
          const balance = await this.binanceService.getAccountBalance(
            binanceData.apiKey,
            binanceData.apiSecret,
          );

          const unrealizedPnl = balance.totalUnrealizedProfit;
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          const currentPercentage =
            (unrealizedPnl / tpData.initialBalance) * 100;
          const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

          const message =
            `${progressEmoji} *Manual Update (BINANCE)*\n\n` +
            `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
            `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
            `🎯 TP Target Progress:\n` +
            `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
            `├ Current: ${currentPercentage.toFixed(2)}%\n` +
            `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`;

          allMessages.push(message);
        } catch (error) {
          allMessages.push(
            `📊 *BINANCE*\n❌ Error fetching balance: ${error.message}`,
          );
          this.logger.error(
            `Error fetching Binance balance for user ${telegramId}:`,
            error.message,
          );
        }
      }

      // Get OKX balance if connected
      if (okxData) {
        try {
          const balance = await this.okxService.getAccountBalance(
            okxData.apiKey,
            okxData.apiSecret,
            okxData.passphrase,
          );

          const unrealizedPnl = balance.totalUnrealizedProfit;
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          const currentPercentage =
            (unrealizedPnl / tpData.initialBalance) * 100;
          const progressEmoji = unrealizedPnl >= targetProfit ? "🎯" : "📊";

          const message =
            `${progressEmoji} *Manual Update (OKX)*\n\n` +
            `💰 Current Balance: $${balance.totalBalance.toFixed(2)}\n` +
            `📈 Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n\n` +
            `🎯 TP Target Progress:\n` +
            `├ Target: ${tpData.percentage}% ($${targetProfit.toFixed(2)})\n` +
            `├ Current: ${currentPercentage.toFixed(2)}%\n` +
            `└ Remaining: ${(tpData.percentage - currentPercentage).toFixed(2)}%`;

          allMessages.push(message);
        } catch (error) {
          allMessages.push(
            `📊 *OKX*\n❌ Error fetching balance: ${error.message}`,
          );
          this.logger.error(
            `Error fetching OKX balance for user ${telegramId}:`,
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
        `❌ Error getting update: ${error.message}`,
      );
      this.logger.error(
        `Error in manual update for user ${telegramId}:`,
        error.message,
      );
    }
  }
}
