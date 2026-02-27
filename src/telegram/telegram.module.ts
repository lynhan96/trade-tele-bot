import { Module } from "@nestjs/common";
import { TelegramBotService } from "./telegram.service";
import { RedisModule } from "../redis/redis.module";
import { BinanceModule } from "../binance/binance.module";
import { OkxModule } from "../okx/okx.module";
import { UserModule } from "../user/user.module";

@Module({
  imports: [RedisModule, BinanceModule, OkxModule, UserModule],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramModule {}
