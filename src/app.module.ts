import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { MongooseModule } from "@nestjs/mongoose";
import { TelegramModule } from "./telegram/telegram.module";
import { RedisModule } from "./redis/redis.module";
import { BinanceModule } from "./binance/binance.module";
import { LoggerModule } from "./logger/logger.module";
import { AiSignalModule } from "./ai-signal/ai-signal.module";
import { AdminModule } from "./admin/admin.module";
import { ExternalSignalModule } from "./external-signal/external-signal.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>(
          "MONGODB_URI",
          "mongodb://localhost:27017/binance-tele-bot",
        ),
      }),
      inject: [ConfigService],
    }),
    LoggerModule,
    RedisModule,
    BinanceModule,
    TelegramModule,
    AiSignalModule,
    AdminModule,
    ExternalSignalModule,
  ],
})
export class AppModule {}
