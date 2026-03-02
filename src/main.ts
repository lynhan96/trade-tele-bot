import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import * as dotenv from "dotenv";

dotenv.config();

const LOCK_KEY = "binance-bot:cache:process-lock";
const LOCK_TTL = 120; // 2 minutes — renewed every 60s

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  // ── Single-process lock (standalone Redis, before NestJS init) ─────────
  const lockClient: RedisClientType = createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
    password: process.env.REDIS_PASSWORD || undefined,
    database: parseInt(process.env.REDIS_DB || "0", 10),
  });
  lockClient.on("error", () => {}); // suppress unhandled errors
  await lockClient.connect();

  const lockValue = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const acquired = await lockClient.set(LOCK_KEY, lockValue, {
    NX: true,
    EX: LOCK_TTL,
  });

  if (acquired !== "OK") {
    const existing = await lockClient.get(LOCK_KEY);
    logger.error(
      `❌ Another bot instance is already running! Lock: ${existing}. Exiting to prevent duplicate signals.`,
    );
    await lockClient.quit();
    process.exit(1);
  }

  logger.log(`🔒 Process lock acquired (pid: ${process.pid})`);

  // Renew lock every 60s (half of TTL) — keep standalone client alive for this
  const lockInterval = setInterval(async () => {
    try {
      if (lockClient.isOpen) {
        await lockClient.set(LOCK_KEY, lockValue, { EX: LOCK_TTL });
      }
    } catch {
      // Redis might be temporarily unavailable — lock will expire naturally
    }
  }, 60_000);

  // ── Init NestJS ────────────────────────────────────────────────────────

  const app = await NestFactory.create(AppModule);

  logger.log("Binance Telegram Bot is starting (v2)...");

  await app.init();

  logger.log("✅ Bot is running and listening for commands");

  // Graceful shutdown on SIGTERM (hot-reload / container stop)
  process.on("SIGTERM", async () => {
    logger.log("SIGTERM received, closing application...");
    clearInterval(lockInterval);
    try {
      if (lockClient.isOpen) {
        await lockClient.del(LOCK_KEY);
        await lockClient.quit();
      }
    } catch {}
    logger.log("🔓 Process lock released");
    await app.close();
    process.exit(0);
  });
}

bootstrap();
