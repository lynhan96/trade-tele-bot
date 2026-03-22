import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OnChainSnapshotDocument = OnChainSnapshot & Document;

@Schema({ collection: 'onchain_snapshots', timestamps: true })
export class OnChainSnapshot {
  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true })
  direction: string; // LONG or SHORT

  @Prop()
  price: number;

  // Funding Rate
  @Prop()
  fundingRate: number; // raw rate (e.g. 0.0001)

  @Prop()
  fundingRatePct: number; // percentage (e.g. 0.01%)

  // Open Interest
  @Prop()
  openInterest: number; // in contracts

  @Prop()
  openInterestUsd: number;

  @Prop()
  oiChangePct: number; // % change from previous snapshot

  // Long/Short Ratio
  @Prop()
  longShortRatio: number;

  @Prop()
  longPercent: number;

  @Prop()
  shortPercent: number;

  // Taker Buy/Sell
  @Prop()
  takerBuyRatio: number;

  // Filter Results
  @Prop()
  filterPassed: boolean; // overall pass/block

  @Prop({ type: [String] })
  filterReasons: string[]; // detailed reasons

  @Prop({ type: [String] })
  blockedBy: string[]; // which filters blocked

  // Context
  @Prop()
  regime: string; // market regime at time of snapshot

  @Prop()
  signalId: string; // if this was for a specific signal evaluation

  @Prop({ index: true })
  snapshotAt: Date;
}

export const OnChainSnapshotSchema = SchemaFactory.createForClass(OnChainSnapshot);
OnChainSnapshotSchema.index({ symbol: 1, snapshotAt: -1 });
OnChainSnapshotSchema.index({ snapshotAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }); // TTL 30 days
