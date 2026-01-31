import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import TelegramBot = require("node-telegram-bot-api");
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { OkxService } from "../okx/okx.service";
import { FileLoggerService } from "../logger/logger.service";
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
    private fileLogger: FileLoggerService,
  ) {
    this.fileLogger.setContext(TelegramBotService.name);
  }

  async onModuleInit() {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

    if (!token) {
      this.logger.error(
        "TELEGRAM_BOT_TOKEN is not set in environment variables",
      );
      this.fileLogger.error(
        "TELEGRAM_BOT_TOKEN is not set in environment variables",
      );
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.setupCommands();
  }

  private setupCommands() {
    // Command: /start
    this.bot.onText(/\/start/, async (msg) => {
      await this.handleStart(msg);
    });

    // Command: /setkeys - now with exchange type
    this.bot.onText(/\/setkeys[\s\S]+/, async (msg, match) => {
      await this.handleSetKeys(msg, match);
    });

    // Command: /accounts - list all connected accounts
    this.bot.onText(/\/accounts/, async (msg) => {
      await this.handleListAccounts(msg);
    });

    // Command: /position
    this.bot.onText(/\/position/, async (msg) => {
      await this.handlePosition(msg);
    });

    // Command: /setaccount [exchange] [tp_percentage] [initial_balance]
    this.bot.onText(/\/setaccount (.+)/, async (msg, match) => {
      await this.handleSetAccount(msg, match);
    });

    // Command: /setposition [exchange] [tp_percentage]
    this.bot.onText(/\/setposition (.+)/, async (msg, match) => {
      await this.handleSetPosition(msg, match);
    });

    // Command: /cleartp [exchange]
    this.bot.onText(/\/cleartp(.*)/, async (msg, match) => {
      await this.handleClearTakeProfit(msg, match);
    });

    // Command: /update [exchange] (manual trigger for testing)
    this.bot.onText(/\/update(.*)/, async (msg, match) => {
      await this.handleManualUpdate(msg, match);
    });

    // Command: /closeall [exchange] - close all positions
    this.bot.onText(/\/closeall(.*)/, async (msg, match) => {
      await this.handleCloseAllPositions(msg, match);
    });

    // Command: /close [exchange] [symbol] - close specific position
    this.bot.onText(/\/close (.+)/, async (msg, match) => {
      await this.handleClosePosition(msg, match);
    });

    // Command: /setretry [exchange] [max_retry] [volume_reduction%]
    this.bot.onText(/\/setretry (.+)/, async (msg, match) => {
      await this.handleSetRetry(msg, match);
    });

    // Command: /clearretry [exchange]
    this.bot.onText(/\/clearretry (.+)/, async (msg, match) => {
      await this.handleClearRetry(msg, match);
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

        // Check which TP mode is configured
        const tpMode = await this.redisService.get<{
          mode: "aggregate" | "individual";
        }>(`user:${telegramId}:tp:mode:${exchange}`);

        const userData = await this.getUserData(parseInt(telegramId), exchange);
        if (!userData) continue;

        // Run appropriate TP check based on mode
        if (tpMode?.mode === "individual") {
          // Individual position TP mode
          await this.checkIndividualPositionTP(
            parseInt(telegramId),
            exchange,
            userData,
          );
        } else {
          // Aggregate TP mode (default)
          await this.checkAggregateTP(parseInt(telegramId), exchange, userData);
        }
      }
    } catch (error) {
      this.fileLogger.logError(error, {
        operation: "checkTakeProfitTargets",
        type: "CRON_ERROR",
      });
    }
  }

  private async checkIndividualPositionTP(
    telegramId: number,
    exchange: "binance" | "okx",
    userData: UserApiKeys,
  ) {
    try {
      const tpConfig = await this.redisService.get<{
        percentage: number;
      }>(`user:${telegramId}:tp:individual:${exchange}`);

      if (!tpConfig) return;

      // Get all open positions
      let positions: any[];
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

      // Find positions that reached individual TP percentage
      const positionsAtTP = positions.filter((pos) => {
        if (pos.unrealizedPnl <= 0) return false;

        const isLong = pos.side === "LONG";
        const profitPercent = isLong
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

        // Check if position reached TP percentage and > 2% minimum
        return profitPercent >= tpConfig.percentage && profitPercent > 2;
      });

      if (positionsAtTP.length === 0) return;

      this.logger.log(
        `${positionsAtTP.length} position(s) reached individual TP (${tpConfig.percentage}%) for user ${telegramId} (${exchange.toUpperCase()})`,
      );

      // Check if retry is enabled
      const retryConfig = await this.redisService.get<{
        maxRetry: number;
        currentRetryCount: number;
        volumeReductionPercent: number;
        enabled: boolean;
      }>(`user:${telegramId}:retry:${exchange}`);

      // Store positions for re-entry if retry is enabled
      if (
        retryConfig &&
        retryConfig.enabled &&
        retryConfig.currentRetryCount > 0
      ) {
        const volumeReduction = retryConfig.volumeReductionPercent || 15;

        for (const position of positionsAtTP) {
          const nextQuantity = position.quantity * (1 - volumeReduction / 100);
          const currentPrice = position.currentPrice;
          const positionProfit = position.unrealizedPnl;

          const isLong = position.side === "LONG";
          const tpPrice = isLong
            ? position.entryPrice * (1 + tpConfig.percentage / 100)
            : position.entryPrice * (1 - tpConfig.percentage / 100);
          const potentialNextProfit =
            Math.abs(tpPrice - position.entryPrice) * nextQuantity;

          const profitPerUnit = potentialNextProfit / nextQuantity;
          const stopLossPrice = isLong
            ? parseFloat((position.entryPrice - profitPerUnit).toFixed(4))
            : parseFloat((position.entryPrice + profitPerUnit).toFixed(4));

          await this.redisService.set(
            `user:${telegramId}:reentry:${exchange}:${position.symbol}`,
            {
              symbol: position.symbol,
              entryPrice: position.entryPrice,
              currentPrice: currentPrice,
              closedProfit: positionProfit,
              side: position.side,
              quantity: nextQuantity,
              originalQuantity: position.quantity,
              leverage: position.leverage,
              margin: position.margin,
              volume: nextQuantity * position.entryPrice,
              originalVolume: position.quantity * position.entryPrice,
              closedAt: new Date().toISOString(),
              tpPercentage: tpConfig.percentage,
              stopLossPrice: stopLossPrice,
              currentRetry: 1,
              remainingRetries: retryConfig.currentRetryCount - 1,
              volumeReductionPercent: volumeReduction,
            },
          );
        }
      }

      // Close positions
      await this.closeAllPositions(userData, positionsAtTP);

      // Send notification
      const totalProfit = positionsAtTP.reduce(
        (sum, pos) => sum + pos.unrealizedPnl,
        0,
      );
      let message =
        `🎯 *Individual Position TP Reached! (${exchange.toUpperCase()})*\n\n` +
        `TP Target: ${tpConfig.percentage}%\n` +
        `✅ Closed ${positionsAtTP.length} position(s)\n` +
        `💰 Total Profit: $${totalProfit.toFixed(2)}\n\n` +
        positionsAtTP
          .map((pos) => {
            const isLong = pos.side === "LONG";
            const profitPercent = isLong
              ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;
            return `  ${pos.symbol}: ${pos.side} +${profitPercent.toFixed(2)}% ($${pos.unrealizedPnl.toFixed(2)})`;
          })
          .join("\n");

      if (retryConfig && retryConfig.currentRetryCount > 0) {
        message +=
          `\n\n🔄 *Auto Re-entry Enabled*\n` +
          `Will re-enter when price returns (-${retryConfig.volumeReductionPercent}% volume)`;
      }

      await this.bot.sendMessage(userData.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      this.fileLogger.logApiError(
        exchange,
        "checkIndividualPositionTP",
        error,
        telegramId,
      );
    }
  }

  private async checkAggregateTP(
    telegramId: number,
    exchange: "binance" | "okx",
    userData: UserApiKeys,
  ) {
    try {
      const tpData = await this.redisService.get<{
        percentage: number;
        initialBalance: number;
      }>(`user:${telegramId}:tp:${exchange}`);

      if (!tpData) return;

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

            // Filter positions with PnL > 0 and profit > 2%
            const profitablePositions = positions.filter((pos) => {
              if (pos.unrealizedPnl <= 0) return false;

              // Calculate profit percentage
              const isLong = pos.side === "LONG";
              const profitPercent = isLong
                ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

              return profitPercent > 2;
            });

            if (profitablePositions.length > 0) {
              // Check if retry is enabled
              const retryConfig = await this.redisService.get<{
                maxRetry: number;
                currentRetryCount: number;
                volumeReductionPercent: number;
                enabled: boolean;
              }>(`user:${telegramId}:retry:binance`);

              // Store positions for re-entry if retry is enabled
              if (
                retryConfig &&
                retryConfig.enabled &&
                retryConfig.currentRetryCount > 0
              ) {
                const volumeReduction =
                  retryConfig.volumeReductionPercent || 15;

                for (const position of profitablePositions) {
                  const nextQuantity =
                    position.quantity * (1 - volumeReduction / 100);

                  // Calculate stop loss based on profit from closed position
                  // Allow Position B to lose the same amount as its potential profit
                  // This secures: original_profit - potential_next_profit as minimum
                  const currentPrice = position.currentPrice;
                  const positionProfit = position.unrealizedPnl;

                  // Calculate potential profit if next position reaches TP
                  const isLong = position.side === "LONG";
                  const tpPrice = isLong
                    ? position.entryPrice * (1 + tpData.percentage / 100)
                    : position.entryPrice * (1 - tpData.percentage / 100);
                  const potentialNextProfit =
                    Math.abs(tpPrice - position.entryPrice) * nextQuantity;

                  // Allow Position B to lose its potential profit amount
                  // Example: Profit A = $10, Potential B = $8.50 → Allow loss of $8.50 → Net secured = $1.50
                  const profitPerUnit = potentialNextProfit / nextQuantity;

                  // For LONG: SL = entryPrice - profitPerUnit
                  // For SHORT: SL = entryPrice + profitPerUnit
                  const stopLossPrice = isLong
                    ? parseFloat(
                        (position.entryPrice - profitPerUnit).toFixed(4),
                      )
                    : parseFloat(
                        (position.entryPrice + profitPerUnit).toFixed(4),
                      );

                  await this.redisService.set(
                    `user:${telegramId}:reentry:binance:${position.symbol}`,
                    {
                      symbol: position.symbol,
                      entryPrice: position.entryPrice,
                      currentPrice: currentPrice,
                      closedProfit: positionProfit, // Store the profit from closed position
                      side: position.side,
                      quantity: nextQuantity,
                      originalQuantity: position.quantity,
                      leverage: position.leverage,
                      margin: position.margin,
                      volume: nextQuantity * position.entryPrice,
                      originalVolume: position.quantity * position.entryPrice,
                      closedAt: new Date().toISOString(),
                      tpPercentage: tpData.percentage,
                      stopLossPrice: stopLossPrice, // Profit-protected stop loss
                      currentRetry: 1,
                      remainingRetries: retryConfig.currentRetryCount - 1,
                      volumeReductionPercent: volumeReduction,
                    },
                  );
                }
              }

              await this.closeAllPositions(userData, profitablePositions);
            }

            // Prepare message
            const totalProfit = profitablePositions.reduce(
              (sum, pos) => sum + pos.unrealizedPnl,
              0,
            );
            let message =
              `🎯 *Take Profit Target Reached! (BINANCE)*\n\n` +
              `Target: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n` +
              `Target Profit: $${targetProfit.toFixed(2)}\n` +
              `Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n` +
              `Total Balance: $${balance.totalBalance.toFixed(2)}\n\n` +
              `✅ Closed ${profitablePositions.length} profitable position(s)\n` +
              `💰 Total Profit Captured: $${totalProfit.toFixed(2)}\n\n` +
              profitablePositions
                .map(
                  (pos) =>
                    `  ${pos.symbol}: ${pos.side} $${pos.unrealizedPnl.toFixed(2)}`,
                )
                .join("\n");

            // Add retry info if enabled
            const retryConfig = await this.redisService.get<{
              maxRetry: number;
              currentRetryCount: number;
              volumeReductionPercent: number;
            }>(`user:${telegramId}:retry:binance`);

            if (retryConfig && retryConfig.currentRetryCount > 0) {
              message +=
                `\n\n🔄 *Auto Re-entry Enabled*\n` +
                `Will re-enter when price returns (${retryConfig.volumeReductionPercent}% volume reduction)\n` +
                `Retries remaining: ${retryConfig.currentRetryCount}/${retryConfig.maxRetry}`;
            }

            await this.bot.sendMessage(userData.chatId, message, {
              parse_mode: "Markdown",
            });
          }
        } catch (error) {
          this.fileLogger.logApiError(
            "binance",
            "checkAggregateTP",
            error,
            telegramId,
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

            // Filter positions with PnL > 0 and profit > 2%
            const profitablePositions = positions.filter((pos) => {
              if (pos.unrealizedPnl <= 0) return false;

              // Calculate profit percentage
              const isLong = pos.side === "LONG";
              const profitPercent = isLong
                ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

              return profitPercent > 2;
            });

            if (profitablePositions.length > 0) {
              // Check if retry is enabled
              const retryConfig = await this.redisService.get<{
                maxRetry: number;
                currentRetryCount: number;
                volumeReductionPercent: number;
                enabled: boolean;
              }>(`user:${telegramId}:retry:okx`);

              // Store positions for re-entry if retry is enabled
              if (
                retryConfig &&
                retryConfig.enabled &&
                retryConfig.currentRetryCount > 0
              ) {
                const volumeReduction =
                  retryConfig.volumeReductionPercent || 15;

                for (const position of profitablePositions) {
                  const nextQuantity =
                    position.quantity * (1 - volumeReduction / 100);

                  // Calculate stop loss based on profit from closed position
                  // Allow Position B to lose the same amount as its potential profit
                  // This secures: original_profit - potential_next_profit as minimum
                  const currentPrice = position.currentPrice;
                  const positionProfit = position.unrealizedPnl;

                  // Calculate potential profit if next position reaches TP
                  const isLong = position.side === "LONG";
                  const tpPrice = isLong
                    ? position.entryPrice * (1 + tpData.percentage / 100)
                    : position.entryPrice * (1 - tpData.percentage / 100);
                  const potentialNextProfit =
                    Math.abs(tpPrice - position.entryPrice) * nextQuantity;

                  // Allow Position B to lose its potential profit amount
                  // Example: Profit A = $10, Potential B = $8.50 → Allow loss of $8.50 → Net secured = $1.50
                  const profitPerUnit = potentialNextProfit / nextQuantity;

                  // For LONG: SL = entryPrice - profitPerUnit
                  // For SHORT: SL = entryPrice + profitPerUnit
                  const stopLossPrice = isLong
                    ? parseFloat(
                        (position.entryPrice - profitPerUnit).toFixed(4),
                      )
                    : parseFloat(
                        (position.entryPrice + profitPerUnit).toFixed(4),
                      );

                  await this.redisService.set(
                    `user:${telegramId}:reentry:okx:${position.symbol}`,
                    {
                      symbol: position.symbol,
                      entryPrice: position.entryPrice,
                      currentPrice: currentPrice,
                      closedProfit: positionProfit, // Store the profit from closed position
                      side: position.side,
                      quantity: nextQuantity,
                      originalQuantity: position.quantity,
                      leverage: position.leverage,
                      margin: position.margin,
                      volume: nextQuantity * position.entryPrice,
                      originalVolume: position.quantity * position.entryPrice,
                      closedAt: new Date().toISOString(),
                      tpPercentage: tpData.percentage,
                      stopLossPrice: stopLossPrice, // Profit-protected stop loss
                      currentRetry: 1,
                      remainingRetries: retryConfig.currentRetryCount - 1,
                      volumeReductionPercent: volumeReduction,
                    },
                  );
                }
              }

              await this.closeAllPositions(userData, profitablePositions);
            }

            // Prepare message
            const totalProfit = profitablePositions.reduce(
              (sum, pos) => sum + pos.unrealizedPnl,
              0,
            );
            let message =
              `🎯 *Take Profit Target Reached! (OKX)*\n\n` +
              `Target: ${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)}\n` +
              `Target Profit: $${targetProfit.toFixed(2)}\n` +
              `Unrealized PnL: $${unrealizedPnl.toFixed(2)}\n` +
              `Total Balance: $${balance.totalBalance.toFixed(2)}\n\n` +
              `✅ Closed ${profitablePositions.length} profitable position(s)\n` +
              `💰 Total Profit Captured: $${totalProfit.toFixed(2)}\n\n` +
              profitablePositions
                .map(
                  (pos) =>
                    `  ${pos.symbol}: ${pos.side} $${pos.unrealizedPnl.toFixed(2)}`,
                )
                .join("\n");

            // Add retry info if enabled
            const retryConfig = await this.redisService.get<{
              maxRetry: number;
              currentRetryCount: number;
              volumeReductionPercent: number;
            }>(`user:${telegramId}:retry:okx`);

            if (retryConfig && retryConfig.currentRetryCount > 0) {
              message +=
                `\n\n🔄 *Auto Re-entry Enabled*\n` +
                `Will re-enter when price returns (${retryConfig.volumeReductionPercent}% volume reduction)\n` +
                `Retries remaining: ${retryConfig.currentRetryCount}/${retryConfig.maxRetry}`;
            }

            await this.bot.sendMessage(userData.chatId, message, {
              parse_mode: "Markdown",
            });
          }
        } catch (error) {
          this.fileLogger.logApiError(
            "okx",
            "checkAggregateTP",
            error,
            telegramId,
          );
        }
      }
    } catch (error) {
      this.fileLogger.logApiError(
        exchange,
        "checkAggregateTP",
        error,
        telegramId,
      );
    }
  }

  @Cron("*/30 * * * * *")
  private async checkReentryOpportunities() {
    try {
      // Get all pending re-entries
      const keys = await this.redisService.keys("user:*:reentry:*:*");

      for (const key of keys) {
        // Key format: binance-bot:user:{telegramId}:reentry:{exchange}:{symbol}
        const parts = key.split(":");
        const telegramId = parseInt(parts[2]);
        const exchange = parts[4] as "binance" | "okx";
        const symbol = parts[5];

        const reentryData = await this.redisService.get<any>(
          `user:${telegramId}:reentry:${exchange}:${symbol}`,
        );
        if (!reentryData) continue;

        const userData = await this.getUserData(telegramId, exchange);
        if (!userData) continue;

        try {
          // Get current market price
          let currentPrice: number;
          if (exchange === "binance") {
            currentPrice = await this.binanceService.getCurrentPrice(
              userData.apiKey,
              userData.apiSecret,
              symbol,
            );
          } else {
            currentPrice = await this.okxService.getCurrentPrice(
              userData.apiKey,
              userData.apiSecret,
              userData.passphrase,
              symbol,
            );
          }

          // Safety checks before re-entry
          const safetyChecks = await this.checkReentrySafety(
            exchange,
            userData,
            symbol,
            currentPrice,
            reentryData,
          );

          if (!safetyChecks.safe) {
            this.logger.debug(
              `Re-entry blocked for ${symbol}: ${safetyChecks.reason}`,
            );
            continue;
          }

          // All safety checks passed, execute re-entry
          await this.executeReentry(
            telegramId,
            exchange,
            userData,
            reentryData,
          );
        } catch (error) {
          this.fileLogger.logApiError(
            exchange,
            "checkReentryOpportunities",
            error,
            telegramId,
            symbol,
          );
        }
      }
    } catch (error) {
      this.fileLogger.logError(error, {
        operation: "checkReentryOpportunities",
        type: "CRON_ERROR",
      });
    }
  }

  private async checkReentrySafety(
    exchange: "binance" | "okx",
    userData: UserApiKeys,
    symbol: string,
    currentPrice: number,
    reentryData: any,
  ): Promise<{ safe: boolean; reason?: string }> {
    try {
      const isLong = reentryData.side === "LONG";

      // 1. Cooldown Check (30 minutes minimum)
      const timeSinceClose =
        Date.now() - new Date(reentryData.closedAt).getTime();
      const cooldownMinutes = 30;
      if (timeSinceClose < cooldownMinutes * 60 * 1000) {
        return {
          safe: false,
          reason: `Cooldown active (${Math.floor(timeSinceClose / 60000)}/${cooldownMinutes} min)`,
        };
      }

      // 2. Price Range Check (5-25% below original entry for LONG, 5-25% above for SHORT)
      const priceChange = isLong
        ? ((reentryData.entryPrice - currentPrice) / reentryData.entryPrice) *
          100
        : ((currentPrice - reentryData.entryPrice) / reentryData.entryPrice) *
          100;

      if (priceChange < 5 || priceChange > 25) {
        return {
          safe: false,
          reason: `Price ${priceChange.toFixed(2)}% from entry (need 5-25%)`,
        };
      }

      // 3. Get klines for technical analysis
      let klines: any[];
      if (exchange === "binance") {
        klines = await this.binanceService.getKlines(
          userData.apiKey,
          userData.apiSecret,
          symbol,
          "15m",
          30, // Get 30 candles for EMA calculation
        );
      } else {
        klines = await this.okxService.getKlines(
          userData.apiKey,
          userData.apiSecret,
          userData.passphrase,
          symbol,
          "15m",
          30,
        );
      }

      if (!klines || klines.length < 21) {
        return { safe: false, reason: "Insufficient data for analysis" };
      }

      // 4. EMA Crossover Check (EMA9 > EMA21 for LONG, EMA9 < EMA21 for SHORT)
      const closes = klines.map((k) => parseFloat(k.close || k[4]));
      const ema9 = this.calculateEMA(closes, 9);
      const ema21 = this.calculateEMA(closes, 21);

      const emaConditionMet = isLong ? ema9 > ema21 : ema9 < ema21;
      if (!emaConditionMet) {
        return {
          safe: false,
          reason: `EMA not aligned (EMA9: ${ema9.toFixed(2)}, EMA21: ${ema21.toFixed(2)})`,
        };
      }

      // 5. Buy/Sell Volume Pressure Check (>55% buy for LONG, >55% sell for SHORT)
      const last20Candles = klines.slice(-20);
      let totalBuyVolume = 0;
      let totalSellVolume = 0;

      for (const candle of last20Candles) {
        const open = parseFloat(candle.open || candle[1]);
        const close = parseFloat(candle.close || candle[4]);
        const volume = parseFloat(candle.volume || candle[5]);

        if (close > open) {
          // Bullish candle - assume buy pressure
          totalBuyVolume += volume;
        } else {
          // Bearish candle - assume sell pressure
          totalSellVolume += volume;
        }
      }

      const buyPressure = totalBuyVolume / (totalBuyVolume + totalSellVolume);
      const volumeConditionMet = isLong
        ? buyPressure > 0.55
        : buyPressure < 0.45;

      if (!volumeConditionMet) {
        return {
          safe: false,
          reason: `Volume pressure not favorable (${(buyPressure * 100).toFixed(1)}% buy)`,
        };
      }

      // All checks passed
      this.logger.log(
        `✅ Re-entry safety checks passed for ${symbol}: ` +
          `Price change: ${priceChange.toFixed(2)}%, ` +
          `EMA9: ${ema9.toFixed(2)}, EMA21: ${ema21.toFixed(2)}, ` +
          `Buy pressure: ${(buyPressure * 100).toFixed(1)}%`,
      );

      return { safe: true };
    } catch (error) {
      this.logger.error(`Error in safety check: ${error.message}`);
      return { safe: false, reason: `Analysis error: ${error.message}` };
    }
  }

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private async executeReentry(
    telegramId: number,
    exchange: "binance" | "okx",
    userData: UserApiKeys,
    reentryData: any,
  ) {
    try {
      this.logger.log(
        `Executing re-entry for user ${telegramId}: ${reentryData.symbol} ${reentryData.side} ${reentryData.quantity}`,
      );

      // Open position
      let orderResult: any;
      if (exchange === "binance") {
        orderResult = await this.binanceService.openPosition(
          userData.apiKey,
          userData.apiSecret,
          {
            symbol: reentryData.symbol,
            side: reentryData.side,
            quantity: reentryData.quantity,
            leverage: reentryData.leverage,
          },
        );
      } else {
        orderResult = await this.okxService.openPosition(
          userData.apiKey,
          userData.apiSecret,
          userData.passphrase,
          {
            symbol: reentryData.symbol,
            side: reentryData.side,
            quantity: reentryData.quantity,
            leverage: reentryData.leverage,
          },
        );
      }

      // Get ACTUAL execution price from order result
      // This is the real entry price for this retry
      const actualEntryPrice = orderResult?.avgPrice
        ? parseFloat(orderResult.avgPrice)
        : reentryData.entryPrice; // Fallback to stored if not available

      this.logger.log(
        `Re-entry executed at $${actualEntryPrice} (original was $${reentryData.entryPrice})`,
      );

      // Use stored Stop Loss price (from previous TP) to protect profits
      // If not stored (old data), calculate it based on ORIGINAL entry
      const isLong = reentryData.side === "LONG";
      const stopLossPrice =
        reentryData.stopLossPrice ||
        (() => {
          const tpPrice = isLong
            ? reentryData.entryPrice * (1 + reentryData.tpPercentage / 100)
            : reentryData.entryPrice * (1 - reentryData.tpPercentage / 100);
          return parseFloat(tpPrice.toFixed(4));
        })();

      // Calculate Take Profit price based on NEW entry (actual execution price)
      const takeProfitPrice = isLong
        ? parseFloat(
            (actualEntryPrice * (1 + reentryData.tpPercentage / 100)).toFixed(
              4,
            ),
          )
        : parseFloat(
            (actualEntryPrice * (1 - reentryData.tpPercentage / 100)).toFixed(
              4,
            ),
          );

      // Set Stop Loss on exchange
      try {
        if (exchange === "binance") {
          await this.binanceService.setStopLoss(
            userData.apiKey,
            userData.apiSecret,
            reentryData.symbol,
            stopLossPrice,
            reentryData.side,
            reentryData.quantity,
          );
        } else {
          await this.okxService.setStopLoss(
            userData.apiKey,
            userData.apiSecret,
            userData.passphrase,
            reentryData.symbol,
            stopLossPrice,
            reentryData.side,
            reentryData.quantity,
          );
        }
        this.logger.log(
          `Set SL at $${stopLossPrice} for ${reentryData.symbol}`,
        );
      } catch (slError) {
        this.fileLogger.logApiError(
          exchange,
          "setStopLoss",
          slError,
          telegramId,
          reentryData.symbol,
        );
        // Continue even if SL setting fails
      }

      // Set Take Profit on exchange
      try {
        if (exchange === "binance") {
          await this.binanceService.setTakeProfit(
            userData.apiKey,
            userData.apiSecret,
            reentryData.symbol,
            reentryData.tpPercentage,
          );
        } else {
          await this.okxService.setTakeProfit(
            userData.apiKey,
            userData.apiSecret,
            userData.passphrase,
            reentryData.symbol,
            reentryData.tpPercentage,
          );
        }
        this.logger.log(
          `Set TP at $${takeProfitPrice} (${reentryData.tpPercentage}%) for ${reentryData.symbol}`,
        );
      } catch (tpError) {
        this.fileLogger.logApiError(
          exchange,
          "setTakeProfit",
          tpError,
          telegramId,
          reentryData.symbol,
        );
        // Continue even if TP setting fails
      }

      // Calculate next quantity with volume reduction
      const volumeReduction = reentryData.volumeReductionPercent || 15;
      const nextQuantity = reentryData.quantity * (1 - volumeReduction / 100);
      const currentVolume = reentryData.quantity * actualEntryPrice; // Use actual entry price
      const volumeReductionAmount =
        ((reentryData.originalQuantity - reentryData.quantity) /
          reentryData.originalQuantity) *
        100;

      // Calculate next stop loss based on NEW entry price
      // This protects profits from THIS entry, not the original
      const potentialNextProfit =
        Math.abs(takeProfitPrice - actualEntryPrice) * nextQuantity;
      const nextStopLossPrice = isLong
        ? parseFloat(
            (actualEntryPrice - potentialNextProfit / nextQuantity).toFixed(4),
          )
        : parseFloat(
            (actualEntryPrice + potentialNextProfit / nextQuantity).toFixed(4),
          );

      // Update re-entry data with reduced quantity for next time
      if (reentryData.remainingRetries > 0) {
        await this.redisService.set(
          `user:${telegramId}:reentry:${exchange}:${reentryData.symbol}`,
          {
            ...reentryData,
            entryPrice: actualEntryPrice, // 🔥 NEW: Use actual execution price for next retry
            stopLossPrice: nextStopLossPrice, // 🔥 NEW: Calculate SL based on new entry
            quantity: nextQuantity,
            volume: nextQuantity * actualEntryPrice,
            currentRetry: reentryData.currentRetry + 1,
            remainingRetries: reentryData.remainingRetries - 1,
          },
        );

        this.logger.log(
          `Updated re-entry data: Entry $${actualEntryPrice}, Next Qty ${nextQuantity.toFixed(4)}, Next SL $${nextStopLossPrice}`,
        );
      } else {
        // No more retries, clean up all retry information
        this.logger.log(
          `Max retries reached for user ${telegramId} ${exchange} ${reentryData.symbol}. Cleaning up retry data.`,
        );

        // Remove this symbol's reentry data
        await this.redisService.delete(
          `user:${telegramId}:reentry:${exchange}:${reentryData.symbol}`,
        );

        // Check if there are any other pending re-entries for this exchange
        const remainingReentries = await this.redisService.keys(
          `user:${telegramId}:reentry:${exchange}:*`,
        );

        // If no more re-entries pending, reset retry count in config
        if (remainingReentries.length === 0) {
          const retryConfig = await this.redisService.get<{
            maxRetry: number;
            currentRetryCount: number;
            volumeReductionPercent: number;
            enabled: boolean;
          }>(`user:${telegramId}:retry:${exchange}`);

          if (retryConfig) {
            // Reset retry count to max for next time
            await this.redisService.set(
              `user:${telegramId}:retry:${exchange}`,
              {
                ...retryConfig,
                currentRetryCount: retryConfig.maxRetry,
              },
            );
            this.logger.log(
              `Reset retry count to ${retryConfig.maxRetry} for user ${telegramId} ${exchange}`,
            );
          }
        }
      }

      // Notify user
      const retryText =
        reentryData.remainingRetries > 0
          ? `Retry ${reentryData.currentRetry}/${reentryData.currentRetry + reentryData.remainingRetries}`
          : `Final Retry ${reentryData.currentRetry}/${reentryData.currentRetry}`;

      // Calculate price improvement
      const priceImprovement = isLong
        ? ((reentryData.entryPrice - actualEntryPrice) /
            reentryData.entryPrice) *
          100
        : ((actualEntryPrice - reentryData.entryPrice) /
            reentryData.entryPrice) *
          100;

      const improvementText =
        priceImprovement !== 0
          ? priceImprovement > 0
            ? `\n💚 Entry improved by ${priceImprovement.toFixed(2)}% (from $${reentryData.entryPrice.toLocaleString()})`
            : `\n⚠️ Entry slipped by ${Math.abs(priceImprovement).toFixed(2)}% (from $${reentryData.entryPrice.toLocaleString()})`
          : "";

      await this.bot.sendMessage(
        userData.chatId,
        `🔄 *Re-entered Position!* (${exchange.toUpperCase()})\n\n` +
          `${reentryData.side === "LONG" ? "📈" : "📉"} ${reentryData.symbol} ${reentryData.side}\n` +
          `Entry: $${actualEntryPrice.toLocaleString()}${improvementText}\n` +
          `Quantity: ${reentryData.quantity.toFixed(4)} (-${volumeReductionAmount.toFixed(1)}% from original)\n` +
          `Volume: $${currentVolume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
          `Leverage: ${reentryData.leverage}x\n\n` +
          `🎯 Take Profit: $${takeProfitPrice.toLocaleString()} (+${reentryData.tpPercentage}%)\n` +
          `🛡️ Stop Loss: $${stopLossPrice.toLocaleString()} (Profit Protected)\n\n` +
          `${retryText}\n` +
          (reentryData.remainingRetries > 0
            ? `Retries remaining: ${reentryData.remainingRetries}\n` +
              `Next entry: $${actualEntryPrice.toLocaleString()}, Next SL: $${nextStopLossPrice.toLocaleString()}`
            : `⚠️ This was the last retry!`),
        { parse_mode: "Markdown" },
      );

      this.logger.log(
        `Re-entry successful for user ${telegramId}: ${reentryData.symbol}`,
      );
    } catch (error) {
      this.fileLogger.logApiError(
        exchange,
        "executeReentry",
        error,
        telegramId,
        reentryData.symbol,
      );

      // Notify user of failure
      await this.bot.sendMessage(
        userData.chatId,
        `❌ Failed to re-enter ${reentryData.symbol}: ${error.message}\n\n` +
          `Will retry on next check.`,
      );
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
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
      this.fileLogger.logError(error, {
        operation: "sendPeriodicUpdates",
        type: "CRON_ERROR",
      });
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
        this.fileLogger.logApiError(
          userData.exchange,
          "closeAllOpenPositions",
          error,
          userData.telegramId,
          position.symbol,
        );
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
          "/setaccount exchange % balance - Aggregate TP\n" +
          "/setposition exchange % - Individual position TP\n" +
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
          `/setaccount ${exchange} % balance - Set TP target\n` +
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
      this.fileLogger.logApiError(exchange, "setKeys", error, telegramId);
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
          this.fileLogger.logApiError(
            "binance",
            "getPositions",
            error,
            telegramId,
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
          this.fileLogger.logApiError("okx", "getPositions", error, telegramId);
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
      this.fileLogger.logBusinessError("handlePosition", error, telegramId);
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

        const tpMode = await this.redisService.get<{
          mode: "aggregate" | "individual";
        }>(`user:${telegramId}:tp:mode:binance`);

        const individualTpData = await this.redisService.get<{
          percentage: number;
        }>(`user:${telegramId}:tp:individual:binance`);

        const retryConfig = await this.redisService.get<{
          maxRetry: number;
          currentRetryCount: number;
          volumeReductionPercent: number;
          enabled: boolean;
        }>(`user:${telegramId}:retry:binance`);

        message += `${isActive ? "🟢" : "⚪"} *Binance*\n`;
        message += `├ Created: ${new Date(binanceData.createdAt).toLocaleDateString()}\n`;

        if (tpMode?.mode === "individual" && individualTpData) {
          message += `├ TP Mode: 📍 Individual (${individualTpData.percentage}% per position)\n`;
        } else if (tpData && tpData.initialBalance > 0) {
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          message += `├ TP Mode: 📊 Aggregate (${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)})\n`;
          message += `├ TP Target: $${targetProfit.toFixed(2)}\n`;
        } else {
          message += `├ TP Config: Not set\n`;
        }

        if (retryConfig && retryConfig.enabled) {
          message += `├ 🔄 Retry: ${retryConfig.currentRetryCount}/${retryConfig.maxRetry} (-${retryConfig.volumeReductionPercent}% vol)\n`;
        } else {
          message += `├ 🔄 Retry: Disabled\n`;
        }
        message += `└\n\n`;
      }

      if (okxData) {
        const isActive = activeExchange === "okx";
        const tpData = await this.redisService.get<{
          percentage: number;
          initialBalance: number;
          setAt: string;
        }>(`user:${telegramId}:tp:okx`);

        const tpMode = await this.redisService.get<{
          mode: "aggregate" | "individual";
        }>(`user:${telegramId}:tp:mode:okx`);

        const individualTpData = await this.redisService.get<{
          percentage: number;
        }>(`user:${telegramId}:tp:individual:okx`);

        const retryConfig = await this.redisService.get<{
          maxRetry: number;
          currentRetryCount: number;
          volumeReductionPercent: number;
          enabled: boolean;
        }>(`user:${telegramId}:retry:okx`);

        message += `${isActive ? "🟢" : "⚪"} *OKX*\n`;
        message += `├ Created: ${new Date(okxData.createdAt).toLocaleDateString()}\n`;

        if (tpMode?.mode === "individual" && individualTpData) {
          message += `├ TP Mode: 📍 Individual (${individualTpData.percentage}% per position)\n`;
        } else if (tpData && tpData.initialBalance > 0) {
          const targetProfit =
            (tpData.initialBalance * tpData.percentage) / 100;
          message += `├ TP Mode: 📊 Aggregate (${tpData.percentage}% of $${tpData.initialBalance.toFixed(2)})\n`;
          message += `├ TP Target: $${targetProfit.toFixed(2)}\n`;
        } else {
          message += `├ TP Config: Not set\n`;
        }

        if (retryConfig && retryConfig.enabled) {
          message += `├ 🔄 Retry: ${retryConfig.currentRetryCount}/${retryConfig.maxRetry} (-${retryConfig.volumeReductionPercent}% vol)\n`;
        } else {
          message += `├ 🔄 Retry: Disabled\n`;
        }
        message += `└\n\n`;
      }

      message += `Active Exchange: *${activeExchange?.toUpperCase() || "None"}*\n\n`;
      message +=
        "Use /setaccount [exchange] to configure TP for each exchange.";

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
      this.fileLogger.logBusinessError("handleListAccounts", error, telegramId);
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

    let exchange: "binance" | "okx" | undefined;

    try {
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/setaccount exchange % balance\n\n" +
            "Examples:\n/setaccount binance 5 1000\n/setaccount okx 10 2000\n\n" +
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
            "Example: /setaccount binance 5 1000",
        );
        return;
      }

      exchange = args[0].toLowerCase() as "binance" | "okx";
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

      // Set mode to aggregate
      await this.redisService.set(`user:${telegramId}:tp:mode:${exchange}`, {
        mode: "aggregate",
      });

      await this.bot.sendMessage(
        chatId,
        `✅ *Aggregate TP Set for ${exchange.toUpperCase()}*\n\n` +
          `Mode: Aggregate (All Positions)\n` +
          `TP Percentage: ${percentage}%\n` +
          `Initial Balance: $${initialBalance.toFixed(2)}\n` +
          `Target Profit: $${targetProfit.toFixed(2)}\n\n` +
          `🤖 Bot will monitor ${exchange.toUpperCase()} account.\n` +
          `All positions will close when total unrealized PnL ≥ $${targetProfit.toFixed(2)}\n\n` +
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
      this.fileLogger.logBusinessError("handleSetAccount", error, telegramId, {
        exchange,
      });
    }
  }

  private async handleSetPosition(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Ensure chatId is stored
    await this.ensureChatIdStored(telegramId, chatId);

    let exchange: "binance" | "okx" | undefined;

    try {
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/setposition exchange %\n\n" +
            "Examples:\n/setposition binance 3\n/setposition okx 5\n\n" +
            "This will close each position when it reaches the TP percentage.",
          { parse_mode: "Markdown" },
        );
        return;
      }

      const args = match[1].trim().split(/\s+/);

      if (args.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please provide exchange and TP percentage.\n" +
            "Example: /setposition binance 3",
        );
        return;
      }

      exchange = args[0].toLowerCase() as "binance" | "okx";
      const percentage = parseFloat(args[1]);

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

      // Store individual TP configuration
      await this.redisService.set(
        `user:${telegramId}:tp:individual:${exchange}`,
        {
          percentage,
          setAt: new Date().toISOString(),
        },
      );

      // Store mode as individual and keep a marker in tp:{exchange} for cron to detect
      await this.redisService.set(`user:${telegramId}:tp:mode:${exchange}`, {
        mode: "individual",
      });

      // Set marker for cron job detection
      await this.redisService.set(`user:${telegramId}:tp:${exchange}`, {
        percentage: percentage,
        initialBalance: 0, // Not used in individual mode
        setAt: new Date().toISOString(),
      });

      await this.bot.sendMessage(
        chatId,
        `✅ *Individual Position TP Set for ${exchange.toUpperCase()}*\n\n` +
          `Mode: Individual (Per Position)\n` +
          `TP Percentage: ${percentage}%\n\n` +
          `🤖 Bot will monitor each ${exchange.toUpperCase()} position.\n` +
          `Each position will close independently when it reaches ${percentage}% profit.\n\n` +
          `Use /cleartp ${exchange} to remove`,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error setting position TP: ${error.message}`,
      );
      this.logger.error(
        `Error setting position TP for user ${telegramId}:`,
        error.message,
      );
      this.fileLogger.logBusinessError("handleSetPosition", error, telegramId, {
        exchange,
      });
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

      // Clear all TP-related keys
      await this.redisService.delete(tpKey);
      await this.redisService.delete(`user:${telegramId}:tp:mode:${exchange}`);
      await this.redisService.delete(
        `user:${telegramId}:tp:individual:${exchange}`,
      );

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

    let exchange: "binance" | "okx" | undefined;

    try {
      const args = match[1]?.trim();

      if (!args) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please specify exchange.\n\nExamples:\n/update binance\n/update okx",
        );
        return;
      }

      exchange = args.toLowerCase() as "binance" | "okx";

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
          `❌ No take profit target set for ${exchange.toUpperCase()}. Use /setaccount first.`,
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
      this.fileLogger.logBusinessError(
        "handleManualUpdate",
        error,
        telegramId,
        { exchange },
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

    let exchange: "binance" | "okx" | undefined;

    try {
      const args = match[1]?.trim();

      if (!args) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please specify exchange.\n\nExamples:\n/closeall binance\n/closeall okx",
        );
        return;
      }

      exchange = args.toLowerCase() as "binance" | "okx";

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
      this.fileLogger.logApiError(
        exchange,
        "handleCloseAllPositions",
        error,
        telegramId,
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

    let exchange: "binance" | "okx" | undefined;
    let symbol: string | undefined;

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

      exchange = args[0].toLowerCase() as "binance" | "okx";
      symbol = args[1].toUpperCase();

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
      this.fileLogger.logApiError(
        exchange,
        "handleClosePosition",
        error,
        telegramId,
        symbol,
      );
    }
  }

  private async handleSetRetry(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    await this.ensureChatIdStored(telegramId, chatId);

    let exchange: "binance" | "okx" | undefined;
    let maxRetry: number | undefined;
    let volumeReductionPercent: number | undefined;

    try {
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/setretry exchange max_retry [volume_reduction%]\n\n" +
            "Examples:\n/setretry binance 5\n/setretry okx 3 20\n\n" +
            "• max_retry: 1-10 (number of re-entries)\n" +
            "• volume_reduction: 1-50% (default 15%)",
        );
        return;
      }

      const args = match[1].trim().split(/\s+/);
      if (args.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Please provide exchange and max retry count.\nExample: /setretry binance 5",
        );
        return;
      }

      exchange = args[0].toLowerCase() as "binance" | "okx";
      maxRetry = parseInt(args[1]);
      volumeReductionPercent = args[2] ? parseFloat(args[2]) : 15;

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      if (isNaN(maxRetry) || maxRetry < 1 || maxRetry > 10) {
        await this.bot.sendMessage(
          chatId,
          "❌ Max retry must be between 1 and 10.",
        );
        return;
      }

      if (
        isNaN(volumeReductionPercent) ||
        volumeReductionPercent < 1 ||
        volumeReductionPercent > 50
      ) {
        await this.bot.sendMessage(
          chatId,
          "❌ Volume reduction must be between 1% and 50%.",
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

      // Store retry configuration
      await this.redisService.set(`user:${telegramId}:retry:${exchange}`, {
        maxRetry,
        currentRetryCount: maxRetry,
        volumeReductionPercent,
        enabled: true,
        setAt: new Date().toISOString(),
      });

      await this.bot.sendMessage(
        chatId,
        `✅ *Retry Enabled for ${exchange.toUpperCase()}*\n\n` +
          `📊 Configuration:\n` +
          `├ Max Retries: ${maxRetry}\n` +
          `├ Volume Reduction: ${volumeReductionPercent}% per retry\n` +
          `└ Status: Active\n\n` +
          `When TP is reached, positions will be re-entered automatically when price returns to entry level.\n\n` +
          `Use /clearretry ${exchange} to disable.`,
        { parse_mode: "Markdown" },
      );

      this.logger.log(
        `Retry enabled for user ${telegramId} (${exchange}): maxRetry=${maxRetry}, volumeReduction=${volumeReductionPercent}%`,
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error setting retry: ${error.message}`,
      );
      this.logger.error(
        `Error in handleSetRetry for user ${telegramId}:`,
        error.message,
      );
      this.fileLogger.logBusinessError("handleSetRetry", error, telegramId, {
        exchange,
        maxRetry,
        volumeReductionPercent,
      });
    }
  }

  private async handleClearRetry(
    msg: TelegramBot.Message,
    match: RegExpExecArray,
  ) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    await this.ensureChatIdStored(telegramId, chatId);

    let exchange: "binance" | "okx" | undefined;

    try {
      if (!match || match.length < 2) {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid format. Use:\n/clearretry exchange\n\nExamples:\n/clearretry binance\n/clearretry okx",
        );
        return;
      }

      exchange = match[1].trim().toLowerCase() as "binance" | "okx";

      if (exchange !== "binance" && exchange !== "okx") {
        await this.bot.sendMessage(
          chatId,
          "❌ Invalid exchange. Please use 'binance' or 'okx'.",
        );
        return;
      }

      // Check if retry config exists
      const retryConfig = await this.redisService.get(
        `user:${telegramId}:retry:${exchange}`,
      );

      if (!retryConfig) {
        await this.bot.sendMessage(
          chatId,
          `ℹ️ No retry configuration found for ${exchange.toUpperCase()}.`,
        );
        return;
      }

      // Delete retry configuration
      await this.redisService.delete(`user:${telegramId}:retry:${exchange}`);

      // Clear all pending re-entries for this exchange
      const reentryKeys = await this.redisService.keys(
        `user:${telegramId}:reentry:${exchange}:*`,
      );
      let clearedCount = 0;
      for (const key of reentryKeys) {
        const simplifiedKey = key.replace("binance-bot:", "");
        await this.redisService.delete(simplifiedKey);
        clearedCount++;
      }

      await this.bot.sendMessage(
        chatId,
        `✅ *Retry Disabled for ${exchange.toUpperCase()}*\n\n` +
          `Cleared ${clearedCount} pending re-entry position(s).\n\n` +
          `Use /setretry ${exchange} to re-enable.`,
        { parse_mode: "Markdown" },
      );

      this.logger.log(
        `Retry disabled for user ${telegramId} (${exchange}), cleared ${clearedCount} pending re-entries`,
      );
    } catch (error) {
      await this.bot.sendMessage(
        chatId,
        `❌ Error clearing retry: ${error.message}`,
      );
      this.logger.error(
        `Error in handleClearRetry for user ${telegramId}:`,
        error.message,
      );
      this.fileLogger.logBusinessError("handleClearRetry", error, telegramId, {
        exchange,
      });
    }
  }
}
