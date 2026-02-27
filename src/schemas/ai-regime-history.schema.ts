import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiRegimeHistoryDocument = AiRegimeHistory & Document;

@Schema({ collection: "ai_regime_history", timestamps: true })
export class AiRegimeHistory {
  @Prop({ required: true, index: true })
  assessedAt: Date;

  // "global" for Sonnet calls, or symbol for Haiku calls
  @Prop({ required: true, index: true })
  scope: string;

  @Prop({ required: true })
  regime: string; // STRONG_TREND | RANGE_BOUND | VOLATILE | BTC_CORRELATION | MIXED

  @Prop({ required: true })
  confidence: number; // 0-100

  @Prop()
  strategy?: string; // recommended strategy (from Haiku per-coin)

  @Prop({ type: Object, default: {} })
  params?: Record<string, any>; // full AiTunedParams

  @Prop()
  model: string; // "claude-haiku-4-5" or "claude-sonnet-4-6"

  @Prop()
  tokensIn?: number;

  @Prop()
  tokensOut?: number;

  @Prop()
  costUsd?: number; // estimated cost in USD
}

export const AiRegimeHistorySchema =
  SchemaFactory.createForClass(AiRegimeHistory);
