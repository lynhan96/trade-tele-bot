import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AgentEventDocument = AgentEvent & Document;

@Schema({ collection: 'agent_events', timestamps: true })
export class AgentEvent {
  @Prop({ required: true, enum: ['THOUGHT', 'DECISION', 'ACTION', 'LEARNING', 'ERROR', 'REPORT'] })
  type: string;

  @Prop({ required: true, enum: ['market_analyzer', 'position_manager', 'bug_detector', 'strategy_tuner', 'active_trader', 'signal_filter', 'portfolio_risk', 'post_trade', 'smart_alert'] })
  agent: string;

  @Prop({ required: true })
  message: string;

  @Prop()
  details: string;

  @Prop({ type: Object })
  data: Record<string, any>;

  @Prop({ enum: ['thinking', 'acting', 'done', 'error'] })
  status: string;

  @Prop()
  symbol: string;

  @Prop()
  actionType: string; // CLOSE_SIGNAL, UPDATE_CONFIG, etc.

  @Prop({ type: Object })
  outcome: Record<string, any>;

  @Prop({ default: Date.now })
  eventAt: Date;
}

export const AgentEventSchema = SchemaFactory.createForClass(AgentEvent);
AgentEventSchema.index({ eventAt: -1 });
AgentEventSchema.index({ agent: 1, eventAt: -1 });
AgentEventSchema.index({ type: 1, eventAt: -1 });
// TTL: auto-delete after 7 days
AgentEventSchema.index({ eventAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
