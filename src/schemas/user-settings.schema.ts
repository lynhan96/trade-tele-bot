import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type UserSettingsDocument = UserSettings & Document;

// ─── Nested: BotConfigEntry ───────────────────────────────────────────────

@Schema({ _id: false })
export class BotConfigEntry {
  @Prop({ required: true })
  botType: string; // e.g. "BOT_FUTURE_CT_1"

  @Prop({ required: true, default: true })
  enabled: boolean;

  @Prop({ required: true })
  volume: number; // USDT per order

  @Prop({ required: true })
  leverage: number; // e.g. 10

  @Prop({ required: true })
  enabledAt: Date;

  @Prop()
  takeProfitPercent?: number;

  @Prop()
  stopLossPercent?: number;
}

// ─── Nested: ExchangeSettings ─────────────────────────────────────────────

@Schema({ _id: false })
export class ExchangeSettings {
  // API credentials
  @Prop({ required: true })
  apiKey: string;

  @Prop({ required: true })
  apiSecret: string;

  @Prop()
  passphrase?: string; // OKX only

  @Prop({ required: true })
  createdAt: Date;

  // ── TP Aggregate config ──
  @Prop()
  tpPercentage?: number; // target % relative to initialBalance

  @Prop()
  tpInitialBalance?: number; // reference balance for aggregate TP

  @Prop()
  tpSetAt?: Date;

  // ── TP mode ──
  @Prop({ enum: ["aggregate", "individual"] })
  tpMode?: string; // "aggregate" | "individual"

  // ── TP Individual config ──
  @Prop()
  tpIndividualPercentage?: number; // per-position TP %

  @Prop()
  tpIndividualSetAt?: Date;

  // ── Bot Signal configs ──
  @Prop({ type: [Object], default: [] })
  bots: BotConfigEntry[];

  @Prop()
  botsUpdatedAt?: Date;

  // ── Re-entry / Retry config ──
  @Prop()
  retryMaxRetry?: number;

  @Prop()
  retryCurrentCount?: number; // counts down from maxRetry

  @Prop()
  retryVolumeReductionPercent?: number; // % volume reduction per retry

  @Prop()
  retryEnabled?: boolean;

  @Prop()
  retrySetAt?: Date;

  // ── Max open positions ──
  @Prop()
  maxPositions?: number;
}

// ─── Root: UserSettings ───────────────────────────────────────────────────

@Schema({ collection: "user_settings", timestamps: true })
export class UserSettings {
  @Prop({ required: true, unique: true, index: true })
  telegramId: number;

  @Prop()
  chatId?: number;

  @Prop({ enum: ["binance", "okx"] })
  activeExchange?: string;

  @Prop({ default: false })
  updatesDisabled: boolean;

  @Prop({ type: Object })
  binance?: ExchangeSettings;

  @Prop({ type: Object })
  okx?: ExchangeSettings;
}

export const UserSettingsSchema = SchemaFactory.createForClass(UserSettings);

// Compound indexes for cron queries
UserSettingsSchema.index({ "binance.tpPercentage": 1 });
UserSettingsSchema.index({ "okx.tpPercentage": 1 });
UserSettingsSchema.index({ "binance.bots": 1 });
UserSettingsSchema.index({ "okx.bots": 1 });
