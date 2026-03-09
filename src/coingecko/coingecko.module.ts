import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { CoinGeckoService } from "./coingecko.service";

@Module({
  imports: [RedisModule],
  providers: [CoinGeckoService],
  exports: [CoinGeckoService],
})
export class CoinGeckoModule {}
