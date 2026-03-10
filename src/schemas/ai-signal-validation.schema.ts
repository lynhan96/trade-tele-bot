import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiSignalValidationDocument = AiSignalValidation & Document;

@Schema({ collection: "ai_signal_validations", timestamps: true })
export class AiSignalValidation {
  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true, enum: ["LONG", "SHORT"] })
  direction: string;

  @Prop({ required: true })
  strategy: string;

  @Prop({ required: true })
  regime: string;

  @Prop({ required: true })
  confidence: number;

  @Prop({ required: true })
  stopLossPercent: number;

  @Prop({ required: true })
  takeProfitPercent: number;

  @Prop({ required: true })
  approved: boolean;

  @Prop()
  reason?: string;

  @Prop({ default: "rule-engine" })
  model: string;

  @Prop()
  pricePosition?: number; // 0-100, where price sits in recent range

  @Prop()
  candleMomentum?: number; // aligned candles out of 3

  @Prop()
  rsiValue?: number;

  @Prop()
  htfRsiValue?: number;

  @Prop([String])
  rejectedBy?: string[]; // which filters rejected: ["price_position", "candle_momentum", etc.]
}

export const AiSignalValidationSchema =
  SchemaFactory.createForClass(AiSignalValidation);

AiSignalValidationSchema.index({ approved: 1 });
AiSignalValidationSchema.index({ createdAt: -1 });
