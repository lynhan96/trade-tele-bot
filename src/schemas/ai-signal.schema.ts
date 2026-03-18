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
  slMovedToEntry?: boolean; // true = SL moved to entry at 1.5% profit (break-even protection)

  @Prop()
  peakPnlPct?: number; // highest PnL% reached (for trailing SL calculation)

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

  @Prop({ enum: ["internal", "external"], default: "internal" })
  source?: string; // "internal" = AI scanner, "external" = TCP microservice

  @Prop({ type: Object, default: {} })
  indicatorSnapshot: Record<string, any>; // RSI, BB width, etc. at signal time

  // ─── Grid Recovery (signal-level simulation) ─────────────────────────────
  @Prop({ type: Array, default: [] })
  gridLevels?: Array<{
    level: number; // 0=base, 1-4=grid levels
    deviationPct: number; // % from original entry (dynamic: SL% / (count+1))
    fillPrice: number; // price at which this grid was filled
    exitPrice?: number; // price at which this grid was closed (TP/SL)
    volumePct: number; // % of total volume (DCA: 40,6,12,18,24)
    status: string; // "PENDING" | "FILLED" | "TP_CLOSED" | "SL_CLOSED" | "CANCELLED"
    filledAt?: Date;
    closedAt?: Date;
    pnlPct?: number; // realized PnL for this grid level
    pnlUsdt?: number; // realized PnL USDT
    simNotional?: number; // simulated notional for this grid
    simQuantity?: number; // simulated quantity for this grid
  }>;

  @Prop()
  originalEntryPrice?: number; // base grid fill price (L0)

  @Prop()
  gridGlobalSlPrice?: number; // signal's SL price (not fixed 3.5%)

  @Prop()
  gridAvgEntry?: number; // DCA weighted average entry price

  @Prop({ default: 0 })
  gridFilledCount?: number; // how many grids have been filled

  @Prop({ default: 0 })
  gridClosedCount?: number; // how many grids have been TP/SL-closed

  // ─── Simulated volume (test mode) ──────────────────────────────────────
  @Prop()
  simNotional?: number; // simulated notional USDT (e.g. $1000 balance × 10x leverage)

  @Prop()
  simQuantity?: number; // simulated quantity (simNotional / entryPrice)

  @Prop()
  pnlUsdt?: number; // simulated PnL in USDT (pnlPercent × simNotional / 100)

  // ─── Futures market data at signal time ──────────────────────────────────
  @Prop()
  fundingRate?: number; // e.g. -0.005 = -0.5% per 8h (negative = shorts paying)

  @Prop()
  longShortRatio?: number; // >1 = more longs, <1 = more shorts

  @Prop()
  takerBuyRatio?: number; // >1 = taker buys dominant (aggressive buying)

  @Prop()
  openInterestUsd?: number; // open interest in USD at signal time

  // ─── Auto-Hedge ──────────────────────────────────────────────────────
  @Prop({ default: false })
  hedgeActive?: boolean; // hedge position currently open?

  @Prop({ default: 0 })
  hedgeCycleCount?: number; // completed hedge cycles

  @Prop()
  hedgeEntryPrice?: number; // entry of current hedge

  @Prop()
  hedgeDirection?: string; // LONG/SHORT (opposite of signal)

  @Prop()
  hedgeQuantity?: number; // simulated quantity for hedge

  @Prop()
  hedgeSimNotional?: number; // simulated notional for hedge

  @Prop()
  hedgePhase?: string; // "PARTIAL" (50%) | "FULL" (100%)

  @Prop()
  hedgeTpPrice?: number; // TP price for hedge side

  @Prop()
  hedgeOpenedAt?: Date;

  @Prop()
  originalSlPrice?: number; // SL before hedge improvements (original tight SL)

  @Prop()
  hedgeSafetySlPrice?: number; // wide safety net SL (e.g. -8%)

  @Prop({ type: Array, default: [] })
  hedgeHistory?: Array<{
    cycle: number;
    entryPrice: number;
    exitPrice: number;
    pnlPct: number;
    pnlUsdt: number;
    slImprovement: number;
    openedAt: Date;
    closedAt: Date;
  }>;
}

export const AiSignalSchema = SchemaFactory.createForClass(AiSignal);

// Compound index for fast active/queued lookup
AiSignalSchema.index({ symbol: 1, status: 1 });
AiSignalSchema.index({ status: 1, expiresAt: 1 }); // for cleanup cron
