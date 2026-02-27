import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiCoinProfileDocument = AiCoinProfile & Document;

interface StrategyStats {
  totalSignals: number;
  wins: number;
  avgPnl: number;
  lastUsedAt?: Date;
}

@Schema({ collection: "ai_coin_profiles", timestamps: true })
export class AiCoinProfile {
  @Prop({ required: true, unique: true, index: true })
  symbol: string; // e.g. "BTCUSDT"

  @Prop({ required: true })
  coin: string;

  @Prop({ required: true })
  currency: string;

  // Per-strategy performance stats
  @Prop({ type: Object, default: {} })
  strategyStats: Record<string, StrategyStats>;

  // Last AI assessment
  @Prop()
  lastRegime?: string;

  @Prop()
  lastStrategy?: string;

  @Prop()
  lastAiAssessmentAt?: Date;

  // Cached AI params (last tuned)
  @Prop({ type: Object, default: {} })
  lastAiParams?: Record<string, any>;

  @Prop({ default: true })
  isActive: boolean; // whether coin is on shortlist
}

export const AiCoinProfileSchema = SchemaFactory.createForClass(AiCoinProfile);
