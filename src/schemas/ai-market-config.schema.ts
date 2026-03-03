import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiMarketConfigDocument = AiMarketConfig & Document;

/**
 * Stores AI-decided coin filter settings per market regime.
 * Records are used as conversation history for the next Haiku decision.
 */
@Schema({ collection: "ai_market_configs", timestamps: true })
export class AiMarketConfig {
  @Prop({ required: true, index: true })
  assessedAt: Date;

  @Prop({ required: true })
  regime: string; // market regime at time of decision

  @Prop({ required: true })
  minVolumeUsd: number; // recommended min 24h volume (USD)

  @Prop({ required: true })
  minPriceChangePct: number; // recommended min absolute price change %

  @Prop({ required: true })
  maxShortlistSize: number; // recommended max number of coins to scan

  @Prop()
  reasoning?: string; // Haiku's explanation for the decision

  @Prop({ required: true })
  model: string; // model that made the decision

  @Prop()
  tokensIn?: number;

  @Prop()
  tokensOut?: number;
}

export const AiMarketConfigSchema = SchemaFactory.createForClass(AiMarketConfig);

AiMarketConfigSchema.index({ assessedAt: -1 }); // fast history fetch
