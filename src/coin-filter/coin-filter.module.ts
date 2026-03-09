import { Module } from "@nestjs/common";
import { CoinFilterService } from "./coin-filter.service";
import { RedisModule } from "../redis/redis.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { CoinGeckoModule } from "../coingecko/coingecko.module";

@Module({
  imports: [RedisModule, MarketDataModule, CoinGeckoModule],
  providers: [CoinFilterService],
  exports: [CoinFilterService],
})
export class CoinFilterModule {}
