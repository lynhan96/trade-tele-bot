import { Controller } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { TelegramBotService } from "../telegram/telegram.service";

@Controller()
export class SignalController {
  constructor(private readonly telegramBotService: TelegramBotService) {}

  @MessagePattern({ cmd: "bot-receive-signal" })
  async handleSignal(@Payload() payload: { body: any }) {
    await this.telegramBotService.handleIncomingSignal(payload.body);
    return { ok: true };
  }
}
