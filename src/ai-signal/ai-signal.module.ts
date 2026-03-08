import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RedisModule } from "../redis/redis.module";
import { BinanceModule } from "../binance/binance.module";
import { TelegramModule } from "../telegram/telegram.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { CoinFilterModule } from "../coin-filter/coin-filter.module";
import { StrategyModule } from "../strategy/strategy.module";
import { UserModule } from "../user/user.module";

import { AiSignalService } from "./ai-signal.service";
import { SignalQueueService } from "./signal-queue.service";
import { PositionMonitorService } from "./position-monitor.service";
import { AiSignalStatsService } from "./ai-signal-stats.service";
import { AiCommandService } from "./ai-command.service";
import { UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { UserRealTradingService } from "./user-real-trading.service";
import { UserDataStreamService } from "./user-data-stream.service";
import { AiSignal, AiSignalSchema } from "../schemas/ai-signal.schema";
import {
  AiCoinProfile,
  AiCoinProfileSchema,
} from "../schemas/ai-coin-profile.schema";
import {
  AiRegimeHistory,
  AiRegimeHistorySchema,
} from "../schemas/ai-regime-history.schema";
import {
  UserSignalSubscription,
  UserSignalSubscriptionSchema,
} from "../schemas/user-signal-subscription.schema";
import {
  DailyMarketSnapshot,
  DailyMarketSnapshotSchema,
} from "../schemas/daily-market-snapshot.schema";
import { UserTrade, UserTradeSchema } from "../schemas/user-trade.schema";
import {
  DailyLimitHistory,
  DailyLimitHistorySchema,
} from "../schemas/daily-limit-history.schema";

@Module({
  imports: [
    RedisModule,
    BinanceModule,
    TelegramModule,
    MarketDataModule,
    CoinFilterModule,
    StrategyModule,
    UserModule,
    MongooseModule.forFeature([
      { name: AiSignal.name, schema: AiSignalSchema },
      { name: AiCoinProfile.name, schema: AiCoinProfileSchema },
      { name: AiRegimeHistory.name, schema: AiRegimeHistorySchema },
      {
        name: UserSignalSubscription.name,
        schema: UserSignalSubscriptionSchema,
      },
      {
        name: DailyMarketSnapshot.name,
        schema: DailyMarketSnapshotSchema,
      },
      { name: UserTrade.name, schema: UserTradeSchema },
      { name: DailyLimitHistory.name, schema: DailyLimitHistorySchema },
    ]),
  ],
  providers: [
    AiSignalService,
    SignalQueueService,
    PositionMonitorService,
    AiSignalStatsService,
    AiCommandService,
    UserSignalSubscriptionService,
    UserRealTradingService,
    UserDataStreamService,
  ],
  exports: [AiSignalService, UserSignalSubscriptionService, UserRealTradingService],
})
export class AiSignalModule {}
