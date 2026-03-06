import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type DailyLimitHistoryDocument = DailyLimitHistory & Document;

/**
 * Records every daily TP/SL limit hit event for a user.
 * Used for user history view and admin monitoring.
 */
@Schema({ collection: "daily_limit_history", timestamps: true })
export class DailyLimitHistory {
  @Prop({ required: true })
  telegramId: number;

  @Prop()
  username?: string;

  @Prop({ required: true })
  type: string; // "DAILY_TARGET" | "DAILY_STOP_LOSS"

  @Prop({ required: true })
  pnlUsdt: number; // total PnL in USDT at time of trigger

  @Prop({ required: true })
  pnlPct: number; // total PnL % at time of trigger

  @Prop({ required: true })
  limitPct: number; // the configured limit % that was hit

  @Prop({ required: true })
  positionsClosed: number; // number of positions closed

  @Prop({ required: true })
  triggeredAt: Date;
}

export const DailyLimitHistorySchema = SchemaFactory.createForClass(DailyLimitHistory);
DailyLimitHistorySchema.index({ telegramId: 1, triggeredAt: -1 });
DailyLimitHistorySchema.index({ triggeredAt: -1 });
