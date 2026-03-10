#!/bin/bash
# clean-trade-data.sh
# Xóa toàn bộ dữ liệu trade, giữ lại user + config
# Chạy trên server: bash clean-trade-data.sh

set -e

# Load .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

MONGO_URI="${MONGODB_URI:-mongodb://admin:admin123@localhost:27017/binance-tele-bot?authSource=admin}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_PREFIX="binance-telebot:"

echo "========================================"
echo "  TRADE DATA CLEANUP"
echo "  GIỮ: user_settings, subscriptions,"
echo "       admin_accounts, ai_market_configs"
echo "  XÓA: signals, trades, validations,"
echo "       regime, coin_profiles, candles"
echo "========================================"
echo ""

# ── MongoDB ──────────────────────────────────
echo "=== MongoDB Cleanup ==="

mongosh "$MONGO_URI" --quiet --eval '
const toDelete = [
  "ai_signals",
  "user_trades",
  "ai_signal_validations",
  "ai_regime_history",
  "ai_coin_profiles",
  "daily_limit_history",
  "candle_history",
  "daily_market_snapshots",
];

const toKeep = [
  "user_settings",
  "user_signal_subscriptions",
  "admin_accounts",
  "ai_market_configs",
];

const allCols = db.getCollectionNames();
print("Collections hiện có: " + allCols.join(", "));
print("");

for (const col of toDelete) {
  if (!allCols.includes(col)) {
    print("  [SKIP]    " + col + " — không tồn tại");
    continue;
  }
  const count = db[col].countDocuments();
  db[col].deleteMany({});
  print("  [CLEARED] " + col + " — đã xóa " + count + " documents");
}

print("");
print("Kiểm tra collections giữ lại:");
for (const col of toKeep) {
  if (!allCols.includes(col)) {
    print("  [NOT FOUND] " + col);
    continue;
  }
  const count = db[col].countDocuments();
  print("  [OK] " + col + " — " + count + " records");
}
'

echo ""
echo "=== Redis Cleanup ==="

# Build redis-cli base command
if [ -n "$REDIS_PASSWORD" ]; then
  REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD"
else
  REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT"
fi

# Patterns to delete (trade/signal related)
PATTERNS=(
  "${REDIS_PREFIX}cache:ai:*"
  "${REDIS_PREFIX}signal:*"
  "${REDIS_PREFIX}position:*"
  "${REDIS_PREFIX}coin-filter:*"
  "${REDIS_PREFIX}regime:*"
  "${REDIS_PREFIX}optimizer:*"
  "${REDIS_PREFIX}validation:*"
  "${REDIS_PREFIX}daily:signals:*"
  "${REDIS_PREFIX}market-cooldown:*"
  "${REDIS_PREFIX}order-lock:*"
  "${REDIS_PREFIX}candle:*"
  "${REDIS_PREFIX}user:*:tp"
)

TOTAL_DELETED=0

for PATTERN in "${PATTERNS[@]}"; do
  # Get matching keys
  KEYS=$($REDIS_CMD KEYS "$PATTERN" 2>/dev/null)
  if [ -z "$KEYS" ]; then
    echo "  [SKIP]    $PATTERN — 0 keys"
    continue
  fi
  COUNT=$(echo "$KEYS" | wc -l | tr -d ' ')
  echo "$KEYS" | xargs $REDIS_CMD DEL > /dev/null 2>&1
  echo "  [CLEARED] $PATTERN — $COUNT keys"
  TOTAL_DELETED=$((TOTAL_DELETED + COUNT))
done

echo ""
echo "Tổng Redis keys đã xóa: $TOTAL_DELETED"

# Show remaining user keys
echo ""
echo "Kiểm tra user keys còn lại:"
USER_KEYS=$($REDIS_CMD KEYS "${REDIS_PREFIX}user:*" 2>/dev/null)
if [ -n "$USER_KEYS" ]; then
  # Filter pure user keys (no sub-suffix like :tp)
  PURE_USERS=$(echo "$USER_KEYS" | grep -E 'user:[0-9]+$' || true)
  COUNT=$(echo "$PURE_USERS" | grep -c . || true)
  echo "  User API keys: $COUNT users"
  echo "$PURE_USERS" | head -10 | while read k; do echo "    - $k"; done
else
  echo "  (không có user keys)"
fi

echo ""
echo "========================================"
echo "  CLEANUP HOÀN TẤT"
echo "  Bot sẵn sàng monitor lại từ đầu."
echo "========================================"
