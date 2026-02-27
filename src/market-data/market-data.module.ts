import { Module } from "@nestjs/common";
import { MarketDataService } from "./market-data.service";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [RedisModule],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
