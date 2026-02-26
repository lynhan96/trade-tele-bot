import { Module } from "@nestjs/common";
import { SignalController } from "./signal.controller";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [TelegramModule],
  controllers: [SignalController],
})
export class SignalModule {}
