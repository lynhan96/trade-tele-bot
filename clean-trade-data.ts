/**
 * clean-trade-data.ts
 *
 * Xóa toàn bộ dữ liệu trade, giữ lại:
 *   - user_settings (API keys, SL/TP config, preferences)
 *   - user_signal_subscriptions (danh sách đăng ký)
 *   - admin_accounts (admin login)
 *   - ai_market_config (system config)
 *   - Redis user keys (binance-telebot:user:{id})
 *
 * Xóa:
 *   - ai_signals
 *   - user_trades
 *   - ai_signal_validations
 *   - ai_regime_history
 *   - ai_coin_profiles
 *   - daily_limit_history
 *   - candle_histories (market data cache)
 *   - Redis: cache:ai:*, binance-telebot:user:*:tp, signal/position caches
 */

import * as mongoose from "mongoose";
import Redis from "ioredis";
import * as dotenv from "dotenv";

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://admin:admin123@localhost:27017/binance-tele-bot?authSource=admin";

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || "0"),
  keyPrefix: "binance-telebot:",
};

// Collections cần XÓA (trade data)
const COLLECTIONS_TO_CLEAR = [
  "ai_signals",
  "user_trades",
  "ai_signal_validations",
  "ai_regime_history",
  "ai_coin_profiles",
  "daily_limit_history",
  "candle_history",
  "daily_market_snapshots",
];

// Collections GIỮ LẠI (user + config)
const COLLECTIONS_TO_KEEP = [
  "user_settings",
  "user_signal_subscriptions",
  "admin_accounts",
  "ai_market_configs",
];

async function cleanMongoDB(db: mongoose.mongo.Db) {
  console.log("\n=== MongoDB Cleanup ===");

  // List all collections
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map((c) => c.name);
  console.log("Collections hiện có:", collectionNames.join(", "));

  console.log("\nGIỮ LẠI:", COLLECTIONS_TO_KEEP.join(", "));
  console.log("XÓA:", COLLECTIONS_TO_CLEAR.join(", "));
  console.log("");

  for (const colName of COLLECTIONS_TO_CLEAR) {
    if (!collectionNames.includes(colName)) {
      console.log(`  [SKIP] ${colName} — không tồn tại`);
      continue;
    }
    const col = db.collection(colName);
    const count = await col.countDocuments();
    await col.deleteMany({});
    console.log(`  [CLEARED] ${colName} — đã xóa ${count} documents`);
  }

  // Verify keep collections untouched
  console.log("\nKiểm tra collections giữ lại:");
  for (const colName of COLLECTIONS_TO_KEEP) {
    if (!collectionNames.includes(colName)) {
      console.log(`  [NOT FOUND] ${colName}`);
      continue;
    }
    const count = await db.collection(colName).countDocuments();
    console.log(`  [OK] ${colName} — ${count} records`);
  }
}

async function cleanRedis(redis: Redis) {
  console.log("\n=== Redis Cleanup ===");

  // Patterns to delete (trade/signal related cache)
  const deletePatterns = [
    "cache:ai:*",
    "*:tp",          // trailing stop state per user
    "signal:*",
    "position:*",
    "coin-filter:*",
    "regime:*",
    "optimizer:*",
    "validation:*",
    "daily:signals:*",
    "market-cooldown:*",
    "order-lock:*",
    "candle:*",
  ];

  // Patterns to KEEP (user data)
  const keepPatterns = [
    "user:*:settings",
    "user:[0-9]*",  // user API keys: binance-telebot:user:{telegramId}
  ];

  console.log("Xóa các Redis keys theo patterns:");

  let totalDeleted = 0;
  for (const pattern of deletePatterns) {
    const keys = await redis.keys(`binance-telebot:${pattern}`);
    if (keys.length === 0) {
      // Try without prefix (some keys may not have prefix)
      const keysNaked = await redis.keys(pattern);
      if (keysNaked.length > 0) {
        // Filter out user API keys
        const toDelete = keysNaked.filter(
          (k) =>
            !k.match(/user:\d+$/) // keep bare user API key
        );
        if (toDelete.length > 0) {
          await redis.del(...toDelete);
          console.log(
            `  [CLEARED] ${pattern} (naked) — ${toDelete.length} keys`
          );
          totalDeleted += toDelete.length;
        }
      }
      continue;
    }

    // Filter: never delete user API keys (binance-telebot:user:{id} without suffix)
    const toDelete = keys.filter(
      (k) => !k.match(/binance-telebot:user:\d+$/) // keep pure user key
    );

    if (toDelete.length > 0) {
      await redis.del(...toDelete);
      console.log(`  [CLEARED] ${pattern} — ${toDelete.length} keys`);
      totalDeleted += toDelete.length;
    } else {
      console.log(`  [SKIP] ${pattern} — 0 keys to delete`);
    }
  }

  console.log(`\nTổng Redis keys đã xóa: ${totalDeleted}`);

  // Verify user keys still exist
  console.log("\nKiểm tra user keys còn lại:");
  const userKeys = await redis.keys("binance-telebot:user:*");
  // Show only pure user keys (not :tp etc)
  const pureUserKeys = userKeys.filter((k) => k.match(/user:\d+$/));
  console.log(`  User API keys: ${pureUserKeys.length} users`);
  if (pureUserKeys.length > 0) {
    for (const k of pureUserKeys.slice(0, 10)) {
      console.log(`    - ${k}`);
    }
    if (pureUserKeys.length > 10) {
      console.log(`    ... và ${pureUserKeys.length - 10} users khác`);
    }
  }
}

async function main() {
  console.log("========================================");
  console.log("  TRADE DATA CLEANUP SCRIPT");
  console.log("  Giữ lại: user_settings, subscriptions,");
  console.log("           admin_accounts, ai_market_config");
  console.log("  Xóa: signals, trades, validations,");
  console.log("       regime_history, coin_profiles, candles");
  console.log("========================================");

  // Connect MongoDB
  console.log("\nKết nối MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("✓ MongoDB connected");

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB db not available");

  // Connect Redis
  console.log("Kết nối Redis...");
  const redis = new Redis({
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    password: REDIS_CONFIG.password || undefined,
    db: REDIS_CONFIG.db,
  });
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", resolve);
    redis.once("error", reject);
  });
  console.log("✓ Redis connected");

  try {
    await cleanMongoDB(db);
    await cleanRedis(redis);

    console.log("\n========================================");
    console.log("  CLEANUP HOÀN TẤT");
    console.log("  Bot sẵn sàng monitor lại từ đầu.");
    console.log("========================================\n");
  } finally {
    await mongoose.disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error("Lỗi cleanup:", err);
  process.exit(1);
});
