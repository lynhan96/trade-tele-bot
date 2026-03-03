# Changelog

## 2026-03-03 (3) - AI Dynamic Coin Filters + Signal Quality Improvements

### Feature: AI-Decided Dynamic Coin Filter Settings

The coin filter settings (`minVolumeUsd`, `minPriceChangePct`, `maxShortlistSize`) are now decided dynamically by Haiku based on market regime. Past decisions are stored in MongoDB as conversation history so the next Haiku call can reference what was recommended before and why.

**How it works:**
- `AiOptimizerService.tuneMarketFilters()` is called fire-and-forget when regime changes or no cached settings exist
- Fetches last 5 decisions from MongoDB as conversation history → calls Haiku with regime + BTC indicators + history
- Saves result to MongoDB (`ai_market_configs` collection) and Redis (`cache:ai:market-filters`, 8h TTL)
- `CoinFilterService` reads from Redis first → falls back to `.env` values if no AI decision cached
- `.env` values (`AI_MIN_COIN_VOLUME_USD`, `AI_MIN_PRICE_CHANGE_PCT`, `AI_MAX_SHORTLIST_SIZE`) are now fallback defaults only

### Enhancement: Per-Coin 4h EMA Trend Filter

Individual coins can trend differently from BTC. Added a per-coin trend alignment gate in `processCoin()`:
- Fetches 4h closes and computes EMA21 vs EMA50
- If spread > 0.3% (trend is meaningful): blocks LONG signals when coin is in 4h downtrend, blocks SHORT when in 4h uptrend
- Prevents counter-trend entries caused by global regime being BTC-only

### Enhancement: ADX Gate for TREND_EMA Strategy

The TREND_EMA strategy was generating false entries in choppy, directionless markets. Added ADX (Average Directional Index) gate:
- `adxMin: 20` default in `AiTunedParams` and defaults
- `evalTrendEma()` in `RuleEngineService` blocks entry if ADX < threshold
- `getAdx()` added to `IndicatorService` using Wilder's smoothing algorithm

### Cleanup: Legacy Code Removal

Stripped ~800 lines of dead code left from the old command structure:
- `user-settings.service.ts` reduced from 835 → 82 lines (only `saveApiKeys` + `getApiKeys` remain)
- `user-settings.schema.ts` stripped of all TP/bots/retry/migration fields
- `src/simulator/` directory deleted (8 files, all unused)
- Unused methods removed from `binance.service.ts`

### Fix: ecosystem.config.js Production Config

Removed hardcoded Mac paths from `ecosystem.config.js` (would have broken on remote Linux server). Set `watch: false` (no hot-reload needed in production).

### Files Modified
- `src/schemas/ai-market-config.schema.ts` — NEW: MongoDB schema for AI filter decisions
- `src/strategy/ai-optimizer/ai-optimizer.service.ts` — added `tuneMarketFilters()`, injected `AiMarketConfig` model, call on regime change
- `src/strategy/strategy.module.ts` — registered `AiMarketConfig` schema
- `src/coin-filter/coin-filter.service.ts` — dynamic `getEffectiveFilterConfig()` reads Redis first
- `src/ai-signal/ai-signal.service.ts` — per-coin 4h EMA trend filter in `processCoin()`, `IndicatorService` injected
- `src/strategy/rules/rule-engine.service.ts` — ADX gate in `evalTrendEma()`
- `src/strategy/indicators/indicator.service.ts` — added `getAdx()` method
- `src/strategy/ai-optimizer/ai-tuned-params.interface.ts` — added `adxMin?` to trendEma config
- `src/user/user-settings.service.ts` — stripped to minimal (saveApiKeys + getApiKeys only)
- `src/schemas/user-settings.schema.ts` — stripped of legacy fields
- `ecosystem.config.js` — fixed for production deployment

---

## 2026-03-03 (2) - Daily P&L Limits for Real Trading Mode

### Feature: Daily P&L Limits (Profit Target + Daily Stop Loss)

Users with real trading mode enabled can now configure automatic daily profit targets and stop-loss thresholds. When a limit is hit, all real positions are closed and real mode is auto-disabled until the next day.

**New Commands:**
- `/ai realmode target <N|off>` — Set daily profit target % (e.g. `target 5` = auto-close all + disable at +5%)
- `/ai realmode stoploss <N|off>` — Set daily stop loss % (e.g. `stoploss 3` = auto-close all + disable at -3%)
- `/ai realmode stats` — Detailed today's P&L: open trades with unrealized PnL + closed trades today + combined total

**Daily P&L Calculation:**
- `dailyPnlPct = (closedPnlToday + unrealizedPnlOpen) / totalNotionalToday × 100`
- Checked every 5 minutes via `@Cron("0 */5 * * * *")`

**Auto-Disable Behavior:**
- Limit hit → all algo orders cancelled → all open positions market-closed → real mode disabled → user notified
- `realModeDailyDisabledAt` field set to current timestamp on disable
- At 00:01 UTC: midnight reset cron (`@Cron("0 1 0 * * *")`) re-enables users disabled yesterday → notifies them
- Manual `/ai realmode on` also clears `realModeDailyDisabledAt` (fresh daily counter)

**Enhanced `/ai realmode` Overview:**
- Now shows current daily limits (target/SL %) alongside leverage and enabled status
- Shows quick today's PnL summary inline

### Schema Changes
- `src/schemas/user-signal-subscription.schema.ts` — added `realModeDailyTargetPct`, `realModeDailyStopLossPct`, `realModeDailyDisabledAt`

### Service Changes
- `src/ai-signal/user-signal-subscription.service.ts` — added `findRealModeSubscribersWithDailyLimits()`, `findUsersForDailyReset()`, `setDailyTargetPct()`, `setDailyStopLossPct()`, `setRealModeDailyDisabled()`
- `src/ai-signal/user-real-trading.service.ts` — added `getDailyStats()`, `closeAllRealPositions()`, `checkDailyLimits()` cron, `resetDailyLimits()` cron

### Files Modified
- `src/schemas/user-signal-subscription.schema.ts` — three new daily-limits fields
- `src/ai-signal/user-signal-subscription.service.ts` — daily-limits query/update methods
- `src/ai-signal/user-real-trading.service.ts` — daily stats, close-all, two new crons
- `src/ai-signal/ai-command.service.ts` — `/ai realmode target`, `/ai realmode stoploss`, `/ai realmode stats` handlers; enhanced overview

---

## 2026-03-03 (1) - Per-User Real Trading Mode

### Feature: Per-User Real Trading Mode

Users can now opt in to have real Binance Futures orders placed automatically whenever an AI signal activates.

**New Commands:**
- `/ai setkeys <key> <secret>` — Save Binance API credentials for real trading
- `/ai realmode [on|off|leverage AI|MAX|<N>]` — Enable/disable real mode and configure leverage

**Leverage Modes:** `AI` (use signal params leverage), `FIXED` (user-set value), `MAX` (query Binance max per symbol)

**Order Lifecycle:**
1. Signal activates → 0.5% tolerance check → MARKET open order placed
2. Algo SL order placed (`POST /fapi/v1/algoOrder`, `STOP_MARKET + closePosition=true`)
3. Algo TP order placed if signal has TP price (`TAKE_PROFIT_MARKET + closePosition=true`)
4. PnL ≥ 4% → old SL cancelled, new SL placed at entry (break-even)
5. PnL ≥ 5% → old SL cancelled, new SL raised to +2% profit (trailing stop)
6. Position close detected via WebSocket `ORDER_TRADE_UPDATE` → trade recorded + user notified with P&L

**Architecture:**
- `UserRealTradingService` orchestrates order placement and SL moves
- `UserDataStreamService` manages per-user Binance WS streams (1 per user); auto-reconnects on close with 10s delay + 30min keepalive
- Circular dep between the two services broken via `setDataStreamService()` setter injection in `onModuleInit`
- Price from `MarketDataService.getLatestPrice()` — in-memory WS map (no extra HTTP roundtrip); falls back to REST if symbol not in shortlist
- Symbol quantity precision cached in Redis (24h TTL) via `/fapi/v1/exchangeInfo`
- UserTrade documents track entry, SL/TP algo IDs, P&L, and close reason

### Files Added
- `src/ai-signal/user-real-trading.service.ts` — NEW: real order orchestration
- `src/ai-signal/user-data-stream.service.ts` — NEW: per-user Binance WS account stream
- `src/schemas/user-trade.schema.ts` — NEW: UserTrade history schema

### Files Modified
- `src/schemas/user-signal-subscription.schema.ts` — added `realModeEnabled`, `realModeLeverage`, `realModeLeverageMode`
- `src/ai-signal/user-signal-subscription.service.ts` — added `findRealModeSubscribers()`, `setRealMode()`, `setRealModeLeverage()`; updated SubscriberInfo
- `src/binance/binance.service.ts` — added `setTakeProfitAtPrice()`, `cancelAlgoOrder()`
- `src/ai-signal/ai-command.service.ts` — added `/ai setkeys` and `/ai realmode` handlers; injected new services
- `src/ai-signal/ai-signal.module.ts` — added UserModule, UserTrade schema, UserRealTradingService, UserDataStreamService
- `src/ai-signal/ai-signal.service.ts` — calls `userRealTradingService.onSignalActivated()` when signal goes ACTIVE
- `src/ai-signal/position-monitor.service.ts` — calls `moveStopLossForRealUsers()` at 4% and 5% SL milestones
- `src/market-data/market-data.service.ts` — added `latestPrices` in-memory map + `getLatestPrice()` method

---

## 2026-03-02 (2) - PnL/Volume Display Overhaul, Trend Filter, BB_SCALP Improvements

### Enhancement: PnL Display in USDT (not $)

All PnL amounts now use `USDT` suffix instead of `$` prefix. Prices keep `$`. Stats and signal displays updated:
- Stats page: shows cumulative USDT total (sum of all trades × 1000 USDT) + average % per trade
- Signal display: TP/SL lines show both % and USDT (e.g. `+15.00 USDT / +1.5%`)
- BTC signals use 5× volume (5,000 USDT) since BTC has small % moves
- Total PnL summary shows weighted USDT total across all active signals

### Feature: Global Regime Trend Filter (STRONG_BULL / STRONG_BEAR)

Replaced `STRONG_TREND` regime with directional `STRONG_BULL` and `STRONG_BEAR`. Detection uses proper technical indicators:
- **STRONG_BULL**: RSI(15m) > 58 + price above EMA9 + 4h RSI > 52 + price above EMA200
- **STRONG_BEAR**: RSI(15m) < 42 + price below EMA9 + 4h RSI < 48 + price below EMA200

Signal direction filter enforced in `ai-signal.service.ts`:
- `STRONG_BEAR` regime → skip all LONG signals
- `STRONG_BULL` regime → skip all SHORT signals

### Enhancement: BB_SCALP Strategy Improvements

Based on performance data (RSI_CROSS 63% win rate vs BB_SCALP 37%), tuned BB_SCALP to reduce over-trading:
- Changed SIDEWAYS default strategy from `BB_SCALP` → `RSI_CROSS`
- Haiku prompt updated to prefer RSI_CROSS in SIDEWAYS regime
- Tightened BB_SCALP params: `bbTolerance 0.3→0.1`, `rsiLongMax 52→45`, `rsiShortMin 48→55`
- Improved logic: requires confirmed bounce (prev candle at band + current candle reversing + RSI turning) instead of simple band touch

### Bug Fix: Duplicate BTCUSDT Dual-Timeframe Signals

When BTCUSDT:SWING had ACTIVE SHORT, BTCUSDT:INTRADAY SHORT would also activate simultaneously. Fixed with cross-profile direction check in `handleNewSignal()`.

### Bug Fix: Delayed SL Detection for Delisted Coins

When coins dropped off shortlist, WebSocket closed → price listeners stopped → TP/SL only caught by 30s polling. Fixed: `marketDataService` keeps WS alive for coins that have active price listeners.

### Files Modified
- `src/ai-signal/ai-command.service.ts` — USDT display, per-coin vol (BTC=5000), TP/SL USDT amounts, weighted total
- `src/ai-signal/ai-signal-stats.service.ts` — cumulative USDT PnL, USDT formatting
- `src/ai-signal/signal-queue.service.ts` — cross-profile direction dedup for dual-timeframe coins
- `src/market-data/market-data.service.ts` — keep WS alive for coins with active price listeners
- `src/strategy/ai-optimizer/ai-tuned-params.interface.ts` — `STRONG_BULL`/`STRONG_BEAR` replace `STRONG_TREND`
- `src/strategy/ai-optimizer/ai-optimizer.service.ts` — regime detection with EMA200, BB_SCALP tightened, SIDEWAYS→RSI_CROSS default, Haiku prompt updated
- `src/strategy/rules/rule-engine.service.ts` — BB_SCALP improved: confirmed bounce logic, tighter defaults
- `src/ai-signal/ai-signal.service.ts` — STRONG_BULL/BEAR direction filter, funding rate isTrend fix

---

## 2026-03-02 (1) - Signals UI Redesign, Auto-Push, Auto Risk Management, Orphan Cleanup

### Feature: Redesigned /ai signals UI

New box layout with `┌│└` borders for better readability. Entry/TP/SL on separate lines. Total PnL summary at top showing sum, average, and win/loss count. Extracted into reusable `formatSignalsMessage()` method.

### Feature: Auto-Push Signals (/ai push on|off)

Per-user opt-in auto-push: broadcasts signal updates every 10 minutes to subscribers who enable it. `signalsPushEnabled` field on subscription schema (default: false). 10-min cron in ai-command.service.ts.

### Feature: Auto Risk Management

Automatic profit protection for fast-moving markets:
- PnL >= 4%: SL moves to entry price (break-even), notification sent
- PnL >= 5%: auto-close signal as `AUTO_TAKE_PROFIT`, notification sent
- Works in both real-time listeners and test mode simulation
- `slMovedToEntry` field on AiSignal schema, `AUTO_TAKE_PROFIT` close reason added

### Bug Fix: Duplicate ACTIVE Signals (Orphan Cleanup)

Root cause: Redis TTL (8h) expires but MongoDB keeps `status: "ACTIVE"` → next scan creates new ACTIVE → duplicates. Fixed with:
- `cleanupOrphanedActives()` runs on startup before registering listeners
- `cancelOrphanedActives()` runs before every new signal creation
- Orphan check added to 5-min cleanup cron
- Display-level dedup in `formatSignalsMessage()` as safety net

### Files Modified
- `src/ai-signal/ai-command.service.ts` — new UI, `/ai push` command, 10-min cron, `formatSignalsMessage()`
- `src/ai-signal/position-monitor.service.ts` — auto risk management in `handlePriceTick()`, startup orphan cleanup
- `src/ai-signal/ai-signal.service.ts` — test mode risk management, `notifySlMovedToEntry()`, AUTO_TAKE_PROFIT notifications
- `src/ai-signal/signal-queue.service.ts` — `moveStopLossToEntry()`, `cleanupOrphanedActives()`, `cancelOrphanedActives()`
- `src/ai-signal/user-signal-subscription.service.ts` — `findSignalsPushSubscribers()`, `toggleSignalsPush()`
- `src/schemas/ai-signal.schema.ts` — `slMovedToEntry`, `AUTO_TAKE_PROFIT` close reason
- `src/schemas/user-signal-subscription.schema.ts` — `signalsPushEnabled` field
- `src/telegram/telegram.service.ts` — `/start` + BotFather menu updated with `/ai push`

---

## 2026-03-01 (1) - Dual Timeframe, Daily Snapshot Fix, Money Flow Toggle, Notification Simplification

### Feature: BTC/ETH Dual Timeframe Strategy

BTC and ETH now run both INTRADAY (15m) and SWING (4h) strategies simultaneously. Profile-aware Redis keys (`BTCUSDT:INTRADAY`, `BTCUSDT:SWING`) keep them as separate active signals.

- `DUAL_TIMEFRAME_COINS` constant in ai-signal.service.ts + signal-queue.service.ts
- `getSignalKey()` helper returns `SYMBOL:PROFILE` for dual coins
- `processCoin()` accepts `forceProfile` param for profile-specific locks/cooldowns
- `tuneParamsForSymbol()` accepts `forceProfile` with `applyForcedProfile()` override
- Position monitor resolves both INTRADAY and SWING keys for dual coins

### Feature: Daily Market Snapshot Fix

The daily snapshot (`@Cron("0 1 * * *")`) never saved because the bot wasn't running at 01:00 UTC. Fixed with:
- Startup check: generates snapshot if today's is missing (30s delay)
- `forceRegenerate` param on `generateDailySnapshot()`
- `/ai snapshot` admin command for manual regeneration
- `/ai market` auto-saves snapshot if today's is missing

### Feature: Money Flow Toggle Per User

Users can now opt out of money flow alerts with `/ai moneyflow off`:
- Added `moneyFlowEnabled` field to `UserSignalSubscription` schema (default: true)
- `findMoneyFlowSubscribers()` — filters subscribers by moneyFlowEnabled
- `toggleMoneyFlow(telegramId, enabled)` method
- `/ai moneyflow on|off` command with status display

### Enhancement: Simplified Signal Notifications

Removed all analytics, risk advice, strategy/regime/confidence from notifications. Now shows only essential trade info: direction, entry, TP, SL, timeframe, timestamp.

### Files Modified
- `src/ai-signal/ai-signal.service.ts` — Dual scan loop, processCoin forceProfile, getSignalKey, startup snapshot, simplified notifications, money flow filtered broadcast
- `src/strategy/ai-optimizer/ai-optimizer.service.ts` — tuneParamsForSymbol forceProfile, applyForcedProfile, profile-aware cache
- `src/ai-signal/signal-queue.service.ts` — handleNewSignal forceProfile, profile-aware Redis keys, docSignalKey helper
- `src/ai-signal/ai-command.service.ts` — `/ai snapshot` command, `/ai moneyflow` command, updated help text
- `src/ai-signal/position-monitor.service.ts` — Multi-key resolution for dual coins, expandToSignalKeys
- `src/ai-signal/user-signal-subscription.service.ts` — findMoneyFlowSubscribers, toggleMoneyFlow, getSubscription
- `src/schemas/user-signal-subscription.schema.ts` — moneyFlowEnabled field
- `src/telegram/telegram.service.ts` — BotFather menu + /start updated

---

## 2026-02-28 (4) - AI Features: Futures Analytics, Money Flow Monitor, Notification Formatting

### Feature: BotFather Auto-Registration

Added `registerBotMenu()` in `telegram.service.ts` that programmatically updates the Telegram bot command menu on startup:
- Calls `bot.deleteMyCommands()` to clear legacy commands
- Calls `bot.setMyCommands()` with current AI command list
- All `/ai` subcommands now accept underscore format (`/ai_subscribe`) via `[_ ]` regex in `ai-command.service.ts`

### Feature: Futures Analytics Service

**New file**: `src/market-data/futures-analytics.service.ts`

Fetches real-time futures data from Binance free APIs (no API key needed):
- Funding rate (`/fapi/v1/fundingRate`)
- Open Interest (`/fapi/v1/openInterest`)
- Long/Short ratio (`/futures/data/globalLongShortAccountRatio`)
- Taker buy/sell ratio (`/futures/data/takerlongshortRatio`)

Batches requests 10 at a time to avoid rate limits. Results cached in Redis (5 min TTL).

### Feature: Money Flow Monitor (Real-time Alerts)

Added `monitorMoneyFlow()` cron in `ai-signal.service.ts` — runs every 5 minutes:
- Fetches futures analytics for all shortlisted coins (50 coins)
- Compares current OI vs previous (stored in Redis, 10 min TTL)
- Detects alerts: OI surge >15%, OI drop >15%, extreme funding >0.1%, L/S ratio >2.5 or <0.4, volume spike >$500M + >15% price change
- Groups alerts by coin (avoids duplicate entries for same coin)
- Broadcasts formatted alert to all subscribers

### Feature: Real-time Prices in /ai market

Enriched `getAllCoinParams()` with `lastPrice`, `quoteVolume`, `priceChangePercent` from coin filter shortlist data. `/ai market` now shows price table with real-time data, market stats, and futures analytics section.

### Enhancement: Coin Monitoring Expansion

Updated `.env` settings:
- `AI_MAX_SHORTLIST_SIZE`: 30 → 50
- `AI_MIN_COIN_VOLUME_USD`: $20M → $10M
- `AI_MIN_PRICE_CHANGE_PCT`: 0.5 → 0.3

### Enhancement: Notification Formatting Overhaul

Rewrote all Telegram notification methods with consistent clean style:

**Style guide:**
- Emoji header with coin name + type icon
- `━━━━━━━━━━━━━━━━━━` separator line
- Smart `fmtPrice()`: $1000+ no decimals, $1-999 two decimals, <$0.01 four-six decimals
- No tree characters (`├└`), no backslash-escaped brackets
- `🧪` emoji for test mode (replaces `\[TEST\]`)

**Methods updated:**
- `notifySignalTestMode()` — test signal notification
- `notifySignalActive()` — live signal notification
- `notifySignalQueued()` — queued signal notification
- `notifyQueueActivated()` — queue → active transition
- `notifyPositionClosed()` — TP/SL/close notification
- `checkTestModeSignal()` SL notification — admin SL alert
- Money flow alert builder — grouped by coin, emoji tags

### Bug Fix: JSON Parse Error in Market Overview

Haiku sometimes returns malformed JSON (trailing commas, control chars, missing commas). Added repair logic:
```typescript
const repaired = jsonMatch[0]
  .replace(/,\s*([\]}])/g, "$1")        // trailing commas
  .replace(/[\x00-\x1F]/g, " ")          // control chars
  .replace(/(["\w])\s*\n\s*(")/g, "$1,$2"); // missing commas
```
Also increased `max_tokens` from 500 → 800 in `ai-optimizer.service.ts`.

### Bug Fix: BotFather Old Commands

`setMyCommands()` alone didn't replace manually-set BotFather commands. Fixed by calling `deleteMyCommands()` first.

### Files Modified
- `src/telegram/telegram.service.ts` — `registerBotMenu()`
- `src/ai-signal/ai-command.service.ts` — all regex patterns updated to `[_ ]`
- `src/ai-signal/ai-signal.service.ts` — money flow monitor, enriched params, all notification formatting
- `src/strategy/ai-optimizer/ai-optimizer.service.ts` — market overview with analytics, JSON repair, max_tokens
- `src/market-data/futures-analytics.service.ts` — NEW (Binance futures analytics)
- `src/market-data/market-data.module.ts` — registered FuturesAnalyticsService
- `.env` — updated coin filter settings

---

## 2026-02-28 (3) - Refactor: Extract Domain Services from TelegramBotService

### Refactor: `telegram.service.ts` reduced from 4,537 → ~200 lines

`TelegramBotService` is now a thin command router. All business logic extracted into focused NestJS modules:

| New Module | Service(s) | Responsibility |
|---|---|---|
| `src/account/` | `AccountService` | `/start`, `/setkeys`, `/accounts`; `getUserData`, `getActiveExchange`, `ensureChatIdStored` helpers |
| `src/position/` | `PositionService` | `/position`, `/close`, `/closeall`, `closeAllPositions` |
| `src/reentry/` | `ReentryService` | `checkReentryOpportunities` (cron 30s), `executeReentry`, `checkReentrySafety`, `calculateEMA` |
| `src/take-profit/` | `TakeProfitService` | 5 crons: `checkTakeProfitTargets`, `checkMissingTpSl`, `checkPriceLevelTpSl`, `checkExpiredPositions`, `sendPeriodicUpdates` |
| `src/take-profit/` | `TakeProfitHandlersService` | `/setaccount`, `/setposition`, `/setmode`, `/cleartp`, `/setalltp`, `/setmaxpos`, `/update`, `/updates` |
| `src/bot-signal-trade/` | `BotSignalTradeService` | `handleIncomingSignal`, `executeSignalTrade`, `notifyUsersForBot`, `/setbot`, `/clearbot`, `/clearbots`, `/listbots` |

### Key design decisions
- All domain modules inject `TelegramBotService` via `forwardRef(() => TelegramModule)` for `sendTelegramMessage()`
- `TelegramModule` imports all domain modules wrapped in `forwardRef()` to resolve circular deps
- `TelegramBotService` exposes: `sendTelegramMessage()`, `deleteMessage()`, `registerBotCommand()`, `notifyUsersForBot()` (delegate), `handleIncomingSignal()` (delegate)
- `closeAllPositions` lives in `PositionService`, injected by `TakeProfitModule` for reuse
- `storeTpSl` Redis helper duplicated locally in `TakeProfitService`, `TakeProfitHandlersService`, and `BotSignalTradeService` (pure Redis helper, no external dependency)

### New files
- `src/account/account.module.ts`, `account.service.ts`
- `src/position/position.module.ts`, `position.service.ts`
- `src/reentry/reentry.module.ts`, `reentry.service.ts`
- `src/take-profit/take-profit.module.ts`, `take-profit.service.ts`, `take-profit-handlers.service.ts`
- `src/bot-signal-trade/bot-signal-trade.module.ts`, `bot-signal-trade.service.ts`

### Modified files
- `src/telegram/telegram.service.ts` — gutted to ~200 lines
- `src/telegram/telegram.module.ts` — imports all new domain modules via `forwardRef()`

---

## 2026-02-28 (2) - Schema Consolidation + Redis Migration + Remove Retry Commands

### Refactor: Centralize all schemas in `src/schemas/`

All Mongoose schema files moved from `src/user/schemas/` and `src/ai-signal/schemas/` to a single `src/schemas/` folder:
- `src/schemas/user-settings.schema.ts`
- `src/schemas/ai-signal.schema.ts`
- `src/schemas/ai-coin-profile.schema.ts`
- `src/schemas/ai-regime-history.schema.ts`
- `src/schemas/user-signal-subscription.schema.ts`

9 files updated with new import paths. Old `src/user/schemas/` and `src/ai-signal/schemas/` directories deleted.

### Feature: One-time Redis → MongoDB migration on startup

`UserSettingsService` now implements `OnModuleInit` and runs `migrateFromRedis()` on startup:
- Scans Redis for `user:*:binance` and `user:*:okx` keys
- For each user not yet in MongoDB, reads all settings (apiKeys, TP, bots, retry, maxPos, activeEx, updatesDisabled) and upserts into `user_settings`
- Idempotent — skips users already in MongoDB
- `UserModule` now imports `RedisModule` to support this

### Removed: `/setretry` and `/clearretry` Telegram commands

The retry system configuration commands have been removed:
- `handleSetRetry()` and `handleClearRetry()` methods deleted
- `bot.onText(/\/setretry/)` and `bot.onText(/\/clearretry/)` registrations removed
- Help text updated to remove the Re-entry section
- The internal retry execution logic (`checkReentryOpportunities`, `executeReentry`) remains intact

---

## 2026-02-28 - User Settings Migrated to MongoDB

### Feature: MongoDB-backed User Settings

All persistent user configuration previously stored in Redis has been migrated to a MongoDB collection (`user_settings`). Ephemeral position-lifecycle data (reentry, tpsl, opentime) remains in Redis.

#### New Files

- `src/user/schemas/user-settings.schema.ts` — Mongoose schema (`UserSettings` root + `ExchangeSettings` + `BotConfigEntry` embedded docs)
- `src/user/user-settings.service.ts` — Full CRUD service with cron query helpers
- `src/user/user.module.ts` — NestJS module (imports MongooseModule, exports UserSettingsService)

#### Modified Files

- `src/telegram/telegram.module.ts` — Added `UserModule` to imports
- `src/telegram/telegram.service.ts` — All user settings Redis calls replaced with `UserSettingsService` calls

#### Data Migrated to MongoDB (`user_settings` collection)

| Old Redis Key | New MongoDB Field |
|---|---|
| `user:{id}:{exchange}` (apiKey/secret) | `binance.apiKey`, `okx.apiKey`, etc. |
| `user:{id}:active` | `activeExchange` |
| `user:{id}:updates:disabled` | `updatesDisabled` |
| `user:{id}:tp:{exchange}` | `binance.tpPercentage`, `binance.tpInitialBalance` |
| `user:{id}:tp:mode:{exchange}` | `binance.tpMode` |
| `user:{id}:tp:individual:{exchange}` | `binance.tpIndividualPercentage` |
| `user:{id}:bots:{exchange}` | `binance.bots[]` |
| `user:{id}:retry:{exchange}` | `binance.retryMaxRetry`, etc. |
| `user:{id}:maxpos:{exchange}` | `binance.maxPositions` |

#### Cron Query Helpers (replace Redis SCAN)

- `findAllUsersWithTp()` — replaces `keys("user:*:tp:*")`
- `findAllUsersWithBots()` — replaces `keys("user:*:bots:*")`
- `findUsersWithBot(botType)` — replaces SCAN + per-key fetch loop

#### Ephemeral Keys Remaining in Redis

- `user:{id}:reentry:{exchange}:{symbol}` — re-entry position data
- `user:{id}:tpsl:{exchange}:{symbol}` — TP/SL prices for scheduler
- `user:{id}:opentime:{exchange}:{symbol}` — position open timestamp

---

## 2026-02-26 (2) - Bot Signal TCP Integration

### New Feature: Bot Signal Auto-Trading

Integrated `bot-signal` service with `binance-tele-bot` via TCP microservice so that trading signals generated by bot-signal formulas are automatically executed for users who have opted into specific bot types.

#### Architecture

```
bot-signal (SendSignalProcessor)
    ↓  TCP (port 8010)
binance-tele-bot TCP Microservice
    ↓
SignalController.handleSignal()
    ↓
TelegramBotService.handleIncomingSignal()
    ↓  (for each user with that botType enabled)
executeSignalTrade()
    ├→ openPosition() on exchange
    ├→ setStopLoss() on exchange
    └→ Notify user via Telegram
```

#### New Files

- `src/signal/signal.controller.ts` — TCP `@MessagePattern({ cmd: 'bot-receive-signal' })` handler
- `src/signal/signal.module.ts` — `SignalModule` that imports `TelegramModule`

#### Modified Files (binance-tele-bot)

- `src/interfaces/user.interface.ts` — Added `UserBotConfig` and `UserBotsConfig` interfaces
- `src/main.ts` — Added `app.connectMicroservice()` with TCP transport on `TCP_HOST:TCP_PORT` (default `127.0.0.1:8010`)
- `src/app.module.ts` — Imported `SignalModule`
- `src/telegram/telegram.module.ts` — Added `exports: [TelegramBotService]`
- `src/telegram/telegram.service.ts`:
  - Added `BOT_TYPE_MAP` / `BOT_TYPE_REVERSE_MAP` constants (CT1–CT8 ↔ BOT_FUTURE_CT_N)
  - Added `IncomingSignal` interface
  - Added `/setbot`, `/clearbot`, `/clearbots`, `/listbots` commands
  - Added `handleIncomingSignal()` — public method called by TCP controller
  - Added `executeSignalTrade()` — opens position + sets SL on Binance or OKX
  - Added `getQuantityPrecision()` — price-based decimal helper
- `package.json` — Added `@nestjs/microservices: ^10.3.0`
- `.env.example` — Added `TCP_HOST`, `TCP_PORT`

#### Modified Files (bot-signal)

- `src/common/constant.ts` — Added `TELE_BOT_SERVICE_HOST/PORT` to `EnvConfig`, `TELE_BOT` to `SERVICE_NAME`
- `src/bot-signal/send-signal.processor.ts` — Added `teleBotTcp` client; forwards every live signal to binance-tele-bot (fire-and-forget)
- `.env.example` — Added `TELE_BOT_SERVICE_HOST`, `TELE_BOT_SERVICE_PORT`

#### New Redis Keys

```
binance-bot:user:{telegramId}:bots:{exchange}  →  UserBotsConfig
  { bots: [{ botType, enabled, tradeAmount, leverage, enabledAt }], updatedAt }
```

#### New Telegram Commands

| Command | Description |
|---------|-------------|
| `/setbot binance CT1 100 10` | Enable CT1 on Binance, $100/trade, 10x leverage |
| `/clearbot binance CT1` | Disable CT1 on Binance |
| `/clearbots binance` | Disable all bots on Binance |
| `/listbots` | Show all enabled bots across exchanges |

#### Signal Execution Logic

1. Only FUTURE signals are processed (SPOT skipped)
2. Symbol mapping: Binance = `${coin}${currency}`, OKX = `${coin}-${currency}-SWAP`
3. Quantity = `tradeAmount / currentPrice` (rounded by price-based precision helper)
4. Stop loss is set fire-and-forget (failure logged, trade not aborted)
5. User notified via Telegram on success or failure

---

## 2026-02-26 - Performance & Correctness Fixes

### Bug Fixes

#### 1. OKX `cancel-algos` Wrong Request Body

**Problem**: `setTakeProfit` in `okx.service.ts` was wrapping the cancel payload in `{ data: [...] }` — the OKX API expects the array as the direct body. Existing TP orders were never cancelled before placing new ones.

**Fix**: Changed `client.post("/api/v5/trade/cancel-algos", { data: [...] })` → `client.post("/api/v5/trade/cancel-algos", [...])`.

**Files Modified**: `src/okx/okx.service.ts`

---

#### 2. "10-Minute Update" Label Mismatch

**Problem**: `sendPeriodicUpdates` cron runs `@Cron(EVERY_5_MINUTES)` but the notification message said "10-Minute Update".

**Fix**: Changed message text to "5-Minute Update" for both Binance and OKX.

**Files Modified**: `src/telegram/telegram.service.ts`

---

#### 3. "babywatermelon" Hardcoded in Position Output

**Problem**: The `/position` command included the literal string `babywatermelon` in position messages for both exchanges — a test artifact left in production.

**Fix**: Replaced with `Đang có các vị thế:` for both exchange blocks.

**Files Modified**: `src/telegram/telegram.service.ts`

---

#### 4. `BinanceService.volume` Incorrect Formula

**Problem**: Volume was computed as `margin * quantity` (dimensionally nonsensical). Standard position notional value is `quantity * entryPrice`.

**Fix**: Changed formula to `volume = quantity * entryPrice`.

**Files Modified**: `src/binance/binance.service.ts`

---

### Performance Improvements

#### 5. `BinanceService.getAccountBalance` — Eliminated Double `getOpenPositions` Call

**Problem**: `getAccountBalance` internally called `getOpenPositions` just to sum `totalUnrealizedProfit`. When `/position` called both methods, `getOpenPositions` ran twice.

**Fix**: Replaced with `client.futuresAccountInfo()` which returns `totalWalletBalance`, `availableBalance`, and `totalUnrealizedProfit` directly in one API call.

**Files Modified**: `src/binance/binance.service.ts`

---

#### 6. `OkxService.getAccountBalance` — Eliminated Double `getOpenPositions` Call

**Problem**: Same issue as Binance — `getAccountBalance` called `getOpenPositions` internally for unrealized PnL.

**Fix**: Use `usdtDetail.upl` from the OKX `/api/v5/account/balance` response (already included in the response).

**Files Modified**: `src/okx/okx.service.ts`

---

#### 7. `BinanceService.getOpenPositions` — N+1 API Calls

**Problem**: For each open position, it called `client.futuresOpenOrders({ symbol })` individually — 10 positions = 11 API calls, risking rate limits.

**Fix**: Fetch all open orders once with `client.futuresOpenOrders({})`, group into a `Map<symbol, orders[]>`, then look up per-position in O(1).

**Files Modified**: `src/binance/binance.service.ts`

---

#### 8. `RedisService.keys()` — `KEYS` → `SCAN`

**Problem**: `client.keys(pattern)` is a blocking O(N) Redis command that halts the server during execution. Called in 3 cron jobs every 15–30 seconds.

**Fix**: Replaced with SCAN cursor loop (`COUNT: 100`) which is non-blocking and iterative.

```typescript
let cursor = 0;
do {
  const result = await this.client.scan(cursor, { MATCH: fullPattern, COUNT: 100 });
  cursor = result.cursor;
  allKeys.push(...result.keys);
} while (cursor !== 0);
```

**Files Modified**: `src/redis/redis.service.ts`

---

#### 9. `checkReentryOpportunities` — Cooldown Before API Calls

**Problem**: Every 30-second cron tick fetched current price + 30 klines from the exchange for each pending re-entry, even if still in the 30-minute cooldown.

**Fix**: Moved the cooldown date check to the top of the loop (pure math, zero API calls). API calls only happen after cooldown passes. Also removed duplicate cooldown check inside `checkReentrySafety`.

**Files Modified**: `src/telegram/telegram.service.ts`

---

#### 10. `checkAggregateTP` — `retryConfig` Double Redis Fetch

**Problem**: In both the Binance and OKX branches, `retryConfig` was fetched from Redis twice per TP trigger — once inside the `profitablePositions` block and again for building the notification message.

**Fix**: Hoisted `retryConfig` fetch to before the `profitablePositions.length > 0` block; single result reused for both purposes.

**Files Modified**: `src/telegram/telegram.service.ts`

---

#### 11. `handlePosition` — Sequential → Parallel Exchange Fetches

**Problem**: When a user had both Binance and OKX connected, `/position` fetched them sequentially.

**Fix**: Wrapped both exchange fetch operations in a top-level `Promise.all`. Both exchanges are fetched concurrently; errors per-exchange are caught independently.

**Files Modified**: `src/telegram/telegram.service.ts`

---

### Reliability Improvements

#### 12. Cron Concurrency Guard

**Problem**: `checkTakeProfitTargets` and `checkReentryOpportunities` both run on 30-second intervals. If processing takes longer than 30 seconds, two cron ticks could process the same user+exchange concurrently, risking duplicate position closes or race conditions in Redis state.

**Fix**: Added `private readonly processingLocks = new Set<string>()` to `TelegramBotService`. Each user+exchange acquires a lock before processing and releases it in a `finally`-equivalent block.

**Files Modified**: `src/telegram/telegram.service.ts`

---

## 2026-01-31 - Entry Price Optimization & Documentation Organization

### Entry Price Optimization (NEW FEATURE)

**Problem**: When re-entering positions, the system was using the ORIGINAL entry price for all calculations, not the actual execution price. This could lead to inaccurate TP/SL calculations and missed optimization opportunities.

**Solution**: Updated re-entry logic to use ACTUAL execution price from order results.

**Implementation**:

```typescript
// Extract actual execution price from order result
const actualEntryPrice = orderResult?.avgPrice
  ? parseFloat(orderResult.avgPrice)
  : reentryData.entryPrice; // Fallback

// Calculate TP based on NEW entry (not original)
const takeProfitPrice = isLong
  ? parseFloat(
      (actualEntryPrice * (1 + reentryData.tpPercentage / 100)).toFixed(4),
    )
  : parseFloat(
      (actualEntryPrice * (1 - reentryData.tpPercentage / 100)).toFixed(4),
    );

// Calculate next stop loss based on NEW entry price
const potentialNextProfit =
  Math.abs(takeProfitPrice - actualEntryPrice) * nextQuantity;
const nextStopLossPrice = isLong
  ? parseFloat(
      (actualEntryPrice - potentialNextProfit / nextQuantity).toFixed(4),
    )
  : parseFloat(
      (actualEntryPrice + potentialNextProfit / nextQuantity).toFixed(4),
    );

// Store NEW entry price for next retry
await this.redisService.set(
  `user:${telegramId}:reentry:${exchange}:${symbol}`,
  {
    ...reentryData,
    entryPrice: actualEntryPrice, // 🔥 Use actual execution price
    stopLossPrice: nextStopLossPrice, // 🔥 SL based on new entry
    quantity: nextQuantity,
    // ...
  },
);
```

**Benefits**:

1. **Better Risk/Reward**: Entry adapts to market conditions (e.g., $100k → $95k → $92k)
2. **Accurate Stop Loss**: SL calculated from actual entry, not original
3. **Market Adaptation**: System uses real execution prices, no slippage accumulation
4. **Price Improvement Tracking**: Notifications show entry improvement percentage

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines 740-950: Re-entry execution logic
- `src/binance/binance.service.ts` - Lines 283-320: Return avgPrice in order result
- `src/okx/okx.service.ts` - Lines 389-445: Fetch and return avgPrice
- `src/simulator/complete-system.simulator.ts` - Lines 703-789: New Scenario 6 test

**Testing**:

- Added Scenario 6: Entry Price Optimization
- Tests entry adaptation: $100k → $95k → $92k
- Tests SL calculation based on actual entries
- Result: ✅ 100% pass (6/6 complete system tests)
- Overall: 20/24 tests passing (83.3%)

### Documentation Organization (IMPROVEMENT)

**Problem**: Technical documentation files were scattered in root directory instead of organized in `.claude/` folder.

**Solution**: Moved all technical docs to `.claude/` and updated documentation-workflow skill to remember this pattern.

**Changes**:

- Moved `TEST_FAILURES_ANALYSIS.md` → `.claude/TEST_FAILURES_ANALYSIS.md`
- Moved `TEST_SUITE_OVERVIEW.md` → `.claude/TEST_SUITE_OVERVIEW.md`
- Moved `TESTING_IMPLEMENTATION_SUMMARY.md` → `.claude/TESTING_IMPLEMENTATION_SUMMARY.md`
- Updated all file references in skill guides

**Organization Rules**:

```
Root directory:
  - README.md, TESTS_README.md, TESTING_GUIDE.md (user-facing)
  - package.json, tsconfig.json (config only)

.claude/ directory:
  - All technical documentation
  - CHANGELOG.md, ARCHITECTURE.md, *_TECHNICAL.md
  - *_IMPLEMENTATION_SUMMARY.md, *_ANALYSIS.md

.claude/skills/ directory:
  - Individual SKILL.md files
  - One folder per skill domain
```

**Files Modified**:

- `.claude/skills/documentation-workflow/SKILL.md` - Added file organization section
- `.claude/skills/testing-simulator/SKILL.md` - Updated file paths
- `.claude/skills/retry-reentry-system/SKILL.md` - Updated file paths

**Benefits**:

- Clear separation: user-facing vs technical docs
- Easier navigation and maintenance
- AI assistant knows where to place new docs
- Consistent project structure

---

## 2026-01-31 - Added 2% Minimum Profit Filter

### Enhancement

**What Changed**: Added minimum 2% profit requirement for positions to be closed when TP is reached.

**Implementation**:

```typescript
// New filter logic
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  // Calculate profit percentage
  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Minimum 2% profit required
});
```

**Rationale**:

- Filters out small price fluctuations (< 2% gains)
- Ensures meaningful profit before closing positions
- Reduces unnecessary re-entries
- Covers trading fees and slippage
- Avoids premature exit from positions

**Examples**:

| Position  | Entry  | Current | Profit % | Dollar PnL | Action             |
| --------- | ------ | ------- | -------- | ---------- | ------------------ |
| BTC LONG  | $100   | $101.50 | 1.5%     | +$1.50     | ❌ Left open       |
| ETH LONG  | $3000  | $3070   | 2.33%    | +$70       | ✅ Closed          |
| SOL SHORT | $100   | $98     | 2%       | +$2.00     | ❌ Left open (=2%) |
| AVAX LONG | $50000 | $51500  | 3%       | +$1500     | ✅ Closed          |

**Files Modified**:

- `src/telegram/telegram.service.ts`: Lines 204-213 (Binance), Lines 365-374 (OKX)
- `.claude/RETRY_SYSTEM_TECHNICAL.md`: Updated Phase 1 filtering logic
- `.claude/skills/retry-reentry-system/SKILL.md`: Updated filtering section with examples
- `.claude/CHANGELOG.md`: This entry

**Impact**: More selective position closing, better profit management, reduced noise.

---

## 2026-01-31 - Retry System Enhancements

### Features

#### 1. Selective Position Closing (Profitable + Minimum 2% Profit)

**What Changed**: When TP target is reached, bot now only closes positions with PnL > 0 AND profit > 2%

**Before**:

```typescript
// Closed ALL positions regardless of profit/loss
await closeAllPositions(userData, positions);
```

**After**:

```typescript
// Filter positions: profitable AND > 2% gain
const profitablePositions = positions.filter((pos) => {
  if (pos.unrealizedPnl <= 0) return false;

  const isLong = pos.side === "LONG";
  const profitPercent = isLong
    ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

  return profitPercent > 2; // Minimum 2% profit
});
await closeAllPositions(userData, profitablePositions);
```

**Benefits**:

- Losing positions stay open (can recover)
- Small gains (< 2%) stay open (avoid premature exit)
- Only meaningful profits trigger re-entry
- Filters out noise and small fluctuations
- Covers trading fees and slippage
- More intelligent profit management
- Better risk control

**Example Scenarios**:

| Position  | Entry | Current | Profit % | Action              |
| --------- | ----- | ------- | -------- | ------------------- |
| BTC LONG  | $100  | $101.50 | 1.5%     | ❌ Left open (< 2%) |
| ETH LONG  | $3000 | $3070   | 2.33%    | ✅ Closed (> 2%)    |
| SOL SHORT | $100  | $97     | 3%       | ✅ Closed (> 2%)    |
| AVAX LONG | $50   | $48     | -4%      | ❌ Left open (loss) |

**User Notification Updated**:

```
🎯 Take Profit Target Reached! (BINANCE)

Target: 10% of $1000.00
Target Profit: $100.00
Unrealized PnL: $105.50
Total Balance: $1105.50

✅ Closed 2 profitable position(s)
💰 Total Profit Captured: $105.50

  BTCUSDT: LONG $75.00
  ETHUSDT: LONG $30.50

🔄 Auto Re-entry Enabled
Will re-enter when price returns (15% volume reduction)
Retries remaining: 5/5
```

#### 2. Profit-Protected Stop Loss Calculation

**What Changed**: Stop loss now uses risk-equals-reward approach, protecting minimum profit

**Old Calculation**:

```typescript
// Used previous TP price as SL
const stopLossPrice = tpPrice; // Too conservative
```

**New Calculation**:

```typescript
// Calculate potential next profit
const potentialNextProfit = Math.abs(tpPrice - entryPrice) × nextQuantity;
const profitPerUnit = potentialNextProfit / nextQuantity;

// Allow position to lose its potential gain
const stopLossPrice = isLong
  ? entryPrice - profitPerUnit
  : entryPrice + profitPerUnit;
```

**Example**:

**Position A (Original)**:

- Entry: $100, Quantity: 1 BTC, LONG
- TP at 10%: $110
- Profit: **$10** (closed and secured)

**Position B (Re-entry)**:

- Entry: $100, Quantity: 0.85 BTC (15% reduction)
- Potential TP profit: ($110 - $100) × 0.85 = **$8.50**
- Stop Loss: $100 - $10 = **$90**

**Outcomes**:

- 📉 SL hits at $90: Loss = -$8.50, **Net = $1.50** ✅
- 📈 TP hits at $110: Profit = +$8.50, **Total = $18.50** 🎯

**Benefits**:

- Secures minimum profit = original profit - potential next profit
- Risk equals reward (symmetrical risk/reward)
- More aggressive than old method (higher profit potential)
- Still protects core gains

#### 3. Automatic Exchange Orders for Re-entry

**What Changed**: Both Stop Loss AND Take Profit are now automatically set on the exchange

**Before**:

```typescript
// Only set stop loss
await setStopLoss(...);
// TP monitoring done by bot
```

**After**:

```typescript
// Set stop loss on exchange
await setStopLoss({
  symbol: reentryData.symbol,
  stopPrice: stopLossPrice,
  side: reentryData.side,
  quantity: reentryData.quantity,
});

// Set take profit on exchange ⭐ NEW
await setTakeProfit({
  symbol: reentryData.symbol,
  tpPercentage: reentryData.tpPercentage,
});
```

**Benefits**:

- Orders execute even if bot is offline
- Exchange handles timing and execution
- User can see orders in exchange UI
- More reliable than bot monitoring
- Reduces bot API calls

**User Notification Updated**:

```
🔄 Re-entered Position! (BINANCE)

📈 BTCUSDT LONG
Entry: $100,000
Quantity: 0.8500 (-15.0% from original)
Volume: $85,000.00
Leverage: 10x

🎯 Take Profit: $110,000 (+10%)
🛡️ Stop Loss: $90,000 (Profit Protected)

Retry 1/5
Retries remaining: 4
```

### Files Modified

**src/telegram/telegram.service.ts**:

- Lines 207-253: Updated Binance TP check with profitable filter + new SL calc
- Lines 363-409: Updated OKX TP check with profitable filter + new SL calc
- Lines 282-297: Updated Binance TP notification message
- Lines 420-435: Updated OKX TP notification message
- Lines 605-625: Updated re-entry execution to set both SL and TP
- Lines 752-775: Updated re-entry notification message

**Documentation**:

- `.claude/RETRY_SYSTEM_TECHNICAL.md`: Updated Phase 1 and Phase 3 with new logic
- `.claude/skills/retry-reentry-system/SKILL.md`: Created comprehensive skill guide

### Database Schema Changes

**ReentryData** (Redis storage):

```typescript
{
  // Existing fields...
  currentPrice: number,        // ⭐ NEW: Price when position closed
  closedProfit: number,        // ⭐ NEW: Profit from closed position
  stopLossPrice: number,       // Updated calculation method
  // ...
}
```

### Migration Notes

- No database migration needed (backward compatible)
- Old reentry data will use fallback SL calculation
- New positions will use updated calculation automatically

---

## 2026-01-30 - Command Name Standardization

### Changes

#### Unified Command Naming: /set-account → /setaccount

**Reason**: Standardize all commands to use single-word format without hyphens for consistency and easier typing.

**Changes Made**:

- Command pattern: `/setaccount` (no change in regex, already was `/setaccount`)
- All help text updated from `/set-account` to `/setaccount`
- Error messages updated to show `/setaccount`
- Quick start guides updated

**Command Format**:

```
/setaccount exchange % balance
```

**Examples**:

```
/setaccount binance 5 1000
/setaccount okx 10 2000
```

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines 63, 65, 517, 635, 886, 979-980, 993, 1160
  - Updated all instances of `/set-account` text to `/setaccount`
  - Logger message, help text, error messages, footer text

**User Impact**:

- No breaking change - command was already `/setaccount` in code
- Only help text/documentation updated for consistency
- Users typing `/set-account` will get "unknown command" (as before)

---

## 2026-01-30 - Command Architecture Redesign & Position Management

### Breaking Changes

#### Removed Active Exchange Concept

**Problem**: The `/switch` command workflow was confusing:

- Users had to remember which exchange was currently active
- Required extra step before executing commands
- Not intuitive for managing multiple exchanges

**Solution**: Direct exchange specification in commands

- **Removed**: `/switch` command entirely
- **Updated All Commands**: Now require exchange parameter

**Command Changes**:

```
Old: /switch binance → /set-account 5 1000
New: /set-account binance 5 1000

Old: /switch okx → /cleartp
New: /cleartp okx

Old: /switch binance → /update
New: /update binance
```

**Benefits**:

- More explicit and clear which exchange is being operated on
- No mental overhead of tracking active exchange
- Commands are self-documenting
- Easier to script and automate

**Files Modified**:

- `src/telegram/telegram.service.ts` - Removed `handleSwitchExchange()` method
- All command handlers updated to parse exchange from arguments

#### Updated Command Signatures

**`/set-account`** - Now requires exchange

```
Format: /set-account [exchange] [%] [balance]
Example: /set-account binance 5 1000
Example: /set-account okx 10 2000
```

**`/cleartp`** - Now requires exchange

```
Format: /cleartp [exchange]
Example: /cleartp binance
Example: /cleartp okx
```

**`/update`** - Now requires exchange

```
Format: /update [exchange]
Example: /update binance
Example: /update okx
```

**Files Modified**:

- `src/telegram/telegram.service.ts` - Lines ~73, ~76, ~83 (command patterns)
- `handleSetAccount()`, `handleClearTakeProfit()`, `handleManualUpdate()` - Updated argument parsing

### New Features

#### 1. Close All Positions Command

**Command**: `/closeall [exchange]`

**Description**: Close all open positions on specified exchange at once

**Examples**:

```
/closeall binance
/closeall okx
```

**Features**:

- Validates exchange exists and is connected
- Fetches all open positions
- Closes positions sequentially with error handling
- Shows progress feedback during execution
- Confirms total positions closed

**Implementation**:

- `src/telegram/telegram.service.ts` - New `handleCloseAllPositions()` method
- Reuses existing `closeAllPositions()` helper
- Added command handler on line ~89

#### 2. Close Position by Symbol Command

**Command**: `/close [exchange] [symbol]`

**Description**: Close a specific position by symbol

**Examples**:

```
/close binance BTCUSDT
/close okx BTC-USDT-SWAP
```

**Features**:

- Validates exchange and symbol
- Looks up position in open positions
- Shows error if position not found
- Displays position details after closing (side, entry price, PnL)
- Proper symbol format validation

**Implementation**:

- `src/telegram/telegram.service.ts` - New `handleClosePosition()` method
- Symbol lookup from `getOpenPositions()`
- Exchange-specific close methods
- Added command handler on line ~95

**Files Modified**: `src/telegram/telegram.service.ts`

### Updated Documentation

**`/start` Command Help**:

```
/position - View positions & PnL
/accounts - View configs & TP settings
/set-account exchange % balance - Set TP target
/close exchange symbol - Close specific position
/closeall exchange - Close all positions
/cleartp exchange - Remove TP target
/update exchange - Get balance & TP progress
/setkeys exchange ... - Update API keys
```

**`/setkeys` Success Message**:

- Updated quick start guide to show exchange-specific commands
- Changed tip from "/switch" to "/closeall [exchange]"

**`/accounts` Footer**:

- Changed from "Use /switch [exchange]..." to "Use /set-account [exchange]..."

**Files Modified**: `src/telegram/telegram.service.ts` - Lines ~510-520, ~635-645, ~870

### Technical Details

**Active Exchange Tracking**:

- Still maintained in Redis (`user:{id}:active`) for backward compatibility
- Not used by any commands anymore
- May be fully removed in future version

**Error Handling**:

- All commands validate exchange parameter first
- Clear error messages for missing or invalid exchanges
- Position not found errors include hint to use `/position`

**Migration Notes**:

- Users need to update their command syntax
- Old `/switch` command will return "unknown command" error
- All existing TP configurations remain unchanged (exchange-specific Redis keys still work)

---

## 2026-01-30 - UX Improvements & Command Refinements

### User Experience Enhancements

#### 1. Improved Command Descriptions & Workflow

**Changes**:

- **`/start`**: Reordered commands by usage frequency, clearer descriptions
  - Prioritized `/position` as first command (most common use case)
  - Removed redundant "(active exchange)" suffixes
  - More concise, action-oriented descriptions
- **`/setkeys`**: Added quick start guide after successful setup
  - Shows 3 most important next steps
  - Includes tip about switching exchanges
- **`/switch`**: Enhanced feedback with contextual next actions
  - Shows what commands now operate on switched exchange
  - Provides immediate action suggestions
- **`/accounts`**: Now displays TP configuration for each exchange
  - Shows TP percentage, initial balance, and target profit
  - Clear visual distinction between active/inactive exchanges

**Benefits**:

- Faster onboarding for new users
- Clearer understanding of active exchange context
- Reduced support questions about which exchange is active

**Files Modified**: `src/telegram/telegram.service.ts`

#### 2. Enhanced `/accounts` Command

**Before**: Only showed exchange connection status and creation date

**After**: Comprehensive account overview including:

- Active exchange indicator (🟢/⚪)
- TP configuration per exchange
- Target profit calculation
- "Not set" status when TP not configured

**Example Output**:

```
📋 Your Connected Accounts

🟢 Binance
├ Created: 1/30/2026
├ TP Config: 5% of $1000.00
└ TP Target: $50.00

⚪ OKX
├ Created: 1/30/2026
└ TP Config: Not set

Active Exchange: BINANCE
```

**Files Modified**: `src/telegram/telegram.service.ts` - `handleListAccounts()`

---

## 2026-01-30 - Multi-Exchange TP Support & Display Improvements

### Fixed Issues

#### 1. Volume Calculation (NaN Display)

**Problem**: OKX positions showed "Volume: NaN USDT"

- **Root Cause**: Incorrect volume calculation in `telegram.service.ts` using `pos.margin * pos.leverage`
- **Solution**:
  - Updated `okx.service.ts` line ~184: Changed from `margin * quantity` to `quantity * entryPrice` (correct notional value)
  - Updated `telegram.service.ts` to use `pos.volume` from service instead of recalculating
- **Files Modified**:
  - `src/okx/okx.service.ts`
  - `src/telegram/telegram.service.ts` (lines ~679 and ~745)

#### 2. Profit Color Indicators

**Problem**: All positions showed red circle (🔴) regardless of profit/loss

- **Solution**: Added dynamic emoji based on profit:
  - Green circle (🟢) for positive profit (`pos.unrealizedPnl > 0`)
  - Red circle (🔴) for negative profit (`pos.unrealizedPnl <= 0`)
- **Files Modified**: `src/telegram/telegram.service.ts` (both Binance and OKX sections)

#### 3. TP/SL Not Displayed

**Problem**: OKX positions showed TP/SL as `--`

- **Root Cause**: TP/SL fetching was disabled in `okx.service.ts` (hardcoded to `null`)
- **Solution**:
  - Enabled algo orders fetching from OKX API endpoint `/api/v5/trade/orders-algo-pending`
  - Extract `tpOrdPx` and `slOrdPx` from conditional orders
  - Added error handling for API failures
- **Files Modified**: `src/okx/okx.service.ts` (lines ~195-217)

#### 4. Exchange-Specific TP Targets

**Problem**: TP system used single target for all exchanges (`user:{id}:tp`)

- **Impact**: Users couldn't set different TP targets for Binance vs OKX
- **Solution**: Updated Redis key pattern to `user:{id}:tp:{exchange}`
  - `/set-account` now sets TP for active exchange only
  - `/cleartp` clears TP for active exchange
  - Cron jobs updated to check each exchange independently
  - `/update` command now shows TP progress for active exchange
- **Files Modified**:
  - `src/telegram/telegram.service.ts`:
    - `handleSetAccount()` - Store exchange-specific TP
    - `handleClearTakeProfit()` - Clear exchange-specific TP
    - `checkTakeProfitTargets()` - Monitor per-exchange
    - `sendPeriodicUpdates()` - Send per-exchange updates
    - `handleManualUpdate()` - Show active exchange only
  - `.claude/skills/redis-data-patterns/SKILL.md` - Updated documentation

### Technical Details

#### OKX Algo Orders API

- Endpoint: `/api/v5/trade/orders-algo-pending`
- Parameters:
  - `instType: "SWAP"`
  - `instId: {symbol}` (e.g., "ETH-USDT-SWAP")
  - `ordType: "conditional"`
- Response fields:
  - `tpOrdPx`: Take profit trigger price
  - `slOrdPx`: Stop loss trigger price

#### Redis Key Migration

**Old Pattern**: `user:123456:tp`
**New Pattern**:

- `user:123456:tp:binance`
- `user:123456:tp:okx`

**Migration Notes**: No automatic migration implemented. Users need to reset their TP targets using `/set-account` command.

### Testing Checklist

- [x] Volume displays correct notional value (quantity × entry price)
- [x] Green/red indicators match profit direction
- [x] OKX TP/SL fetched from algo orders
- [x] Set TP on Binance, switch to OKX, set different TP
- [x] Clear TP on one exchange doesn't affect other
- [x] Cron jobs monitor each exchange independently
- [x] Manual update shows only active exchange

### Breaking Changes

⚠️ **TP Target Storage**: Existing TP targets stored in `user:{id}:tp` will not be read by the new system. Users must:

1. Note their current TP settings
2. Clear old TP: `/cleartp`
3. Switch to desired exchange: `/switch [binance|okx]`
4. Reset TP: `/set-account [percentage] [initial_balance]`

### Future Enhancements

- [ ] Migration script to convert old TP format to new format
- [ ] Support for position-specific TP/SL (not account-wide)
- [ ] Trailing stop loss implementation
- [ ] TP/SL order placement directly through bot
