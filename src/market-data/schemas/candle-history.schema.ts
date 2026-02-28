import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type CandleHistoryDocument = CandleHistory & Document;

/**
 * Persistent candle record written on every closed candle (WebSocket isFinal=true).
 * Also bulk-seeded from Binance REST on startup (500 candles per symbol/interval).
 *
 * Redis holds the live rolling window (last 500, 7-day TTL) for fast indicator reads.
 * This collection is the durable audit trail for debugging and post-mortem analysis.
 */
@Schema({ collection: "candle_history", timestamps: true })
export class CandleHistory {
  /** e.g. "BTCUSDT" */
  @Prop({ required: true })
  symbol: string;

  /** e.g. "5m", "15m", "1h", "4h", "1d" */
  @Prop({ required: true })
  interval: string;

  /** Candle close timestamp (Binance field T / REST index 6) */
  @Prop({ required: true })
  closeTime: Date;

  @Prop({ required: true })
  open: number;

  @Prop({ required: true })
  high: number;

  @Prop({ required: true })
  low: number;

  @Prop({ required: true })
  close: number;

  /** Base-asset volume — not stored in Redis, available here for analysis */
  @Prop({ required: true })
  volume: number;
}

export const CandleHistorySchema = SchemaFactory.createForClass(CandleHistory);

/**
 * Unique compound index: prevents duplicate candles on WS reconnect or re-seed.
 * MongoDB will silently ignore the duplicate-key error from the upsert.
 */
CandleHistorySchema.index(
  { symbol: 1, interval: 1, closeTime: 1 },
  { unique: true },
);

/** Fast descending time-range queries for debugging / analysis. */
CandleHistorySchema.index({ symbol: 1, interval: 1, closeTime: -1 });

/** Auto-expire candles older than 30 days to prevent unbounded collection growth. */
CandleHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
