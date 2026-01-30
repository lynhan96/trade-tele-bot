import { Module, Global } from "@nestjs/common";
import { FileLoggerService } from "./logger.service";

@Global()
@Module({
  providers: [FileLoggerService],
  exports: [FileLoggerService],
})
export class LoggerModule {}
