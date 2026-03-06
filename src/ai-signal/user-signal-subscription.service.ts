import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  UserSignalSubscription,
  UserSignalSubscriptionDocument,
} from "../schemas/user-signal-subscription.schema";

export interface SubscriberInfo {
  telegramId: number;
  chatId: number;
  username?: string;
  tradingBalance?: number;              // per-user USDT per trade (default: 1000)
  coinVolumes?: Record<string, number>; // per-coin USDT override, e.g. { BTC: 5000 }
  customTpPct?: number;                 // custom TP% for display (null = use AI TP price)
  customSlPct?: number;                 // custom SL% for display (null = use AI SL price)
  profitTarget?: number;                // USDT profit target (null = disabled)
  profitTargetNotified?: boolean;       // already notified for this cycle
  realModeEnabled?: boolean;            // true = place real Binance orders
  maxOpenPositions?: number;            // max concurrent positions (default: 3)
  realModeLeverage?: number;            // fixed leverage value (only used when mode = FIXED)
  realModeLeverageMode?: string;        // "AI" | "FIXED" | "MAX"
  realModeDailyTargetPct?: number;      // close all + disable when daily PnL reaches this % (e.g. 5 = +5%)
  realModeDailyStopLossPct?: number;    // close all + disable when daily PnL drops to this % (e.g. 3 = -3%)
  realModeDailyDisabledAt?: Date;       // set when auto-disabled by daily limit
}

@Injectable()
export class UserSignalSubscriptionService {
  private readonly logger = new Logger(UserSignalSubscriptionService.name);

  constructor(
    @InjectModel(UserSignalSubscription.name)
    private readonly subscriptionModel: Model<UserSignalSubscriptionDocument>,
  ) {}

  /**
   * Subscribe a user to AI signal notifications.
   * Idempotent — re-activates if previously unsubscribed.
   */
  async subscribe(telegramId: number, chatId: number, username?: string): Promise<boolean> {
    const existing = await this.subscriptionModel.findOne({ telegramId });

    if (existing) {
      if (existing.isActive) return false; // already subscribed
      await this.subscriptionModel.findByIdAndUpdate(existing._id, {
        isActive: true,
        chatId,
        username,
        subscribedAt: new Date(),
        unsubscribedAt: undefined,
      });
      this.logger.log(`[SignalSubscription] Re-subscribed user ${telegramId}`);
      return true;
    }

    await this.subscriptionModel.create({
      telegramId,
      chatId,
      username,
      isActive: true,
      subscribedAt: new Date(),
    });
    this.logger.log(`[SignalSubscription] New subscriber: ${telegramId} (${username ?? "no username"})`);
    return true;
  }

  /**
   * Get active subscribers who have real mode enabled.
   */
  async findRealModeSubscribers(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({ isActive: true, realModeEnabled: true })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      tradingBalance: d.tradingBalance ?? 1000,
      coinVolumes: d.coinVolumes as Record<string, number> | undefined,
      realModeEnabled: d.realModeEnabled,
      realModeLeverage: d.realModeLeverage,
      realModeLeverageMode: d.realModeLeverageMode ?? "AI",
      realModeDailyTargetPct: d.realModeDailyTargetPct,
      realModeDailyStopLossPct: d.realModeDailyStopLossPct,
      realModeDailyDisabledAt: d.realModeDailyDisabledAt,
      maxOpenPositions: d.maxOpenPositions,
    }));
  }

  /**
   * Find real-mode subscribers who have at least one daily limit configured
   * and whose real mode is currently enabled (not disabled today).
   */
  async findRealModeSubscribersWithDailyLimits(): Promise<SubscriberInfo[]> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const docs = await this.subscriptionModel
      .find({
        isActive: true,
        realModeEnabled: true,
        $and: [
          {
            $or: [
              { realModeDailyTargetPct: { $gt: 0 } },
              { realModeDailyStopLossPct: { $gt: 0 } },
            ],
          },
          {
            // Only check users who have NOT been disabled today
            $or: [
              { realModeDailyDisabledAt: { $lt: startOfToday } },
              { realModeDailyDisabledAt: null },
              { realModeDailyDisabledAt: { $exists: false } },
            ],
          },
        ],
      })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      tradingBalance: d.tradingBalance ?? 1000,
      coinVolumes: d.coinVolumes as Record<string, number> | undefined,
      realModeEnabled: d.realModeEnabled,
      realModeLeverage: d.realModeLeverage,
      realModeLeverageMode: d.realModeLeverageMode ?? "AI",
      realModeDailyTargetPct: d.realModeDailyTargetPct,
      realModeDailyStopLossPct: d.realModeDailyStopLossPct,
      realModeDailyDisabledAt: d.realModeDailyDisabledAt,
    }));
  }

  /**
   * Find users whose real mode was auto-disabled by daily limit on a previous day
   * (for next-day reset cron).
   */
  async findUsersForDailyReset(): Promise<SubscriberInfo[]> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const docs = await this.subscriptionModel
      .find({
        isActive: true,
        realModeDailyDisabledAt: { $lt: startOfToday },
      })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      realModeDailyTargetPct: d.realModeDailyTargetPct,
      realModeDailyStopLossPct: d.realModeDailyStopLossPct,
    }));
  }

  /**
   * Get active subscribers who have money flow alerts enabled.
   */
  async findMoneyFlowSubscribers(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({ isActive: true, moneyFlowEnabled: { $ne: false } })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
    }));
  }

  /**
   * Toggle money flow alerts for a user. Returns new state.
   */
  async toggleMoneyFlow(telegramId: number, enabled: boolean): Promise<boolean | null> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    if (!doc) return null; // not subscribed
    await this.subscriptionModel.findByIdAndUpdate(doc._id, { moneyFlowEnabled: enabled });
    return enabled;
  }

  /**
   * Get active subscribers who have signals push enabled.
   */
  async findSignalsPushSubscribers(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({ isActive: true, signalsPushEnabled: true })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      tradingBalance: d.tradingBalance ?? 1000,
      coinVolumes: d.coinVolumes as Record<string, number> | undefined,
      customTpPct: d.customTpPct,
      customSlPct: d.customSlPct,
    }));
  }

  /**
   * Toggle signals push for a user. Returns new state.
   */
  async toggleSignalsPush(telegramId: number, enabled: boolean): Promise<boolean | null> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    if (!doc) return null;
    await this.subscriptionModel.findByIdAndUpdate(doc._id, { signalsPushEnabled: enabled });
    return enabled;
  }

  /**
   * Set per-user trading balance for USDT PnL display.
   */
  async setTradingBalance(telegramId: number, balance: number): Promise<boolean> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    if (!doc) return false;
    await this.subscriptionModel.findByIdAndUpdate(doc._id, { tradingBalance: balance });
    return true;
  }

  /**
   * Set per-coin volume override. Pass null to remove override for that coin.
   * Uses atomic $set / $unset with dot notation to avoid race conditions.
   */
  async setCoinVolume(telegramId: number, coin: string, volume: number | null): Promise<boolean> {
    const update = volume === null
      ? { $unset: { [`coinVolumes.${coin}`]: 1 } }
      : { $set: { [`coinVolumes.${coin}`]: volume } };
    const result = await this.subscriptionModel.findOneAndUpdate(
      { telegramId, isActive: true },
      update,
    );
    return !!result;
  }

  /**
   * Set per-user custom TP/SL percentages for signal display.
   */
  async setCustomTpSl(telegramId: number, tpPct: number, slPct: number): Promise<boolean> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    if (!doc) return false;
    await this.subscriptionModel.findByIdAndUpdate(doc._id, { customTpPct: tpPct, customSlPct: slPct });
    return true;
  }

  /**
   * Clear custom TP/SL — revert to using AI-generated prices.
   */
  async clearCustomTpSl(telegramId: number): Promise<boolean> {
    const result = await this.subscriptionModel.findOneAndUpdate(
      { telegramId, isActive: true },
      { $unset: { customTpPct: 1, customSlPct: 1 } },
    );
    return !!result;
  }

  /**
   * Mark profit target as notified (prevent spam) or reset (re-enable after positions clear).
   */
  async setProfitTargetNotified(telegramId: number, notified: boolean): Promise<void> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    if (!doc) return;
    await this.subscriptionModel.findByIdAndUpdate(doc._id, { profitTargetNotified: notified });
  }

  /**
   * Find all subscribers who have a profit target set (for monitoring).
   */
  async findSubscribersWithProfitTarget(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({ isActive: true, profitTarget: { $gt: 0 } })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      tradingBalance: d.tradingBalance ?? 1000,
      coinVolumes: d.coinVolumes as Record<string, number> | undefined,
      profitTarget: d.profitTarget,
      profitTargetNotified: d.profitTargetNotified,
    }));
  }

  /**
   * Get subscription details for a given user.
   */
  async getSubscription(telegramId: number): Promise<UserSignalSubscriptionDocument | null> {
    return this.subscriptionModel.findOne({ telegramId, isActive: true });
  }

  /**
   * Count total active subscribers.
   */
  async countActive(): Promise<number> {
    return this.subscriptionModel.countDocuments({ isActive: true });
  }

  /**
   * Enable or disable real mode for a subscriber.
   */
  async setRealMode(telegramId: number, enabled: boolean): Promise<boolean> {
    const result = await this.subscriptionModel.findOneAndUpdate(
      { telegramId, isActive: true },
      { realModeEnabled: enabled },
    );
    return !!result;
  }

  /**
   * Set leverage mode for real trading.
   * mode: "AI" = use signal leverage, "FIXED" = use value, "MAX" = query Binance per pair
   */
  async setRealModeLeverage(
    telegramId: number,
    mode: "AI" | "FIXED" | "MAX",
    value?: number,
  ): Promise<boolean> {
    const update: Record<string, any> = { realModeLeverageMode: mode };
    if (mode === "FIXED" && value != null) update.realModeLeverage = value;
    const result = await this.subscriptionModel.findOneAndUpdate(
      { telegramId, isActive: true },
      { $set: update },
    );
    return !!result;
  }

  /** Set (or clear) daily profit target %. null = disable. */
  async setDailyTargetPct(telegramId: number, pct: number | null): Promise<boolean> {
    const update = pct == null
      ? { $unset: { realModeDailyTargetPct: 1 } }
      : { $set: { realModeDailyTargetPct: pct } };
    const result = await this.subscriptionModel.findOneAndUpdate({ telegramId, isActive: true }, update);
    return !!result;
  }

  /** Set (or clear) daily stop loss %. null = disable. */
  async setDailyStopLossPct(telegramId: number, pct: number | null): Promise<boolean> {
    const update = pct == null
      ? { $unset: { realModeDailyStopLossPct: 1 } }
      : { $set: { realModeDailyStopLossPct: pct } };
    const result = await this.subscriptionModel.findOneAndUpdate({ telegramId, isActive: true }, update);
    return !!result;
  }

  /** Set max concurrent open positions for a user. */
  async setMaxOpenPositions(telegramId: number, max: number): Promise<boolean> {
    const result = await this.subscriptionModel.findOneAndUpdate(
      { telegramId, isActive: true },
      { $set: { maxOpenPositions: max } },
    );
    return !!result;
  }

  /**
   * Set or clear the daily-disabled timestamp.
   * Pass a Date to mark as disabled; pass null to clear (re-enable for next day).
   */
  async setRealModeDailyDisabled(telegramId: number, date: Date | null): Promise<void> {
    if (date == null) {
      await this.subscriptionModel.findOneAndUpdate(
        { telegramId },
        { $unset: { realModeDailyDisabledAt: 1 } },
      );
    } else {
      await this.subscriptionModel.findOneAndUpdate(
        { telegramId },
        { $set: { realModeDailyDisabledAt: date } },
      );
    }
  }
}
