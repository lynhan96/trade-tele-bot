import { Controller, Logger, OnModuleInit } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { ExternalSignalService } from "./external-signal.service";

export interface ExternalSignalPayload {
  tradingPairType: "FUTURE" | "SPOT";
  botType: string;
  period: string;
  equity: "LONG" | "SHORT";
  coin: string;
  currency: string;
  entry: number;
  stopLoss: number;
  isManual: boolean;
}

@Controller()
export class ExternalSignalController implements OnModuleInit {
  private readonly logger = new Logger(ExternalSignalController.name);

  constructor(private readonly externalSignalService: ExternalSignalService) {}

  onModuleInit() {
    this.logger.log(`[ExtSignal] TCP handler registered — listening for { cmd: 'bot-receive-signal' }`);
  }

  @MessagePattern({ cmd: "bot-receive-signal" })
  async receiveSignal(
    @Payload() data: { body: ExternalSignalPayload },
  ): Promise<{ success: boolean; reason?: string; signalId?: string }> {
    const payload = data?.body;
    if (!payload) {
      return { success: false, reason: "Missing body" };
    }

    this.logger.log(
      `[ExtSignal] Received: ${payload.coin}/${payload.currency} ${payload.equity} entry=${payload.entry} SL=${payload.stopLoss} bot=${payload.botType}`,
    );

    try {
      return await this.externalSignalService.processExternalSignal(payload);
    } catch (err) {
      this.logger.error(`[ExtSignal] Error processing signal: ${err?.message}`);
      return { success: false, reason: `Internal error: ${err?.message}` };
    }
  }
}
