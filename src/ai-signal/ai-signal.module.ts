import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RedisModule } from "../redis/redis.module";
import { BinanceModule } from "../binance/binance.module";
import { TelegramModule } from "../telegram/telegram.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { CoinFilterModule } from "../coin-filter/coin-filter.module";
import { StrategyModule } from "../strategy/strategy.module";
import { UserModule } from "../user/user.module";
import { CoinGeckoModule } from "../coingecko/coingecko.module";

import { AiSignalService } from "./ai-signal.service";
import { SignalQueueService } from "./signal-queue.service";
import { PositionMonitorService } from "./position-monitor.service";
import { AiSignalStatsService } from "./ai-signal-stats.service";
import { AiCommandService } from "./ai-command.service";
import { UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { UserRealTradingService } from "./user-real-trading.service";
import { UserDataStreamService } from "./user-data-stream.service";
import { StrategyAutoTunerService } from "./strategy-auto-tuner.service";
import { AiMarketAnalystService } from "./ai-market-analyst.service";
import { HedgeManagerService } from "./hedge-manager.service";
import { TradingConfigService } from "./trading-config";
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
import { UserTrade, UserTradeSchema } from "../schemas/user-trade.schema";
import {
  DailyLimitHistory,
  DailyLimitHistorySchema,
} from "../schemas/daily-limit-history.schema";
import { AiReview, AiReviewSchema } from "../schemas/ai-review.schema";
import {
  AiSignalValidation,
  AiSignalValidationSchema,
} from "../schemas/ai-signal-validation.schema";
import { Order, OrderSchema } from "../schemas/order.schema";
import { OnChainSnapshot, OnChainSnapshotSchema } from "../schemas/onchain-snapshot.schema";
import { OnChainScannerService } from "./onchain-scanner.service";

@Module({
  imports: [
    RedisModule,
    BinanceModule,
    TelegramModule,
    MarketDataModule,
    CoinFilterModule,
    StrategyModule,
    UserModule,
    CoinGeckoModule,
    MongooseModule.forFeature([
      { name: AiSignal.name, schema: AiSignalSchema },
      { name: AiCoinProfile.name, schema: AiCoinProfileSchema },
      { name: AiRegimeHistory.name, schema: AiRegimeHistorySchema },
      {
        name: UserSignalSubscription.name,
        schema: UserSignalSubscriptionSchema,
      },
      { name: UserTrade.name, schema: UserTradeSchema },
      { name: DailyLimitHistory.name, schema: DailyLimitHistorySchema },
      { name: AiReview.name, schema: AiReviewSchema },
      { name: AiSignalValidation.name, schema: AiSignalValidationSchema },
      { name: Order.name, schema: OrderSchema },
      { name: OnChainSnapshot.name, schema: OnChainSnapshotSchema },
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
    StrategyAutoTunerService,
    AiMarketAnalystService,
    HedgeManagerService,
    TradingConfigService,
    OnChainScannerService,
  ],
  exports: [AiSignalService, UserSignalSubscriptionService, UserRealTradingService, SignalQueueService, PositionMonitorService, TradingConfigService, StrategyAutoTunerService, AiMarketAnalystService],
})
export class AiSignalModule {}
