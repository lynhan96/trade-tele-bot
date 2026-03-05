import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type UserTradeDocument = UserTrade & Document;

/**
 * Records every real order placed on behalf of a user in real mode.
 * Created when a signal activates and the user has realModeEnabled = true.
 */
@Schema({ collection: "user_trades", timestamps: true })
export class UserTrade {
  @Prop({ required: true })
  telegramId: number;

  @Prop({ required: true })
  chatId: number;

  @Prop({ required: true })
  symbol: string; // e.g. "BTCUSDT"

  @Prop({ required: true })
  direction: string; // "LONG" | "SHORT"

  @Prop({ required: true })
  entryPrice: number; // actual fill price (may differ from signal entry)

  @Prop({ required: true })
  quantity: number; // base asset quantity (e.g. 0.05 for 0.05 BTC)

  @Prop({ required: true })
  leverage: number;

  @Prop({ required: true })
  notionalUsdt: number; // quantity × entryPrice

  @Prop({ required: true })
  slPrice: number; // current SL price (updated as SL moves)

  @Prop()
  tpPrice?: number;

  @Prop()
  binanceOrderId?: string; // market order ID (missing for orphan positions)

  @Prop()
  binanceSlAlgoId?: string; // algo SL order algoId (for cancellation when moving SL)

  @Prop()
  binanceTpAlgoId?: string; // algo TP order algoId

  @Prop({ required: true, default: "OPEN" })
  status: string; // "OPEN" | "CLOSED"

  @Prop()
  closeReason?: string; // "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "PROFIT_TARGET"

  @Prop()
  exitPrice?: number;

  @Prop()
  pnlPercent?: number;

  @Prop()
  pnlUsdt?: number;

  @Prop({ required: true })
  openedAt: Date;

  @Prop()
  closedAt?: Date;

  @Prop()
  aiSignalId?: string; // ref to AiSignal._id
}

export const UserTradeSchema = SchemaFactory.createForClass(UserTrade);
UserTradeSchema.index({ telegramId: 1, status: 1 });
UserTradeSchema.index({ symbol: 1, status: 1 });
