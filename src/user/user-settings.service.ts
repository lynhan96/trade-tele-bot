import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  UserSettings,
  UserSettingsDocument,
  ExchangeSettings,
} from "../schemas/user-settings.schema";
import {
  UserApiKeys,
  UserBotConfig,
  UserBotsConfig,
} from "../interfaces/user.interface";
import { RedisService } from "../redis/redis.service";

export type Exchange = "binance" | "okx";

export interface TpConfig {
  percentage: number;
  initialBalance: number;
}

export interface TpModeConfig {
  mode: "aggregate" | "individual";
}

export interface TpIndividualConfig {
  percentage: number;
}

export interface RetryConfig {
  maxRetry: number;
  currentRetryCount: number;
  volumeReductionPercent: number;
  enabled: boolean;
}

// Shape used by the cron jobs to iterate users with TP configured
export interface UserWithTp {
  telegramId: number;
  exchange: Exchange;
}

// Shape used by the cron jobs to iterate users with bots configured
export interface UserWithBots {
  telegramId: number;
  exchange: Exchange;
}

// Shape used by the signal dispatcher to find users for a given botType
export interface UserWithBot {
  telegramId: number;
  exchange: Exchange;
  botConfig: UserBotConfig;
  userData: UserApiKeys;
}

@Injectable()
export class UserSettingsService implements OnModuleInit {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(
    @InjectModel(UserSettings.name)
    private readonly model: Model<UserSettingsDocument>,
    private readonly redisService: RedisService,
  ) {}

  // ─── Redis → MongoDB Migration ────────────────────────────────────────────

  async onModuleInit() {
    await this.migrateFromRedis();
  }

  /**
   * One-time migration: read all user settings from Redis and upsert into
   * MongoDB. Idempotent — skips users that already have a MongoDB document.
   */
  private async migrateFromRedis(): Promise<void> {
    const [binanceKeys, okxKeys] = await Promise.all([
      this.redisService.keys("user:*:binance"),
      this.redisService.keys("user:*:okx"),
    ]);

    // Build (telegramId, exchange) pairs from both key sets
    const pairs: { telegramId: number; exchange: Exchange }[] = [];
    for (const key of [...binanceKeys, ...okxKeys]) {
      // key includes prefix: "binance-bot:user:{id}:{exchange}"
      const stripped = key.replace(/^binance-bot:/, "");
      const parts = stripped.split(":");
      if (parts.length < 3) continue;
      const telegramId = parseInt(parts[1]);
      const exchange = parts[2] as Exchange;
      if (isNaN(telegramId) || !["binance", "okx"].includes(exchange)) continue;
      pairs.push({ telegramId, exchange });
    }

    if (pairs.length === 0) {
      this.logger.log(
        "[UserSettings] No Redis user data found — migration skipped.",
      );
      return;
    }

    this.logger.log(
      `[UserSettings] Migrating ${pairs.length} user-exchange record(s) from Redis...`,
    );

    let migrated = 0;
    for (const { telegramId, exchange } of pairs) {
      try {
        // Skip if MongoDB already has API keys for this exchange
        const existing = await this.model
          .findOne({ telegramId }, { [`${exchange}.apiKey`]: 1 })
          .lean();
        if ((existing as any)?.[exchange]?.apiKey) continue;

        // Read API keys
        const apiKeys = await this.redisService.get<UserApiKeys>(
          `user:${telegramId}:${exchange}`,
        );
        if (!apiKeys?.apiKey) continue;

        // Read all other settings in parallel
        const [
          tpData,
          tpModeData,
          tpIndividualData,
          botsData,
          retryData,
          maxPos,
          activeEx,
          updatesDisabled,
        ] = await Promise.all([
          this.redisService.get<{ percentage: number; initialBalance: number }>(
            `user:${telegramId}:tp:${exchange}`,
          ),
          this.redisService.get<{ mode: string }>(
            `user:${telegramId}:tp:mode:${exchange}`,
          ),
          this.redisService.get<{ percentage: number }>(
            `user:${telegramId}:tp:individual:${exchange}`,
          ),
          this.redisService.get<UserBotsConfig>(
            `user:${telegramId}:bots:${exchange}`,
          ),
          this.redisService.get<{
            maxRetry: number;
            currentRetryCount: number;
            volumeReductionPercent: number;
            enabled: boolean;
          }>(`user:${telegramId}:retry:${exchange}`),
          this.redisService.get<number>(
            `user:${telegramId}:maxpos:${exchange}`,
          ),
          this.redisService.get<{ exchange: string }>(
            `user:${telegramId}:active`,
          ),
          this.redisService.get<boolean>(`user:${telegramId}:updates:disabled`),
        ]);

        // Build the $set payload for this exchange
        const exchangeSet: Record<string, any> = {
          [`${exchange}.apiKey`]: apiKeys.apiKey,
          [`${exchange}.apiSecret`]: apiKeys.apiSecret,
          [`${exchange}.createdAt`]: apiKeys.createdAt
            ? new Date(apiKeys.createdAt)
            : new Date(),
          ...(apiKeys.passphrase && {
            [`${exchange}.passphrase`]: apiKeys.passphrase,
          }),
        };

        if (tpData?.percentage != null) {
          exchangeSet[`${exchange}.tpPercentage`] = tpData.percentage;
          exchangeSet[`${exchange}.tpInitialBalance`] =
            tpData.initialBalance ?? 0;
          exchangeSet[`${exchange}.tpSetAt`] = new Date();
        }
        if (tpModeData?.mode) {
          exchangeSet[`${exchange}.tpMode`] = tpModeData.mode;
        }
        if (tpIndividualData?.percentage != null) {
          exchangeSet[`${exchange}.tpIndividualPercentage`] =
            tpIndividualData.percentage;
          exchangeSet[`${exchange}.tpIndividualSetAt`] = new Date();
        }
        if (botsData?.bots?.length) {
          exchangeSet[`${exchange}.bots`] = botsData.bots.map((b) => ({
            botType: b.botType,
            enabled: b.enabled,
            volume: b.volume,
            leverage: b.leverage,
            enabledAt: new Date(b.enabledAt),
            takeProfitPercent: b.takeProfitPercent,
            stopLossPercent: b.stopLossPercent,
          }));
          exchangeSet[`${exchange}.botsUpdatedAt`] = botsData.updatedAt
            ? new Date(botsData.updatedAt)
            : new Date();
        }
        if (retryData) {
          exchangeSet[`${exchange}.retryMaxRetry`] = retryData.maxRetry;
          exchangeSet[`${exchange}.retryCurrentCount`] =
            retryData.currentRetryCount;
          exchangeSet[`${exchange}.retryVolumeReductionPercent`] =
            retryData.volumeReductionPercent;
          exchangeSet[`${exchange}.retryEnabled`] = retryData.enabled;
          exchangeSet[`${exchange}.retrySetAt`] = new Date();
        }
        if (maxPos != null) {
          exchangeSet[`${exchange}.maxPositions`] = maxPos;
        }

        await this.model.findOneAndUpdate(
          { telegramId },
          {
            $set: { ...exchangeSet, chatId: apiKeys.chatId },
            $setOnInsert: {
              telegramId,
              activeExchange: activeEx?.exchange ?? exchange,
              updatesDisabled: updatesDisabled ?? false,
            },
          },
          { upsert: true },
        );

        migrated++;
        this.logger.log(
          `[UserSettings] Migrated user=${telegramId} exchange=${exchange}`,
        );
      } catch (err) {
        this.logger.error(
          `[UserSettings] Migration failed for user=${telegramId} exchange=${exchange}: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `[UserSettings] Migration complete — ${migrated}/${pairs.length} record(s) migrated.`,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Return the exchange sub-document for a user, or null if not set. */
  private getExchangeField(
    doc: UserSettingsDocument,
    exchange: Exchange,
  ): ExchangeSettings | undefined {
    return exchange === "binance" ? doc.binance : doc.okx;
  }

  /** Build an update path prefix, e.g. "binance." or "okx." */
  private p(exchange: Exchange, field: string): string {
    return `${exchange}.${field}`;
  }

  // ─── API Keys ─────────────────────────────────────────────────────────────

  /**
   * Save (upsert) API keys for a user + exchange.
   * Also updates chatId and sets activeExchange if not yet set.
   */
  async saveApiKeys(
    telegramId: number,
    chatId: number,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    passphrase?: string,
  ): Promise<void> {
    const exchangeData: Partial<ExchangeSettings> = {
      apiKey,
      apiSecret,
      createdAt: new Date(),
      ...(passphrase !== undefined && { passphrase }),
    };

    await this.model.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          chatId,
          [exchange]: exchangeData,
        },
        $setOnInsert: {
          telegramId,
          activeExchange: exchange,
          updatesDisabled: false,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Return API keys for a user + exchange in the same shape as the old
   * Redis value, or null if not found.
   */
  async getApiKeys(
    telegramId: number,
    exchange: Exchange,
  ): Promise<UserApiKeys | null> {
    const doc = await this.model
      .findOne({ telegramId }, { telegramId: 1, chatId: 1, [exchange]: 1 })
      .lean();

    if (!doc) return null;
    const ex = exchange === "binance" ? doc.binance : doc.okx;
    if (!ex?.apiKey) return null;

    return {
      telegramId: doc.telegramId,
      chatId: doc.chatId,
      apiKey: ex.apiKey,
      apiSecret: ex.apiSecret,
      passphrase: ex.passphrase,
      exchange,
      createdAt: ex.createdAt?.toISOString() ?? new Date().toISOString(),
    };
  }

  /** Check whether a user has API keys for the given exchange. */
  async hasExchangeAccount(
    telegramId: number,
    exchange: Exchange,
  ): Promise<boolean> {
    const count = await this.model.countDocuments({
      telegramId,
      [`${exchange}.apiKey`]: { $exists: true },
    });
    return count > 0;
  }

  /**
   * Update chatId for all accounts of a user (called on every interaction
   * to ensure chatId is always current).
   */
  async updateChatId(telegramId: number, chatId: number): Promise<void> {
    await this.model.updateOne({ telegramId }, { $set: { chatId } });
  }

  // ─── Active Exchange ───────────────────────────────────────────────────────

  async getActiveExchange(telegramId: number): Promise<Exchange | null> {
    const doc = await this.model
      .findOne(
        { telegramId },
        { activeExchange: 1, "binance.apiKey": 1, "okx.apiKey": 1 },
      )
      .lean();

    if (!doc) return null;
    if (doc.activeExchange) return doc.activeExchange as Exchange;

    // Fallback: use whichever exchange has keys
    if (doc.binance?.apiKey) return "binance";
    if (doc.okx?.apiKey) return "okx";
    return null;
  }

  async setActiveExchange(
    telegramId: number,
    exchange: Exchange,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      { $set: { activeExchange: exchange } },
    );
  }

  // ─── Updates Enabled/Disabled ──────────────────────────────────────────────

  async getUpdatesDisabled(telegramId: number): Promise<boolean> {
    const doc = await this.model
      .findOne({ telegramId }, { updatesDisabled: 1 })
      .lean();
    return doc?.updatesDisabled ?? false;
  }

  async setUpdatesDisabled(
    telegramId: number,
    disabled: boolean,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      { $set: { updatesDisabled: disabled } },
    );
  }

  // ─── TP Aggregate ──────────────────────────────────────────────────────────

  async getTpConfig(
    telegramId: number,
    exchange: Exchange,
  ): Promise<TpConfig | null> {
    const doc = await this.model
      .findOne(
        { telegramId },
        {
          [`${exchange}.tpPercentage`]: 1,
          [`${exchange}.tpInitialBalance`]: 1,
        },
      )
      .lean();

    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    if (ex?.tpPercentage == null) return null;

    return {
      percentage: ex.tpPercentage,
      initialBalance: ex.tpInitialBalance ?? 0,
    };
  }

  async setTpConfig(
    telegramId: number,
    exchange: Exchange,
    percentage: number,
    initialBalance: number,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      {
        $set: {
          [this.p(exchange, "tpPercentage")]: percentage,
          [this.p(exchange, "tpInitialBalance")]: initialBalance,
          [this.p(exchange, "tpSetAt")]: new Date(),
        },
      },
    );
  }

  async clearTpConfig(telegramId: number, exchange: Exchange): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      {
        $unset: {
          [this.p(exchange, "tpPercentage")]: 1,
          [this.p(exchange, "tpInitialBalance")]: 1,
          [this.p(exchange, "tpSetAt")]: 1,
          [this.p(exchange, "tpMode")]: 1,
          [this.p(exchange, "tpIndividualPercentage")]: 1,
          [this.p(exchange, "tpIndividualSetAt")]: 1,
        },
      },
    );
  }

  async hasTpConfig(telegramId: number, exchange: Exchange): Promise<boolean> {
    const count = await this.model.countDocuments({
      telegramId,
      [`${exchange}.tpPercentage`]: { $exists: true, $ne: null },
    });
    return count > 0;
  }

  // ─── TP Mode ───────────────────────────────────────────────────────────────

  async getTpMode(
    telegramId: number,
    exchange: Exchange,
  ): Promise<TpModeConfig | null> {
    const doc = await this.model
      .findOne({ telegramId }, { [`${exchange}.tpMode`]: 1 })
      .lean();
    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    if (!ex?.tpMode) return null;
    return { mode: ex.tpMode as "aggregate" | "individual" };
  }

  async setTpMode(
    telegramId: number,
    exchange: Exchange,
    mode: "aggregate" | "individual",
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      { $set: { [this.p(exchange, "tpMode")]: mode } },
    );
  }

  // ─── TP Individual ─────────────────────────────────────────────────────────

  async getTpIndividual(
    telegramId: number,
    exchange: Exchange,
  ): Promise<TpIndividualConfig | null> {
    const doc = await this.model
      .findOne({ telegramId }, { [`${exchange}.tpIndividualPercentage`]: 1 })
      .lean();
    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    if (ex?.tpIndividualPercentage == null) return null;
    return { percentage: ex.tpIndividualPercentage };
  }

  async setTpIndividual(
    telegramId: number,
    exchange: Exchange,
    percentage: number,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      {
        $set: {
          [this.p(exchange, "tpIndividualPercentage")]: percentage,
          [this.p(exchange, "tpIndividualSetAt")]: new Date(),
        },
      },
    );
  }

  // ─── Bots ──────────────────────────────────────────────────────────────────

  async getBotsConfig(
    telegramId: number,
    exchange: Exchange,
  ): Promise<UserBotsConfig | null> {
    const doc = await this.model
      .findOne(
        { telegramId },
        { [`${exchange}.bots`]: 1, [`${exchange}.botsUpdatedAt`]: 1 },
      )
      .lean();
    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    if (!ex) return null;
    const bots: UserBotConfig[] = (ex.bots ?? []).map((b) => ({
      botType: b.botType,
      enabled: b.enabled,
      volume: b.volume,
      leverage: b.leverage,
      enabledAt:
        b.enabledAt instanceof Date
          ? b.enabledAt.toISOString()
          : String(b.enabledAt),
      takeProfitPercent: b.takeProfitPercent,
      stopLossPercent: b.stopLossPercent,
    }));
    return {
      bots,
      updatedAt:
        ex.botsUpdatedAt instanceof Date
          ? ex.botsUpdatedAt.toISOString()
          : (ex.botsUpdatedAt ?? new Date().toISOString()),
    };
  }

  async setBotsConfig(
    telegramId: number,
    exchange: Exchange,
    config: UserBotsConfig,
  ): Promise<void> {
    const bots = config.bots.map((b) => ({
      botType: b.botType,
      enabled: b.enabled,
      volume: b.volume,
      leverage: b.leverage,
      enabledAt: new Date(b.enabledAt),
      takeProfitPercent: b.takeProfitPercent,
      stopLossPercent: b.stopLossPercent,
    }));

    await this.model.updateOne(
      { telegramId },
      {
        $set: {
          [this.p(exchange, "bots")]: bots,
          [this.p(exchange, "botsUpdatedAt")]: new Date(config.updatedAt),
        },
      },
    );
  }

  async clearBotsConfig(
    telegramId: number,
    exchange: Exchange | "all",
  ): Promise<void> {
    if (exchange === "all") {
      await this.model.updateOne(
        { telegramId },
        {
          $set: {
            "binance.bots": [],
            "okx.bots": [],
          },
        },
      );
    } else {
      await this.model.updateOne(
        { telegramId },
        { $set: { [this.p(exchange, "bots")]: [] } },
      );
    }
  }

  // ─── Retry Config ──────────────────────────────────────────────────────────

  async getRetryConfig(
    telegramId: number,
    exchange: Exchange,
  ): Promise<RetryConfig | null> {
    const doc = await this.model
      .findOne(
        { telegramId },
        {
          [`${exchange}.retryEnabled`]: 1,
          [`${exchange}.retryMaxRetry`]: 1,
          [`${exchange}.retryCurrentCount`]: 1,
          [`${exchange}.retryVolumeReductionPercent`]: 1,
        },
      )
      .lean();
    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    if (!ex?.retryEnabled == null || ex?.retryMaxRetry == null) return null;
    if (!ex.retryEnabled && ex.retryEnabled !== false) return null;

    return {
      maxRetry: ex.retryMaxRetry ?? 0,
      currentRetryCount: ex.retryCurrentCount ?? 0,
      volumeReductionPercent: ex.retryVolumeReductionPercent ?? 15,
      enabled: ex.retryEnabled ?? false,
    };
  }

  async setRetryConfig(
    telegramId: number,
    exchange: Exchange,
    config: RetryConfig,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      {
        $set: {
          [this.p(exchange, "retryMaxRetry")]: config.maxRetry,
          [this.p(exchange, "retryCurrentCount")]: config.currentRetryCount,
          [this.p(exchange, "retryVolumeReductionPercent")]:
            config.volumeReductionPercent,
          [this.p(exchange, "retryEnabled")]: config.enabled,
          [this.p(exchange, "retrySetAt")]: new Date(),
        },
      },
    );
  }

  async clearRetryConfig(
    telegramId: number,
    exchange: Exchange,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      {
        $unset: {
          [this.p(exchange, "retryMaxRetry")]: 1,
          [this.p(exchange, "retryCurrentCount")]: 1,
          [this.p(exchange, "retryVolumeReductionPercent")]: 1,
          [this.p(exchange, "retryEnabled")]: 1,
          [this.p(exchange, "retrySetAt")]: 1,
        },
      },
    );
  }

  // ─── Max Positions ─────────────────────────────────────────────────────────

  async getMaxPositions(
    telegramId: number,
    exchange: Exchange,
  ): Promise<number | null> {
    const doc = await this.model
      .findOne({ telegramId }, { [`${exchange}.maxPositions`]: 1 })
      .lean();
    const ex = exchange === "binance" ? doc?.binance : doc?.okx;
    return ex?.maxPositions ?? null;
  }

  async setMaxPositions(
    telegramId: number,
    exchange: Exchange,
    max: number,
  ): Promise<void> {
    await this.model.updateOne(
      { telegramId },
      { $set: { [this.p(exchange, "maxPositions")]: max } },
    );
  }

  // ─── Cron Query Helpers ────────────────────────────────────────────────────

  /**
   * Return all (telegramId, exchange) pairs that have TP configured.
   * Used by checkTakeProfitTargets and sendPeriodicUpdates crons.
   */
  async findAllUsersWithTp(): Promise<UserWithTp[]> {
    const docs = await this.model
      .find(
        {
          $or: [
            { "binance.tpPercentage": { $exists: true, $ne: null } },
            { "okx.tpPercentage": { $exists: true, $ne: null } },
          ],
        },
        { telegramId: 1, "binance.tpPercentage": 1, "okx.tpPercentage": 1 },
      )
      .lean();

    const result: UserWithTp[] = [];
    for (const doc of docs) {
      if (doc.binance?.tpPercentage != null)
        result.push({ telegramId: doc.telegramId, exchange: "binance" });
      if (doc.okx?.tpPercentage != null)
        result.push({ telegramId: doc.telegramId, exchange: "okx" });
    }
    return result;
  }

  /**
   * Return all (telegramId, exchange) pairs that have at least one bot configured.
   * Used by checkMissingTpSl cron.
   */
  async findAllUsersWithBots(): Promise<UserWithBots[]> {
    const docs = await this.model
      .find(
        {
          $or: [
            { "binance.bots.0": { $exists: true } },
            { "okx.bots.0": { $exists: true } },
          ],
        },
        {
          telegramId: 1,
          "binance.bots": 1,
          "okx.bots": 1,
        },
      )
      .lean();

    const result: UserWithBots[] = [];
    for (const doc of docs) {
      if ((doc.binance?.bots?.length ?? 0) > 0)
        result.push({ telegramId: doc.telegramId, exchange: "binance" });
      if ((doc.okx?.bots?.length ?? 0) > 0)
        result.push({ telegramId: doc.telegramId, exchange: "okx" });
    }
    return result;
  }

  /**
   * Return all users who have a specific botType enabled, along with their
   * API keys and bot config. Used by handleIncomingSignal.
   */
  async findUsersWithBot(botType: string): Promise<UserWithBot[]> {
    const docs = await this.model
      .find(
        {
          $or: [
            {
              "binance.bots": {
                $elemMatch: { botType, enabled: true },
              },
            },
            {
              "okx.bots": {
                $elemMatch: { botType, enabled: true },
              },
            },
          ],
        },
        {
          telegramId: 1,
          chatId: 1,
          "binance.apiKey": 1,
          "binance.apiSecret": 1,
          "binance.passphrase": 1,
          "binance.createdAt": 1,
          "binance.bots": 1,
          "okx.apiKey": 1,
          "okx.apiSecret": 1,
          "okx.passphrase": 1,
          "okx.createdAt": 1,
          "okx.bots": 1,
        },
      )
      .lean();

    const result: UserWithBot[] = [];
    for (const doc of docs) {
      for (const exchange of ["binance", "okx"] as Exchange[]) {
        const ex = exchange === "binance" ? doc.binance : doc.okx;
        if (!ex?.apiKey) continue;
        const bot = ex.bots?.find((b) => b.botType === botType && b.enabled);
        if (!bot) continue;

        const userData: UserApiKeys = {
          telegramId: doc.telegramId,
          chatId: doc.chatId,
          apiKey: ex.apiKey,
          apiSecret: ex.apiSecret,
          passphrase: ex.passphrase,
          exchange,
          createdAt: ex.createdAt?.toISOString() ?? new Date().toISOString(),
        };

        const botConfig: UserBotConfig = {
          botType: bot.botType,
          enabled: bot.enabled,
          volume: bot.volume,
          leverage: bot.leverage,
          enabledAt:
            bot.enabledAt instanceof Date
              ? bot.enabledAt.toISOString()
              : String(bot.enabledAt),
          takeProfitPercent: bot.takeProfitPercent,
          stopLossPercent: bot.stopLossPercent,
        };

        result.push({
          telegramId: doc.telegramId,
          exchange,
          botConfig,
          userData,
        });
      }
    }
    return result;
  }

  /**
   * Return the full settings document for a user (used by /accounts command).
   */
  async getFullSettings(
    telegramId: number,
  ): Promise<UserSettingsDocument | null> {
    return this.model.findOne({ telegramId });
  }
}
