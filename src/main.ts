import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create(AppModule);

  logger.log("Binance Telegram Bot is starting...");

  await app.init();

  logger.log("✅ Bot is running and listening for commands");

  // Keep the application running
  process.on("SIGTERM", async () => {
    logger.log("SIGTERM received, closing application...");
    await app.close();
  });
}

bootstrap();
