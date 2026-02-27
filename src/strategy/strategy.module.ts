import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { RedisModule } from "../redis/redis.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { IndicatorService } from "./indicators/indicator.service";
import { RuleEngineService } from "./rules/rule-engine.service";
import { AiOptimizerService } from "./ai-optimizer/ai-optimizer.service";
import {
  AiRegimeHistory,
  AiRegimeHistorySchema,
} from "../schemas/ai-regime-history.schema";

@Module({
  imports: [
    RedisModule,
    MarketDataModule,
    MongooseModule.forFeature([
      { name: AiRegimeHistory.name, schema: AiRegimeHistorySchema },
    ]),
  ],
  providers: [IndicatorService, RuleEngineService, AiOptimizerService],
  exports: [IndicatorService, RuleEngineService, AiOptimizerService],
})
export class StrategyModule {}
