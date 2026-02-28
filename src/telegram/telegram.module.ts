import { Module } from "@nestjs/common";
import { TelegramBotService } from "./telegram.service";

@Module({
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramModule {}
