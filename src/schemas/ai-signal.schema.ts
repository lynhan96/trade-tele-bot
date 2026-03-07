import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiSignalDocument = AiSignal & Document;

export type SignalDirection = "LONG" | "SHORT";
export type SignalStatus =
  | "ACTIVE"
  | "QUEUED"
  | "COMPLETED"
  | "CANCELLED"
  | "SKIPPED";
export type SignalCloseReason =
  | "POSITION_CLOSED"
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "AUTO_TAKE_PROFIT"
  | "TTL_EXPIRED"
  | "REPLACED_BY_NEW"
  | "MANUAL";

@Schema({ collection: "ai_signals", timestamps: true })
export class AiSignal {
  @Prop({ required: true, index: true })
  symbol: string; // e.g. "BTCUSDT"

  @Prop({ required: true })
  coin: string; // e.g. "btc"

  @Prop({ required: true })
  currency: string; // e.g. "usdt"

  @Prop({ required: true, enum: ["LONG", "SHORT"] })
  direction: SignalDirection;

  @Prop({ required: true })
  entryPrice: number;

  @Prop({ required: true })
  stopLossPrice: number;

  @Prop({ required: true })
  stopLossPercent: number;

  @Prop()
  takeProfitPrice?: number; // Absolute TP price target (Haiku-decided)

  @Prop()
  takeProfitPercent?: number; // % used to calculate takeProfitPrice

  @Prop({ required: true })
  strategy: string; // e.g. "RSI_ZONE", "RSI_CROSS", "TREND_EMA", etc.

  @Prop({ required: true })
  regime: string; // e.g. "STRONG_TREND", "RANGE_BOUND", "VOLATILE", "MIXED"

  @Prop({ required: true, default: 0 })
  aiConfidence: number; // 0-100

  @Prop({ type: Object, default: {} })
  aiParams: Record<string, any>; // The AI-tuned params used to generate this signal

  @Prop({
    required: true,
    enum: ["ACTIVE", "QUEUED", "COMPLETED", "CANCELLED", "SKIPPED"],
    index: true,
  })
  status: SignalStatus;

  @Prop({
    enum: [
      "POSITION_CLOSED",
      "TAKE_PROFIT",
      "STOP_LOSS",
      "AUTO_TAKE_PROFIT",
      "TTL_EXPIRED",
      "REPLACED_BY_NEW",
      "MANUAL",
    ],
  })
  closeReason?: SignalCloseReason;

  @Prop({ required: true, index: true })
  expiresAt: Date; // QUEUED signals expire after 4h; ACTIVE signals expire after 8h

  @Prop()
  executedAt?: Date; // When status changed to ACTIVE

  @Prop({ default: 0 })
  sentToUsers: number; // How many users received this signal

  @Prop({ default: false })
  isTestMode: boolean; // true = signal generated in test mode (no real trades placed)

  @Prop({ default: false })
  slMovedToEntry?: boolean; // true = SL moved to entry (break-even protection)

  @Prop({ default: false })
  sl5PctRaised?: boolean; // true = SL raised to +2% profit at 5% milestone (trailing stop)

  @Prop({ default: false })
  tpBoosted?: boolean; // true = TP extended on volume momentum (one-time per signal)

  @Prop()
  exitPrice?: number; // Filled when status → COMPLETED

  @Prop()
  pnlPercent?: number; // (exitPrice - entryPrice) / entryPrice × 100 (positive = profit for LONG)

  @Prop()
  positionClosedAt?: Date;

  @Prop({ required: true })
  generatedAt: Date; // When signal was first computed

  @Prop()
  primaryKline?: string; // e.g. "15m" or "4h"

  @Prop({ enum: ["INTRADAY", "SWING"], default: "INTRADAY" })
  timeframeProfile?: string; // "INTRADAY" or "SWING"

  @Prop({ type: Object, default: {} })
  indicatorSnapshot: Record<string, any>; // RSI, BB width, etc. at signal time
}

export const AiSignalSchema = SchemaFactory.createForClass(AiSignal);

// Compound index for fast active/queued lookup
AiSignalSchema.index({ symbol: 1, status: 1 });
AiSignalSchema.index({ status: 1, expiresAt: 1 }); // for cleanup cron
