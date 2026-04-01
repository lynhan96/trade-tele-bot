# Admin Panel — API + UI Specification

## Overview

React admin panel for managing the trading bot. Dark theme, real-time WebSocket updates, JWT auth.

**Tech stack**: React + Vite + TailwindCSS + Socket.IO + React Query
**Backend**: NestJS REST API + WebSocket gateway at `/admin` namespace

---

## 1. Authentication

### POST /admin/auth/login
```json
Request:  { "username": "admin", "password": "..." }
Response: { "token": "eyJ...", "user": { "username": "admin", "role": "admin" } }
```
JWT token, 7-day expiry. All endpoints below require `Authorization: Bearer <token>`.

### POST /admin/auth/change-password
```json
Request:  { "currentPassword": "...", "newPassword": "..." }
Response: { "success": true }
```

---

## 2. Dashboard

### GET /admin/dashboard
Main KPIs for the overview page.

```json
Response: {
  "totalSignals": 53,
  "activeSignals": 3,
  "completedSignals": 50,
  "winRate": 69.17,
  "avgPnl": 0.61,
  "totalPnl": 73.32,        // % total
  "totalPnlUsdt": 200.27,   // USDT total
  "totalUsers": 2,
  "activeUsers": 2,
  "realModeUsers": 1,
  "totalTrades": 84,
  "openTrades": 8,
  "closedTrades": 76,
  "todaySignals": 0,
  "signalsByDirection": { "long": 22, "short": 31 },
  "signalsByStrategy": {
    "SMC_FVG": { "count": 20, "wins": 17, "losses": 3, "totalPnl": -1.02 },
    "RSI_CROSS": { "count": 5, "wins": 5, "losses": 0, "totalPnl": 6.77 },
    ...
  },
  "signalsByRegime": { "STRONG_BEAR": 8, "MIXED": 19, "RANGE_BOUND": 26 },
  "pnlByDay": [
    { "date": "2026-04-01", "totalPnl": 0.03, "totalPnlUsdt": -55.15, "count": 5, "wins": 3, "losses": 2 },
    ...
  ]
}
```

---

## 3. Signals

### GET /admin/signals
Paginated signal list with filtering.

**Query params**: `status`, `strategy`, `regime`, `symbol`, `direction`, `startDate`, `endDate`, `page`, `limit`

```json
Response: {
  "data": [{
    "_id": "...",
    "symbol": "BTCUSDT",
    "coin": "btc",
    "direction": "LONG",
    "entryPrice": 65000,
    "stopLossPrice": 63700,
    "stopLossPercent": 2.0,
    "takeProfitPrice": 66950,
    "takeProfitPercent": 3.0,
    "strategy": "EMA_PULLBACK+SMC_FVG",
    "regime": "STRONG_BULL",
    "aiConfidence": 82,
    "status": "ACTIVE",
    "executedAt": "2026-04-01T07:00:00Z",
    "gridLevels": [...],
    "gridAvgEntry": 64800,
    "hedgeActive": true,
    "hedgeCycleCount": 2,
    "hedgeHistory": [...],
    "simNotional": 600,
    "pnlPercent": 1.5,
    "pnlUsdt": 9.00
  }],
  "total": 53,
  "page": 1,
  "limit": 20
}
```

### GET /admin/signals/:id
Single signal with full detail.

### GET /admin/signals/:id/orders
All orders for a signal + hedge waterfall summary.

```json
Response: {
  "orders": [
    { "type": "MAIN", "direction": "LONG", "status": "OPEN", "entryPrice": 65000, "notional": 240, ... },
    { "type": "DCA", "direction": "LONG", "status": "OPEN", "entryPrice": 63700, "notional": 90, ... },
    { "type": "HEDGE", "direction": "SHORT", "status": "CLOSED", "entryPrice": 64500, "pnlUsdt": 3.50, ... }
  ],
  "hedgeWaterfall": [
    { "cycle": 1, "direction": "SHORT", "entryPrice": 64500, "exitPrice": 64000, "pnlUsdt": 3.50, "duration": "2.5h" },
    { "cycle": 2, "direction": "SHORT", "entryPrice": 63800, "exitPrice": 63200, "pnlUsdt": 5.20, "duration": "1.8h" }
  ],
  "totalBanked": 8.70
}
```

### GET /admin/signals/stats
Tab counts + filtered PnL metrics.

```json
Response: {
  "active": 3,
  "completed": 50,
  "queued": 0,
  "cancelled": 0,
  "filteredPnl": 200.27,
  "filteredWinRate": 69.17
}
```

### POST /admin/signals/:id/close
Admin close signal. Fetches Binance price, calculates PnL.

Headers: `x-source: admin` (optional)

### POST /admin/signals/close-all
Bulk close all active signals.

### POST /admin/signals/:id/hedge
Force open hedge on next tick.

### POST /admin/signals/:id/close-main
Force close main (triggers FLIP if hedge exists).

### POST /admin/signals/:id/close-hedge
Force close hedge only.

### PATCH /admin/signals/:id
Update signal fields (status, closeReason).

---

## 4. Users

### GET /admin/users
User list with stats.

**Query**: `page`, `limit`, `search` (username)

```json
Response: {
  "data": [{
    "telegramId": 1027556045,
    "chatId": 1027556045,
    "username": "elvislee1996",
    "balance": 1000,
    "realModeEnabled": true,
    "gridEnabled": true,
    "leverage": "AI",
    "maxOpenPositions": 5,
    "openTrades": 3,
    "closedTrades": 45,
    "totalPnlUsdt": 150.50,
    "winRate": 72.0,
    "createdAt": "2026-03-15T..."
  }],
  "total": 2
}
```

### GET /admin/users/ranking
Leaderboard (all-time + monthly PnL).

```json
Response: {
  "allTime": [
    { "telegramId": ..., "username": "...", "totalPnlUsdt": 200, "trades": 50, "winRate": 70 }
  ],
  "monthly": [...]
}
```

### GET /admin/users/:telegramId
User profile + trade history.

### PATCH /admin/users/:telegramId
Update user settings.
```json
Request: { "balance": 2000, "realModeEnabled": true, "gridEnabled": true, "maxOpenPositions": 8 }
```

### PUT /admin/users/:telegramId/api-keys/:exchange
Set Binance API keys.
```json
Request: { "apiKey": "...", "apiSecret": "..." }
```

### DELETE /admin/users/:telegramId/api-keys/:exchange
Remove API keys.

---

## 5. Trades

### GET /admin/trades
Paginated trade list.

**Query**: `status`, `symbol`, `telegramId`, `isHedge`, `page`, `limit`

```json
Response: {
  "data": [{
    "_id": "...",
    "telegramId": 1027556045,
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "entryPrice": 65000,
    "quantity": 0.05,
    "leverage": 20,
    "notionalUsdt": 3250,
    "slPrice": 63700,
    "tpPrice": 66950,
    "status": "OPEN",
    "isHedge": false,
    "pnlPercent": 1.2,
    "pnlUsdt": 39.00,
    "openedAt": "2026-04-01T07:00:00Z",
    "gridLevels": [...]
  }],
  "total": 84
}
```

### GET /admin/trades/stats
Trade statistics.

### POST /admin/trades/:tradeId/close
Close single trade on Binance.

### POST /admin/users/:telegramId/trades/close-all
Close all trades for user.

---

## 6. Orders

### GET /admin/orders
Browse all SIM orders with aggregated stats.

**Query**: `status`, `symbol`, `type`, `signalId`, `page`, `limit`

```json
Response: {
  "data": [{
    "signalId": "...",
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "type": "MAIN",       // MAIN | DCA | HEDGE | FLIP_MAIN
    "status": "OPEN",     // OPEN | CLOSED | PROMOTED
    "entryPrice": 65000,
    "exitPrice": null,
    "notional": 240,
    "quantity": 0.00369,
    "pnlPercent": null,
    "pnlUsdt": null,
    "entryFeeUsdt": 0.10,
    "exitFeeUsdt": 0,
    "fundingFeeUsdt": 0.02,
    "stopLossPrice": 63700,
    "takeProfitPrice": 66950,
    "cycleNumber": 0,
    "openedAt": "2026-04-01T07:00:00Z"
  }],
  "total": 120
}
```

---

## 7. Trading Config

### GET /admin/trading-config
Current config (100+ fields).

### PATCH /admin/trading-config
Update config (partial). Persisted to Redis immediately.

```json
Request: {
  "confidenceFloor": 65,
  "maxActiveSignals": 12,
  "hedgePartialTriggerPct": 3.0,
  "trailTrigger": 2.0,
  ...
}
```

### POST /admin/trading-config/reset
Reset to defaults.

**Config groups for UI form:**

| Group | Fields |
|-------|--------|
| SL/TP | slMin, slMax, tpMin, tpMax, tpRrMultiplier, dcaTpPct |
| Trail | trailTrigger, trailKeepRatio, tpProximityLock, tpBoostTrigger, tpBoostExtend, tpBoostCap |
| Confidence | confidenceFloor, confidenceFloorRanging, confidenceFloorStrongBull, regimeCaps |
| Strategy Gates | gateRSICross, gateEMAPullback, gateTrendEMA, gateStochEMAKDJ, gateSMCFVG, gateOpOnchain |
| Filters | maxDailySignals, maxActiveSignals, riskScoreThreshold, enabledStrategies |
| Price Position | pricePositionBlockLong, pricePositionBlockShort |
| Grid DCA | gridLevelCount, gridFillCooldownMin, gridRsiLong, gridRsiShort |
| Market Guard | btcPanic24hPct, btcPanic4hPct, btcBear4hPct, btcBull4hPct, btcBearRsi |
| Cooldowns | marketCooldownMin, maxSLBeforeCooldown |
| Hedge | hedgeEnabled, hedgePartialTriggerPct, hedgeMaxCycles, hedgeCooldownMin, hedgeTpPct*, hedgeTrail*, hedgeSl*, hedgeBlockRegimes |
| Sim | simNotional, simTakerFeePct, simMakerFeePct, simFundingEnabled |
| On-Chain | onChainFilterEnabled, onChainFunding*, onChainLongShort*, onChainTaker*, onChainOI*, onChainMarketSentiment* |
| Regime SL/TP | regimeSlTp (per-regime overrides) |
| Time Stop | timeStopHours, timeStopPnlRange |

---

## 8. Coins & Market

### GET /admin/coin-profiles
Coin metadata.

### PATCH /admin/coin-profiles/:id
Update coin profile.

### GET /admin/coins/stats
Per-coin performance (win/loss, PnL) over last N days.

### POST /admin/coins/:coin/override
Blacklist/whitelist a coin.
```json
Request: { "action": "blacklist" | "whitelist" }
```

### GET /admin/market-configs
Market regime configurations.

### GET /admin/regime-history
Historical regime assessments.

---

## 9. Analytics

### GET /admin/account-pnl
Real Binance account positions + PnL for all users.

```json
Response: [{
  "telegramId": 1027556045,
  "walletBalance": 1500,
  "positions": [
    { "symbol": "BTCUSDT", "side": "LONG", "quantity": 0.05, "entryPrice": 65000, "markPrice": 66000, "unrealizedPnl": 50.00, "leverage": 20 }
  ]
}]
```

### GET /admin/filter-funnel
24h rejection counts by filter stage.

```json
Response: {
  "preFilter": 1500,
  "confidence_block": 800,
  "risk_score": 200,
  "direction_block": 100,
  "passed": 5
}
```

### GET /admin/validations
Signal validation records (why signals were approved/rejected).

### GET /admin/validations/stats
Approval rate metrics.

### GET /admin/onchain-snapshots
On-chain data (funding rates, L/S ratios, OI).

### GET /admin/cycle-history
Daily limit history (positions opened/closed per day).

### GET /admin/ai-reviews
AI review critiques (historical).

---

## 10. WebSocket Real-Time Events

**Namespace**: `/admin`
**Auth**: `{ auth: { token: "Bearer ..." } }` on handshake

### Events emitted (MongoDB change streams):

| Event | Trigger | Data |
|-------|---------|------|
| `signal:created` | New signal | Full signal document |
| `signal:updated` | Signal status/PnL change | Full signal document |
| `signal:deleted` | Signal removed | `{ _id }` |
| `trade:created` | New trade opened | Full trade document |
| `trade:updated` | Trade PnL/status change | Full trade document |
| `trade:deleted` | Trade removed | `{ _id }` |
| `user:created` | New user subscribed | Full user document |
| `user:updated` | User settings changed | Full user document |
| `validation:created` | New validation record | Full validation document |
| `validation:updated` | Validation updated | Full validation document |

---

## 11. UI Pages (Current)

| # | Page | Route | Purpose |
|---|------|-------|---------|
| 1 | **Login** | `/login` | JWT auth |
| 2 | **Dashboard** | `/` | KPIs, PnL chart, strategy breakdown, regime distribution |
| 3 | **Trading** | `/trading` | Signal + trade list, filter bar, close actions |
| 4 | **Signal Detail** | `/trading/:id` | Grid levels, order timeline, hedge waterfall, admin actions |
| 5 | **Users** | `/users` | User list, search, ranking, real mode indicators |
| 6 | **User Detail** | `/users/:id` | API keys, settings form, trade history |
| 7 | **Config** | `/config` | Form editor for 100+ trading config fields (grouped) |
| 8 | **Validations** | `/validations` | Approval metrics, filtered validation list |
| 9 | **Snapshots** | `/snapshots` | On-chain data display |
| 10 | **Filter Funnel** | `/funnel` | Visual funnel of signal rejection stages |

---

## 12. UI Components (Current)

| Component | Used In | Purpose |
|-----------|---------|---------|
| DataTable | All list pages | Sortable, paginated table with row actions |
| FilterBar | Trading, Users | Status/strategy/regime/date filters |
| StatsCards | Dashboard | KPI cards (signals, PnL, users, trades) |
| PnLChart | Dashboard | Daily PnL bar chart |
| StrategyChart | Dashboard | Strategy win/loss donut chart |
| SignalModal | Trading | Signal detail in modal |
| OrderTimeline | Signal Detail | Chronological order events |
| HedgeWaterfall | Signal Detail | Hedge cycle visualization |
| GridLevelTable | Signal Detail | DCA grid levels with fill status |
| ConfigForm | Config | Grouped form with field validation |
| Toast | Global | Success/error notifications |
| Skeleton | All pages | Loading placeholders |

---

## 13. Design Tokens (Current)

```
Theme: Dark
Background: surface-900 (#1a1a2e) to surface-500
Accent: Indigo (#6366f1)
Success: Green (#22c55e)
Danger: Red (#ef4444)
Warning: Amber (#f59e0b)
Text: White/Gray-300
Font: System monospace
```

---

## 14. Data Flow Summary

```
                    ┌──────────┐
                    │  Admin   │
                    │  Panel   │
                    │ (React)  │
                    └────┬─────┘
                         │
           REST API      │      WebSocket
         (CRUD + Actions)│    (Real-time updates)
                         │
                    ┌────┴─────┐
                    │  NestJS  │
                    │  Admin   │
                    │  Module  │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         ┌────┴───┐ ┌───┴────┐ ┌──┴───┐
         │MongoDB │ │ Redis  │ │Binance│
         │Signals │ │Config  │ │ API   │
         │Orders  │ │Cache   │ │Futures│
         │Trades  │ │        │ │       │
         └────────┘ └────────┘ └───────┘
```
