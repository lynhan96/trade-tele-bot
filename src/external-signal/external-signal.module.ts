import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AiSignalModule } from "../ai-signal/ai-signal.module";
import { StrategyModule } from "../strategy/strategy.module";
import { MarketDataModule } from "../market-data/market-data.module";
import { RedisModule } from "../redis/redis.module";
import {
  AiSignalValidation,
  AiSignalValidationSchema,
} from "../schemas/ai-signal-validation.schema";
import { ExternalSignalController } from "./external-signal.controller";
import { ExternalSignalService } from "./external-signal.service";

@Module({
  imports: [
    AiSignalModule,
    StrategyModule,
    MarketDataModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: AiSignalValidation.name, schema: AiSignalValidationSchema },
    ]),
  ],
  controllers: [ExternalSignalController],
  providers: [ExternalSignalService],
})
export class ExternalSignalModule {}
