import { Module } from "@nestjs/common";
import { TelegramBotService } from "./telegram.service";
import { RedisModule } from "../redis/redis.module";
import { BinanceModule } from "../binance/binance.module";

@Module({
  imports: [RedisModule, BinanceModule],
  providers: [TelegramBotService],
})
export class TelegramModule {}
