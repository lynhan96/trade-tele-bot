---
name: debug-desync
description: Debug and fix desync between Binance positions and DB UserTrade records. Use when positions are open on Binance but closed/missing in DB, or vice versa.
---

# Debug Binance-DB Desync

## Quick Diagnosis
```bash
# Run sync script (dry run first!)
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && cd ~/projects/binance-tele-bot && node scripts/sync-binance-positions.js --dry-run"

# Filter specific symbol
node scripts/sync-binance-positions.js --symbol XXXUSDT --dry-run
```

## What sync script does
1. Fetches open positions from Binance `/fapi/v2/positionRisk`
2. Compares with OPEN UserTrade records in DB
3. For missing: **reopens existing CLOSED record** (not insert new — prevents duplicates)
4. Sets `syncedFromBinance: true` (60min grace period against sim auto-close)
5. Links to active signal if found

## Common Desync Causes
1. **Hedge close event closes main trade** (FIXED: `onTradeClose` now filters by direction)
2. **Bot crash during order placement** — position opens on Binance, DB never updated
3. **Sim resolveCallback closes real** — sim signal closes → `closeRealPosition` fires
4. **protectOpenTrades false positive** — API call fails, thinks position gone

## Fix Steps
1. `--dry-run` first to see what's wrong
2. Remove `--dry-run` to apply
3. Check `protectOpenTrades` will place SL within 1 min
4. Clear any stale Redis hedge locks: `redis-cli KEYS '*hedge:lock*'`

## Manual DB Fix (if sync script insufficient)
```javascript
// Reopen a specific CLOSED trade
db.collection('user_trades').updateOne(
  { _id: ObjectId("xxx") },
  { $set: { status: "OPEN", syncedFromBinance: true, openedAt: new Date() },
    $unset: { closeReason: 1, exitPrice: 1, pnlPercent: 1, pnlUsdt: 1, closedAt: 1 } }
)
```
