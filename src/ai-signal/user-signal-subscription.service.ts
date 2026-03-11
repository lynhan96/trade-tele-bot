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
  realModeDailyTargetPct?: number;      // cycle target: pause new trades when PnL reaches this %
  realModeDailyStopLossPct?: number;    // cycle SL: close all + disable when PnL drops to this %
  realModeDailyDisabledAt?: Date;       // set when auto-disabled by cycle SL
  cycleResetAt?: Date;                  // when current PnL cycle started
  cyclePeakPct?: number;               // highest PnL% in current cycle (for trailing floor)
  cyclePaused?: boolean;               // true = stop opening new trades (target hit)
  cycleTargetMode?: string;            // "TRAILING" | "CLOSE_ALL"
  // DCA Grid Recovery
  dcaEnabled?: boolean;                // true = split orders into base + safety orders
  dcaMaxOrders?: number;               // max safety orders per position (default: 2)
  dcaBaseOrderPct?: number;            // base order = this % of volume (default: 40%)
  dcaSlFromAvgPct?: number;            // SL distance from avg entry (default: 1.5%)
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
   * Get active subscribers who do NOT have real trading on.
   * These users receive signal notifications (real traders get trade-specific msgs instead).
   */
  async findSignalOnlySubscribers(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({ isActive: true, $or: [{ realModeEnabled: false }, { realModeEnabled: { $exists: false } }] })
      .lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
      tradingBalance: d.tradingBalance ?? 1000,
      coinVolumes: d.coinVolumes as Record<string, number> | undefined,
    }));
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
      customTpPct: d.customTpPct,
      customSlPct: d.customSlPct,
      realModeEnabled: d.realModeEnabled,
      realModeLeverage: d.realModeLeverage,
      realModeLeverageMode: d.realModeLeverageMode ?? "AI",
      realModeDailyTargetPct: d.realModeDailyTargetPct,
      realModeDailyStopLossPct: d.realModeDailyStopLossPct,
      realModeDailyDisabledAt: d.realModeDailyDisabledAt,
      cyclePaused: d.cyclePaused,
      maxOpenPositions: d.maxOpenPositions,
      dcaEnabled: d.dcaEnabled,
      dcaMaxOrders: d.dcaMaxOrders ?? 2,
      dcaBaseOrderPct: d.dcaBaseOrderPct ?? 40,
      dcaSlFromAvgPct: d.dcaSlFromAvgPct ?? 1.5,
    }));
  }

  /**
   * Find real-mode subscribers who have at least one cycle limit configured
   * and whose real mode is currently enabled (not disabled by SL).
   */
  async findRealModeSubscribersWithCycleLimits(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel
      .find({
        isActive: true,
        realModeEnabled: true,
        $or: [
          { realModeDailyTargetPct: { $gt: 0 } },
          { realModeDailyStopLossPct: { $gt: 0 } },
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
      cycleResetAt: d.cycleResetAt,
      cyclePeakPct: d.cyclePeakPct,
      cyclePaused: d.cyclePaused,
      cycleTargetMode: d.cycleTargetMode ?? "TRAILING",
    }));
  }

  /**
   * Find users whose real mode was auto-disabled by cycle SL on a previous day
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
   * Atomically increment cumulative PnL stats when a trade closes.
   */
  async incrementTradePnl(telegramId: number, pnlUsdt: number): Promise<void> {
    const isWin = pnlUsdt >= 0;
    await this.subscriptionModel.updateOne(
      { telegramId },
      {
        $inc: {
          totalPnlUsdt: pnlUsdt,
          ...(isWin ? { totalWins: 1 } : { totalLosses: 1 }),
        },
      },
    );
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

  /**
   * Set or clear cycle reset timestamp. All trades after this date count toward the current cycle.
   */
  async setCycleResetAt(telegramId: number, date: Date | null): Promise<void> {
    if (date == null) {
      await this.subscriptionModel.findOneAndUpdate(
        { telegramId },
        { $unset: { cycleResetAt: 1, cyclePeakPct: 1, cyclePaused: 1 } },
      );
    } else {
      await this.subscriptionModel.findOneAndUpdate(
        { telegramId },
        { $set: { cycleResetAt: date, cyclePeakPct: 0, cyclePaused: false } },
      );
    }
  }

  /** Update cycle peak PnL% (for trailing floor calculation). */
  async setCyclePeakPct(telegramId: number, peakPct: number): Promise<void> {
    await this.subscriptionModel.findOneAndUpdate(
      { telegramId },
      { $set: { cyclePeakPct: peakPct } },
    );
  }

  /** Set or clear the cyclePaused flag (stop opening new trades). */
  async setCyclePaused(telegramId: number, paused: boolean): Promise<void> {
    await this.subscriptionModel.findOneAndUpdate(
      { telegramId },
      { $set: { cyclePaused: paused } },
    );
  }
}
