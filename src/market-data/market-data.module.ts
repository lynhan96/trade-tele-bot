import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { MarketDataService } from "./market-data.service";
import { RedisModule } from "../redis/redis.module";
import {
  CandleHistory,
  CandleHistorySchema,
} from "./schemas/candle-history.schema";

@Module({
  imports: [
    RedisModule,
    MongooseModule.forFeature([
      { name: CandleHistory.name, schema: CandleHistorySchema },
    ]),
  ],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
