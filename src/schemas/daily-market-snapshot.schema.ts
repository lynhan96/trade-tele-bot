import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type DailyMarketSnapshotDocument = DailyMarketSnapshot & Document;

@Schema({ collection: "daily_market_snapshots", timestamps: true })
export class DailyMarketSnapshot {
  @Prop({ required: true, index: true })
  date: string; // YYYY-MM-DD

  @Prop({ required: true })
  sentiment: string; // BULLISH | BEARISH | NEUTRAL | MIXED

  @Prop({ required: true })
  globalRegime: string;

  @Prop()
  totalVolume: number;

  @Prop()
  avgChange: number;

  @Prop()
  gainers: number;

  @Prop()
  losers: number;

  @Prop()
  coinCount: number;

  // Top coins by volume with price data
  @Prop({ type: [Object], default: [] })
  topCoins: {
    symbol: string;
    lastPrice: number;
    priceChangePercent: number;
    quoteVolume: number;
    confidence: number;
    regime: string;
    strategy: string;
  }[];

  // Futures analytics snapshot for top coins
  @Prop({ type: [Object], default: [] })
  futuresData: {
    symbol: string;
    fundingRate: number;
    openInterest: number;
    longPercent: number;
    shortPercent: number;
    takerBuyRatio: number;
  }[];

  // Top movers
  @Prop({ type: [Object], default: [] })
  topGainers: { symbol: string; priceChangePercent: number; lastPrice: number }[];

  @Prop({ type: [Object], default: [] })
  topLosers: { symbol: string; priceChangePercent: number; lastPrice: number }[];

  // Warnings detected
  @Prop({ type: [String], default: [] })
  warnings: string[];

  // The formatted message that was sent to subscribers
  @Prop()
  messageSent: string;
}

export const DailyMarketSnapshotSchema =
  SchemaFactory.createForClass(DailyMarketSnapshot);
