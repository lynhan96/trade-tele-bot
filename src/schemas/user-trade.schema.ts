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

  // ─── Grid Recovery ─────────────────────────────────────────────────────
  @Prop({ type: Array, default: [] })
  gridLevels?: Array<{
    level: number; // 0=base, 1-4=grid levels
    deviationPct: number; // % from original entry
    fillPrice: number;
    quantity: number; // base asset qty for this grid
    tpPrice: number; // individual TP price
    binanceTpAlgoId?: string; // algo TP order for this grid
    volumePct: number;
    status: string; // "PENDING" | "FILLED" | "TP_CLOSED" | "SL_CLOSED"
    filledAt?: Date;
    closedAt?: Date;
    pnlPct?: number;
  }>;

  @Prop()
  originalEntryPrice?: number; // base grid fill price

  @Prop()
  gridGlobalSlPrice?: number; // global SL price

  @Prop({ default: 0 })
  gridFilledCount?: number;

  @Prop({ default: 0 })
  gridClosedCount?: number;

  // ─── Auto-Hedge ──────────────────────────────────────────────────────
  @Prop({ default: false })
  isHedge?: boolean; // this trade is a hedge (don't count in position slots)

  @Prop()
  parentTradeId?: string; // ref to the original trade being hedged

  @Prop()
  hedgeCycle?: number; // which hedge cycle (1, 2, 3)

  @Prop()
  hedgePhase?: string; // "PARTIAL" | "FULL"
}

export const UserTradeSchema = SchemaFactory.createForClass(UserTrade);
UserTradeSchema.index({ telegramId: 1, status: 1 });
UserTradeSchema.index({ symbol: 1, status: 1 });
