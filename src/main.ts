import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create(AppModule);

  const tcpHost = process.env.TCP_HOST || "127.0.0.1";
  const tcpPort = parseInt(process.env.TCP_PORT || "8010");

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: {
      host: tcpHost,
      port: tcpPort,
    },
  });

  logger.log("Binance Telegram Bot is starting...");

  await app.startAllMicroservices();
  await app.init();

  logger.log("✅ Bot is running and listening for commands");
  logger.log(`✅ TCP microservice listening on ${tcpHost}:${tcpPort}`);

  // Keep the application running
  process.on("SIGTERM", async () => {
    logger.log("SIGTERM received, closing application...");
    await app.close();
  });
}

bootstrap();
