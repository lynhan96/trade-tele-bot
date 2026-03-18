import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ collection: 'orders', timestamps: true })
export class Order {
  @Prop({ required: true, type: Types.ObjectId, ref: 'AiSignal' })
  signalId: Types.ObjectId;

  @Prop({ required: true })
  symbol: string;

  @Prop({ required: true, enum: ['LONG', 'SHORT'] })
  direction: string;

  @Prop({ required: true, enum: ['MAIN', 'DCA', 'HEDGE'] })
  type: string;

  @Prop({ required: true, enum: ['OPEN', 'CLOSED'] })
  status: string;

  @Prop({ required: true })
  entryPrice: number;

  @Prop()
  exitPrice: number;

  @Prop({ required: true })
  notional: number;

  @Prop()
  quantity: number;

  @Prop()
  pnlPercent: number;

  @Prop()
  pnlUsdt: number;

  @Prop()
  closeReason: string;

  @Prop()
  openedAt: Date;

  @Prop()
  closedAt: Date;

  @Prop({ default: 0 })
  cycleNumber: number;

  @Prop({ type: Object })
  metadata: Record<string, any>;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ signalId: 1, status: 1 });
OrderSchema.index({ symbol: 1, type: 1, status: 1 });
