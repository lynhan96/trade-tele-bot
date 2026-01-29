import { Module } from "@nestjs/common";
import { TelegramBotService } from "./telegram.service";
import { RedisModule } from "../redis/redis.module";
import { BinanceModule } from "../binance/binance.module";
import { OkxModule } from "../okx/okx.module";

@Module({
  imports: [RedisModule, BinanceModule, OkxModule],
  providers: [TelegramBotService],
})
export class TelegramModule {}
