import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AiReviewDocument = AiReview & Document;

@Schema({ collection: "ai_reviews", timestamps: true })
export class AiReview {
  @Prop({ required: true })
  type: string; // "strategy_review"

  @Prop({ type: Object })
  context: Record<string, any>; // input data sent to AI

  @Prop({ type: Object })
  actions: Record<string, any>; // AI response (parsed JSON)

  @Prop()
  reasoning: string;

  @Prop({ type: [String], default: [] })
  appliedActions: string[]; // human-readable list of what was applied

  @Prop({ default: 0 })
  signalsAnalyzed: number;

  @Prop()
  regime: string;

  @Prop({ default: 0 })
  btcPrice: number;

  @Prop({ default: "claude-haiku-4-5" })
  model: string;

  @Prop()
  createdAt: Date;
}

export const AiReviewSchema = SchemaFactory.createForClass(AiReview);
