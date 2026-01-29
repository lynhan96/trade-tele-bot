import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { TelegramModule } from "./telegram/telegram.module";
import { RedisModule } from "./redis/redis.module";
import { BinanceModule } from "./binance/binance.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    BinanceModule,
    TelegramModule,
  ],
})
export class AppModule {}
