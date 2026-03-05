import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type UserSignalSubscriptionDocument = UserSignalSubscription & Document;

/**
 * Stores which users have subscribed to receive AI signal notifications.
 * Users opt-in via /ai subscribe and opt-out via /ai unsubscribe.
 * Replaces the Redis-scan approach for scalability (supports many users).
 */
@Schema({ collection: "user_signal_subscriptions", timestamps: true })
export class UserSignalSubscription {
  @Prop({ required: true, unique: true })
  telegramId: number; // Telegram user ID

  @Prop({ required: true })
  chatId: number; // Chat ID to send notifications to

  @Prop()
  username?: string; // Telegram username (optional, for display)

  @Prop({ required: true, default: true })
  isActive: boolean; // false = unsubscribed

  @Prop({ required: true, default: true })
  moneyFlowEnabled: boolean; // false = opted out of money flow alerts

  @Prop({ required: true, default: false })
  signalsPushEnabled: boolean; // true = receive signals update every 10 min

  @Prop({ default: 1000 })
  tradingBalance?: number; // USDT per trade for PnL display (default: 1000)

  @Prop({ type: Object, default: {} })
  coinVolumes?: Record<string, number>; // per-coin USDT override, e.g. { BTC: 5000 }

  @Prop()
  customTpPct?: number; // user's custom TP% for signal display (null = use AI TP price)

  @Prop()
  customSlPct?: number; // user's custom SL% for signal display (null = use AI SL price)

  @Prop()
  profitTarget?: number; // USDT total profit target — notify (and close all) when reached

  @Prop({ default: false })
  profitTargetNotified?: boolean; // true = already notified for current cycle (prevent spam)

  @Prop({ default: false })
  realModeEnabled?: boolean; // true = place real orders on Binance when signals activate

  @Prop()
  realModeLeverage?: number; // only used when realModeLeverageMode is "FIXED"

  @Prop({ default: "AI" })
  realModeLeverageMode?: string; // "AI" = use signal leverage, "FIXED" = fixed value, "MAX" = query Binance

  @Prop()
  realModeDailyTargetPct?: number; // auto-close all + disable real mode when daily PnL reaches this % (e.g. 5 = +5%)

  @Prop()
  realModeDailyStopLossPct?: number; // auto-close all + disable real mode when daily PnL drops to this % (e.g. 3 = -3%)

  @Prop()
  realModeDailyDisabledAt?: Date; // set when auto-disabled by daily limit; cleared on next-day reset

  @Prop({ default: 3 })
  maxOpenPositions?: number; // max concurrent real positions per user (default: 3)

  @Prop({ required: true, default: new Date() })
  subscribedAt: Date;

  @Prop()
  unsubscribedAt?: Date;
}

export const UserSignalSubscriptionSchema = SchemaFactory.createForClass(
  UserSignalSubscription,
);

// Fast lookup by isActive status (telegramId index already created by unique: true)
UserSignalSubscriptionSchema.index({ isActive: 1 });
