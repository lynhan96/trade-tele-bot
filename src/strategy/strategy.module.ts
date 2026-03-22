import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RedisModule } from "../redis/redis.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { IndicatorService } from "./indicators/indicator.service";
import { RuleEngineService } from "./rules/rule-engine.service";
import { AiOptimizerService } from "./ai-optimizer/ai-optimizer.service";
import { TradingConfigService } from "../ai-signal/trading-config";
import { SingaporeFiltersService } from "./filters/singapore-filters.service";
import { OnChainFilterService } from "./filters/onchain-filters.service";
import {
  AiRegimeHistory,
  AiRegimeHistorySchema,
} from "../schemas/ai-regime-history.schema";
import {
  AiMarketConfig,
  AiMarketConfigSchema,
} from "../schemas/ai-market-config.schema";
import {
  AiSignalValidation,
  AiSignalValidationSchema,
} from "../schemas/ai-signal-validation.schema";

@Module({
  imports: [
    RedisModule,
    MarketDataModule,
    MongooseModule.forFeature([
      { name: AiRegimeHistory.name, schema: AiRegimeHistorySchema },
      { name: AiMarketConfig.name, schema: AiMarketConfigSchema },
      { name: AiSignalValidation.name, schema: AiSignalValidationSchema },
    ]),
  ],
  providers: [IndicatorService, RuleEngineService, AiOptimizerService, TradingConfigService, SingaporeFiltersService, OnChainFilterService],
  exports: [IndicatorService, RuleEngineService, AiOptimizerService, TradingConfigService, SingaporeFiltersService, OnChainFilterService],
})
export class StrategyModule {}
