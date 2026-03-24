import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { AdminGateway } from "./admin.gateway";
import { RedisModule } from "../redis/redis.module";
import { AiSignalModule } from "../ai-signal/ai-signal.module";
import { AiSignal, AiSignalSchema } from "../schemas/ai-signal.schema";
import { UserSignalSubscription, UserSignalSubscriptionSchema } from "../schemas/user-signal-subscription.schema";
import { UserTrade, UserTradeSchema } from "../schemas/user-trade.schema";
import { AiCoinProfile, AiCoinProfileSchema } from "../schemas/ai-coin-profile.schema";
import { AiMarketConfig, AiMarketConfigSchema } from "../schemas/ai-market-config.schema";
import { AiRegimeHistory, AiRegimeHistorySchema } from "../schemas/ai-regime-history.schema";

import { UserSettings, UserSettingsSchema } from "../schemas/user-settings.schema";
import { AdminAccount, AdminAccountSchema } from "../schemas/admin-account.schema";
import { AiSignalValidation, AiSignalValidationSchema } from "../schemas/ai-signal-validation.schema";
import { DailyLimitHistory, DailyLimitHistorySchema } from "../schemas/daily-limit-history.schema";
import { AiReview, AiReviewSchema } from "../schemas/ai-review.schema";
import { Order, OrderSchema } from "../schemas/order.schema";
import { OnChainSnapshot, OnChainSnapshotSchema } from "../schemas/onchain-snapshot.schema";
import { AgentEvent, AgentEventSchema } from "../schemas/agent-event.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AiSignal.name, schema: AiSignalSchema },
      { name: UserSignalSubscription.name, schema: UserSignalSubscriptionSchema },
      { name: UserTrade.name, schema: UserTradeSchema },
      { name: AiCoinProfile.name, schema: AiCoinProfileSchema },
      { name: AiMarketConfig.name, schema: AiMarketConfigSchema },
      { name: AiRegimeHistory.name, schema: AiRegimeHistorySchema },

      { name: UserSettings.name, schema: UserSettingsSchema },
      { name: AdminAccount.name, schema: AdminAccountSchema },
      { name: AiSignalValidation.name, schema: AiSignalValidationSchema },
      { name: DailyLimitHistory.name, schema: DailyLimitHistorySchema },
      { name: AiReview.name, schema: AiReviewSchema },
      { name: Order.name, schema: OrderSchema },
      { name: OnChainSnapshot.name, schema: OnChainSnapshotSchema },
      { name: AgentEvent.name, schema: AgentEventSchema },
    ]),
    RedisModule,
    AiSignalModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminAuthService, AdminGuard, AdminGateway],
})
export class AdminModule {}
