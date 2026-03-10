import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { TelegramBotService } from "../telegram/telegram.service";
import { CoinFilterService } from "../coin-filter/coin-filter.service";
import { AiOptimizerService } from "../strategy/ai-optimizer/ai-optimizer.service";
import { RuleEngineService } from "../strategy/rules/rule-engine.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";
import { SignalQueueService } from "./signal-queue.service";
import {
  PositionMonitorService,
  ResolvedSignalInfo,
} from "./position-monitor.service";
import { UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import {
  AiCoinProfile,
  AiCoinProfileDocument,
} from "../schemas/ai-coin-profile.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { UserRealTradingService } from "./user-real-trading.service";
import { MarketDataService } from "../market-data/market-data.service";

const AI_PAUSED_KEY = "cache:ai:paused";
const AI_TEST_MODE_KEY = "cache:ai:test-mode";
const AI_SCANNING_KEY = "cache:ai:scanning";
const AI_MARKET_COOLDOWN_KEY = "cache:ai:market-cooldown"; // market-wide pause after consecutive SLs
const AI_SL_COUNTER_KEY = "cache:ai:sl-hits"; // rolling SL hit counter (1h window)
const MARKET_COOLDOWN_DURATION = 30 * 60; // 30 min cooldown after too many SLs
const MAX_SL_BEFORE_COOLDOWN = 3; // trigger cooldown after 3 SL hits in 1 hour
const AI_LAST_REGIME_KEY = "cache:ai:last-regime-for-reversal"; // track regime for reversal detection
const AI_PENDING_REVERSAL_KEY = "cache:ai:pending-regime-reversal"; // 15-min cooldown before acting
const REGIME_REVERSAL_COOLDOWN_SEC = 15 * 60; // 15 minutes confirmation window
const MAX_ACTIVE_SIGNALS = 15; // Cap concurrent positions to reduce correlated risk

/** Coins that run BOTH INTRADAY (15m) and SWING (4h) strategies simultaneously.
 * Top 5 by market cap — 15m catches more frequent signals than 4h alone. */
const DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

@Injectable()
export class AiSignalService implements OnModuleInit {
  private readonly logger = new Logger(AiSignalService.name);

  // Track coins being processed in current scan to prevent race conditions
  private readonly processingCoins = new Set<string>();

  // Whether test mode is enabled at startup (can be toggled at runtime)
  private readonly defaultTestMode: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
    private readonly coinFilterService: CoinFilterService,
    private readonly aiOptimizerService: AiOptimizerService,
    private readonly ruleEngineService: RuleEngineService,
    private readonly indicatorService: IndicatorService,
    private readonly signalQueueService: SignalQueueService,
    private readonly positionMonitorService: PositionMonitorService,
    private readonly subscriptionService: UserSignalSubscriptionService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly userRealTradingService: UserRealTradingService,
    private readonly marketDataService: MarketDataService,
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiCoinProfile.name)
    private readonly aiCoinProfileModel: Model<AiCoinProfileDocument>,
  ) {
    this.defaultTestMode =
      configService.get("AI_TEST_MODE", "false") === "true";
  }

  async onModuleInit() {
    this.logger.log(
      "[AiSignal] Module init — starting initial shortlist scan...",
    );

    // Set initial test mode from env
    if (this.defaultTestMode) {
      await this.redisService.set(AI_TEST_MODE_KEY, true);
      this.logger.log(
        "[AiSignal] Starting in TEST MODE — no real trades will be placed",
      );
    }

    // Register callback so PositionMonitorService can trigger notifications
    // after a real-time TP/SL resolution (avoids circular dependency).
    this.positionMonitorService.setResolveCallback(async (info) => {
      // Use profile-aware key for cooldown on dual-timeframe coins
      const signalKey = info.signalKey || info.symbol;
      await this.redisService.set(`cache:ai:cooldown:${signalKey}`, true, 30 * 60);

      // Track SL hits for market-wide cooldown
      if (info.closeReason === "STOP_LOSS") {
        await this.trackSlHitAndMaybeCooldown();
      }

      // Record result for GPT context (recent performance awareness)
      await this.aiOptimizerService.recordTradeResult({
        symbol: info.symbol,
        direction: info.direction,
        strategy: "", // not available in ResolvedSignalInfo
        pnlPercent: info.pnlPercent,
        closeReason: info.closeReason,
      }).catch(() => {});

      await this.notifyPositionClosed(info).catch(() => {});

      if (info.queuedSignalActivated) {
        const newActive = await this.signalQueueService.getActiveSignal(
          signalKey,
        );
        if (newActive) {
          await this.broadcastSignal(newActive);
          await this.notifyQueueActivated(newActive, info);
        }
      }

      await this.updateCoinProfile(info).catch(() => {});
    });

    // Register callback for SL-moved-to-entry notifications
    this.positionMonitorService.setSlMovedCallback(async (symbol, entryPrice) => {
      await this.notifySlMovedToEntry(symbol, entryPrice);
    });

    // Register callback for TP boost on momentum
    this.positionMonitorService.setTpBoostedCallback(async (symbol, newTp, newTpPct, direction) => {
      await this.notifyTpBoosted(symbol, newTp, newTpPct, direction);
    });

    // Cleanup orphaned actives + duplicate completed signals on startup
    try {
      const orphans = await this.signalQueueService.cleanupOrphanedActives();
      if (orphans > 0) this.logger.warn(`[AiSignal] Startup: cancelled ${orphans} orphaned ACTIVE signals`);

      const dups = await this.signalQueueService.cleanupDuplicateCompletedSignals();
      if (dups > 0) this.logger.warn(`[AiSignal] Startup: cleaned ${dups} duplicate COMPLETED signals`);
    } catch (err) {
      this.logger.error(`[AiSignal] Startup cleanup error: ${err?.message}`);
    }

    try {
      await this.coinFilterService.scanAndFilter();
      // Flush stale coin param caches on startup so any config changes take effect immediately
      await this.aiOptimizerService.flushParamCaches();
      await this.aiOptimizerService.assessGlobalRegime();
    } catch (err) {
      this.logger.error(`[AiSignal] onModuleInit error: ${err?.message}`);
    }

  }

  // ─── Cron: refresh shortlist (every 5 minutes) ────────────────────────────

  @Cron("*/5 * * * *")
  async refreshCoinFilter() {
    try {
      await this.coinFilterService.scanAndFilter();
    } catch (err) {
      this.logger.error(`[AiSignal] refreshCoinFilter error: ${err?.message}`);
    }
  }

  // ─── Cron: assess global regime (every 4 hours) ───────────────────────────

  @Cron("0 */4 * * *")
  async refreshGlobalRegime() {
    try {
      await this.redisService.delete("cache:ai:regime");
      await this.aiOptimizerService.assessGlobalRegime();
    } catch (err) {
      this.logger.error(
        `[AiSignal] refreshGlobalRegime error: ${err?.message}`,
      );
    }
  }

  // ─── Cron: main signal scan (every 30 seconds) ────────────────────────────

  @Cron("*/30 * * * * *")
  async runSignalScan() {
    const paused = await this.redisService.get<boolean>(AI_PAUSED_KEY);
    if (paused) return;

    // Market-wide cooldown: skip new signals when too many SLs hit recently
    const marketCooldown = await this.redisService.get<boolean>(AI_MARKET_COOLDOWN_KEY);
    if (marketCooldown) return;

    // Prevent overlapping scans (100 coins in batches of 5 can take >30s)
    const scanning = await this.redisService.get<boolean>(AI_SCANNING_KEY);
    if (scanning) return;

    await this.redisService.set(AI_SCANNING_KEY, true, 300); // 5 min safety TTL
    try {
      const shortlist = await this.coinFilterService.getShortlist();
      if (shortlist.length === 0) return;

      const globalRegime = await this.aiOptimizerService.assessGlobalRegime();

      // ── Regime reversal: close counter-regime positions ──────────────────
      await this.handleRegimeReversal(globalRegime);

      // ── Extreme move filter: skip coins with >30% 24h price change ──────
      // After a 30%+ dump/pump the move is done, high risk of reversal/dead cat bounce.
      const EXTREME_MOVE_PCT = 30;
      const filtered = shortlist.filter((entry) => {
        if (Math.abs(entry.priceChangePercent) > EXTREME_MOVE_PCT) {
          this.logger.log(
            `[AiSignal] ${entry.coin.toUpperCase()} skipped — extreme 24h move (${entry.priceChangePercent > 0 ? "+" : ""}${entry.priceChangePercent.toFixed(1)}%)`,
          );
          return false;
        }
        return true;
      });

      // Build work items: BTC/ETH get TWO entries (INTRADAY + SWING), all others use SWING (4h)
      const workItems: { coin: string; currency: string; forceProfile?: string }[] = [];
      for (const entry of filtered) {
        const coinUpper = entry.coin.toUpperCase();
        if (DUAL_TIMEFRAME_COINS.includes(coinUpper)) {
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "INTRADAY" });
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "SWING" });
        } else {
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "SWING" });
        }
      }

      // Process in batches of 10 to reduce total blocking time
      const BATCH_SIZE = 10;
      for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
        const batch = workItems.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map((item) =>
            this.processCoin(item.coin, item.currency, globalRegime, item.forceProfile).catch(
              (err) =>
                this.logger.warn(
                  `[AiSignal] processCoin ${item.coin.toUpperCase()}${item.currency.toUpperCase()}${item.forceProfile ? `:${item.forceProfile}` : ""} failed: ${err?.message}`,
                ),
            ),
          ),
        );
        // Yield to event loop so Telegram commands don't hang during long scans
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      this.logger.error(`[AiSignal] runSignalScan error: ${err?.message}`);
    } finally {
      await this.redisService.delete(AI_SCANNING_KEY);
    }
  }

  // ─── Cron: monitor open positions (every 30 seconds) ─────────────────────

  @Cron("*/30 * * * * *")
  async monitorActiveSignals() {
    // Skip position monitoring in test mode (no real positions exist)
    const isTestMode = await this.isTestModeEnabled();
    if (isTestMode) return;

    try {
      const resolved = await this.positionMonitorService.checkAndResolve();

      for (const info of resolved) {
        // Use profile-aware key for cooldown on dual-timeframe coins
        const signalKey = info.signalKey || info.symbol;
        // Cooldown to prevent ping-pong recreation (30 min)
        await this.redisService.set(`cache:ai:cooldown:${signalKey}`, true, 30 * 60);

        // Track SL hits for market-wide cooldown
        if (info.closeReason === "STOP_LOSS") {
          await this.trackSlHitAndMaybeCooldown();
        }

        // Record result for GPT context
        await this.aiOptimizerService.recordTradeResult({
          symbol: info.symbol,
          direction: info.direction,
          strategy: "",
          pnlPercent: info.pnlPercent,
          closeReason: info.closeReason,
        }).catch(() => {});

        await this.notifyPositionClosed(info).catch(() => {});

        if (info.queuedSignalActivated) {
          const newActive = await this.signalQueueService.getActiveSignal(
            signalKey,
          );
          if (newActive) {
            await this.broadcastSignal(newActive);
            await this.notifyQueueActivated(newActive, info);
          }
        }

        await this.updateCoinProfile(info).catch(() => {});
      }
    } catch (err) {
      this.logger.error(
        `[AiSignal] monitorActiveSignals error: ${err?.message}`,
      );
    }
  }

  // ─── Cron: test-mode simulation check (every 30 seconds) ─────────────────
  // In test mode, simulate TP/SL by checking current price against signal entry

  private testSimRunning = false;

  @Cron("*/30 * * * * *")
  async runTestModeSimulation() {
    const isTestMode = await this.isTestModeEnabled();
    if (!isTestMode) return;
    if (this.testSimRunning) return; // prevent overlap

    this.testSimRunning = true;
    try {
      const actives = await this.signalQueueService.getAllActiveSignals();
      for (const signal of actives) {
        if (!signal.isTestMode) continue;
        await this.checkTestModeSignal(signal).catch(() => {});
      }
    } catch (err) {
      this.logger.error(`[AiSignal] testModeSimulation error: ${err?.message}`);
    } finally {
      this.testSimRunning = false;
    }
  }

  // ─── Cron: cleanup expired QUEUED + auto-close old ACTIVE signals ────────

  @Cron("*/5 * * * *")
  async cleanupExpiredSignals() {
    try {
      // 1. Clean expired QUEUED signals
      const { count } = await this.signalQueueService.cleanupExpiredQueued();
      if (count > 0) {
        this.logger.log(
          `[AiSignal] Cleaned up ${count} expired QUEUED signal(s)`,
        );
      }

      // 2. Time-based stop: close signals not performing after 8h
      // AND auto-close profitable signals after 48h
      const isTestMode = await this.isTestModeEnabled();
      const allActives = await this.signalQueueService.getAllActiveSignals();

      for (const signal of allActives) {
        try {
          const currentPrice = await this.marketDataService.getPrice(signal.symbol);
          if (!currentPrice) continue;

          const pnlPercent =
            signal.direction === "LONG"
              ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

          // Use executedAt (activation time) if available, fallback to createdAt
          const ageRef = (signal as any).executedAt ?? (signal as any).createdAt;
          const ageMs = Date.now() - new Date(ageRef).getTime();
          const ageH = ageMs / 3600000;

          // Time-based stop: regime-aware — close stagnant signals (PnL between -1% and +1%)
          // Trending markets should move fast; ranging markets need more time to oscillate.
          const regime = (signal as any).regime ?? "MIXED";
          const TIME_STOP_BY_REGIME: Record<string, number> = {
            STRONG_BULL: 12, STRONG_BEAR: 12,     // trend should move fast
            RANGE_BOUND: 24, SIDEWAYS: 24,         // mean-reversion takes time
            VOLATILE: 16, MIXED: 16,               // uncertain — moderate
            BTC_CORRELATION: 16,
          };
          const timeStopH = TIME_STOP_BY_REGIME[regime] ?? 16;
          if (ageH >= timeStopH && pnlPercent < 1 && pnlPercent > -1) {
            const reason = `Time-stop ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}% after ${ageH.toFixed(0)}h`;
            try {
              await this.signalQueueService.closeActiveSignalWithPnl(
                signal, currentPrice, reason,
              );
              this.logger.log(`[AiSignal] ${reason} — ${signal.symbol}`);
              if (!isTestMode) {
                const subscribers = await this.subscriptionService.findRealModeSubscribers();
                for (const sub of subscribers) {
                  await this.userRealTradingService.closeRealPosition(
                    sub.telegramId, sub.chatId, signal.symbol, reason,
                  ).catch(() => {});
                }
              }
            } finally {
              this.positionMonitorService.unregisterListener(signal);
            }
            continue;
          }

          // 48h+ and profitable >= 1% → close with descriptive reason
          // SKIP if already close to TP (≥70% of the way) — let price action finish it
          if (ageH >= 48 && pnlPercent >= 1) {
            const tpPct = (signal as any).takeProfitPercent ?? 5;
            if (pnlPercent >= tpPct * 0.7) {
              this.logger.debug(
                `[AiSignal] ${signal.symbol} 48h skip — ${pnlPercent.toFixed(1)}% ≥ 70% of TP (${tpPct}%), letting it ride`,
              );
              continue;
            }
            const reason = `Auto-closed +${pnlPercent.toFixed(2)}% after ${ageH.toFixed(0)}h`;
            try {
              await this.signalQueueService.closeActiveSignalWithPnl(
                signal, currentPrice, reason,
              );
              this.logger.log(`[AiSignal] ${reason} — ${signal.symbol}`);
              if (!isTestMode) {
                const subscribers = await this.subscriptionService.findRealModeSubscribers();
                for (const sub of subscribers) {
                  await this.userRealTradingService.closeRealPosition(
                    sub.telegramId, sub.chatId, signal.symbol, reason,
                  ).catch(() => {});
                }
              }
            } finally {
              this.positionMonitorService.unregisterListener(signal);
            }
          }
        } catch (err) {
          this.logger.error(
            `[AiSignal] Auto-close check failed for ${signal.symbol}: ${err?.message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `[AiSignal] cleanupExpiredSignals error: ${err?.message}`,
      );
    }
  }

  // ─── Core: process a single coin ─────────────────────────────────────────

  private async processCoin(
    coin: string,
    currency: string,
    globalRegime: string,
    forceProfile?: string,
  ): Promise<void> {
    // Early exit: skip coins that already have an active signal (saves compute + avoids SKIPPED spam)
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const coinUpper = coin.toUpperCase();
    const isDual = DUAL_TIMEFRAME_COINS.includes(coinUpper);

    // For dual-timeframe coins, use profile-aware lock key
    const lockKey = isDual && forceProfile ? `${symbol}:${forceProfile}` : symbol;

    // In-memory lock to prevent same coin+profile being processed concurrently
    if (this.processingCoins.has(lockKey)) return;
    this.processingCoins.add(lockKey);

    try {
    // For dual coins, check active signal using profile-aware key
    const signalKey = isDual && forceProfile ? `${symbol}:${forceProfile}` : symbol;
    const hasActive = await this.signalQueueService.getActiveSignal(signalKey);
    if (hasActive) return;

    // Cap total active signals to reduce correlated risk
    const allActives = await this.signalQueueService.getAllActiveSignals();
    if (allActives.length >= MAX_ACTIVE_SIGNALS) return;

    // For dual-timeframe coins: also check if the OTHER profile already has an active signal
    // This prevents duplicate signals for the same symbol (e.g. ETH INTRADAY + SWING both SHORT)
    if (isDual && forceProfile) {
      const otherProfile = forceProfile === "INTRADAY" ? "SWING" : "INTRADAY";
      const otherActive = await this.signalQueueService.getActiveSignal(`${symbol}:${otherProfile}`);
      if (otherActive) return;
    }

    // Cooldown after SL/TP — prevent ping-pong recreation
    const cooldown = await this.redisService.get<boolean>(`cache:ai:cooldown:${signalKey}`);
    if (cooldown) return;

    const params = await this.aiOptimizerService.tuneParamsForSymbol(
      coin,
      currency,
      globalRegime,
      forceProfile,
    );

    // Adjust confidence using cached futures analytics (no extra API calls)
    // Now DIRECTIONAL: funding/L-S/taker data boosts confidence when aligned with signal direction
    const cachedAnalytics = await this.futuresAnalyticsService.getCachedAnalytics();
    const fa = cachedAnalytics.get(symbol);
    if (fa) {
      // We'll apply confidence adjustments after signal direction is known (below)
    }

    // Confidence floor: DB shows confidence < 65 → win rate < 44%. Enforce minimum 63.
    const CONFIDENCE_FLOOR = 63;
    params.minConfidenceToTrade = Math.max(params.minConfidenceToTrade ?? 0, CONFIDENCE_FLOOR);
    // Cap per regime — prevent AI from setting unrealistically high thresholds
    const regimeThresholdCap: Record<string, number> = {
      SIDEWAYS: 68,
      RANGE_BOUND: 68,
      MIXED: 68,
      VOLATILE: 70,
      BTC_CORRELATION: 68,
      STRONG_BULL: 72,
      STRONG_BEAR: 72,
    };
    const cap = regimeThresholdCap[params.regime] ?? 68;
    if (params.minConfidenceToTrade > cap) {
      params.minConfidenceToTrade = cap;
    }

    const signalResult = await this.ruleEngineService.evaluate(
      coin,
      currency,
      params,
    );
    if (!signalResult) return;

    // ── Directional confidence adjustment using futures data ──────────────
    // Boost confidence when futures data aligns with signal direction, penalize when against.
    if (fa) {
      let adj = 0;
      const isLong = signalResult.isLong;

      // Funding: positive funding = longs paying → bearish for longs, bullish for shorts
      if (fa.fundingRate > 0.001) adj += isLong ? -8 : 8;
      else if (fa.fundingRate < -0.001) adj += isLong ? 8 : -8;
      else if (Math.abs(fa.fundingRate) < 0.0003) adj += 3; // neutral funding = stable

      // L/S ratio: crowded longs → bearish for longs
      if (fa.longShortRatio > 2.0) adj += isLong ? -10 : 10;
      else if (fa.longShortRatio < 0.5) adj += isLong ? 10 : -10;

      // Taker momentum: sell pressure → bearish for longs
      if (fa.takerBuyRatio < 0.7) adj += isLong ? -5 : 5;
      else if (fa.takerBuyRatio > 1.3) adj += isLong ? 5 : -5;

      if (adj !== 0) {
        params.confidence = Math.max(10, Math.min(95, params.confidence + adj));
        this.logger.debug(
          `[AiSignal] ${coin.toUpperCase()} confidence ${adj > 0 ? "+" : ""}${adj} from futures data (now ${params.confidence})`,
        );
      }
    }

    // ── Main confidence gate: block weak signals (after futures adjustment) ──
    if (params.confidence < params.minConfidenceToTrade) {
      this.logger.debug(
        `[AiSignal] ${coin.toUpperCase()} ${signalResult.isLong ? "LONG" : "SHORT"} blocked — confidence ${params.confidence} < min ${params.minConfidenceToTrade} (${params.regime})`,
      );
      return;
    }

    // ── TREND_EMA: worst performer (avg -2.28% SL, 4/6 full SL) — require confidence 70+ ──
    const strategyName = signalResult.strategy;
    if (strategyName === "TREND_EMA" && params.confidence < 70) {
      this.logger.debug(
        `[AiSignal] ${coin.toUpperCase()} TREND_EMA blocked — confidence ${params.confidence} < 70 (strategy-specific gate)`,
      );
      return;
    }

    // ── Global regime trend filter (uses indicator-based globalRegime, not AI params.regime) ──
    // STRONG_BEAR: only SHORT signals (unless futures sentiment is strongly bullish).
    // STRONG_BULL: only LONG signals (unless futures sentiment is strongly bearish).
    // Futures sentiment override threshold: |score| >= 30 = allow counter-regime signals.
    const SENTIMENT_OVERRIDE_THRESHOLD = 30;
    const sentiment = await this.futuresAnalyticsService.calculateSentiment(symbol);

    if (globalRegime === "STRONG_BEAR" && signalResult.isLong) {
      if (sentiment && sentiment.score >= SENTIMENT_OVERRIDE_THRESHOLD) {
        this.logger.log(
          `[AiSignal] ${coin.toUpperCase()} LONG allowed in STRONG_BEAR — futures sentiment bullish (${sentiment.score}): ${sentiment.signals.join("; ")}`,
        );
      } else {
        this.logger.log(
          `[AiSignal] ${coin.toUpperCase()} LONG skipped — regime STRONG_BEAR (shorts only)${sentiment ? ` [sentiment=${sentiment.score}]` : ""}`,
        );
        return;
      }
    }
    if (globalRegime === "STRONG_BULL" && !signalResult.isLong) {
      if (sentiment && sentiment.score <= -SENTIMENT_OVERRIDE_THRESHOLD) {
        this.logger.log(
          `[AiSignal] ${coin.toUpperCase()} SHORT allowed in STRONG_BULL — futures sentiment bearish (${sentiment.score}): ${sentiment.signals.join("; ")}`,
        );
      } else {
        this.logger.log(
          `[AiSignal] ${coin.toUpperCase()} SHORT skipped — regime STRONG_BULL (longs only)${sentiment ? ` [sentiment=${sentiment.score}]` : ""}`,
        );
        return;
      }
    }

    // ── VOLATILE regime: block signals against BTC direction ──────────────
    // In volatile markets, only trade in BTC's direction (crash = SHORT only, pump = LONG only)
    if (globalRegime === "VOLATILE") {
      const btcCtx = await this.redisService.get<{ rsi: number; priceVsEma9: number }>("cache:ai:regime:btc-context");
      if (btcCtx) {
        // BTC below EMA9 + low RSI = bearish volatile → block LONGs
        if (btcCtx.priceVsEma9 < -0.5 && btcCtx.rsi < 45 && signalResult.isLong) {
          this.logger.log(
            `[AiSignal] ${coin.toUpperCase()} LONG skipped — VOLATILE + BTC bearish (RSI=${btcCtx.rsi.toFixed(0)}, vs EMA9=${btcCtx.priceVsEma9.toFixed(1)}%)`,
          );
          return;
        }
        // BTC above EMA9 + high RSI = bullish volatile → block SHORTs
        if (btcCtx.priceVsEma9 > 0.5 && btcCtx.rsi > 55 && !signalResult.isLong) {
          this.logger.log(
            `[AiSignal] ${coin.toUpperCase()} SHORT skipped — VOLATILE + BTC bullish (RSI=${btcCtx.rsi.toFixed(0)}, vs EMA9=${btcCtx.priceVsEma9.toFixed(1)}%)`,
          );
          return;
        }
      }
    }

    // ── MIXED regime: block SHORT when BTC RSI is bullish (>65) ────────────
    // BTC RSI > 65 = bullish momentum. Shorting alts when BTC is pumping = high risk of losses.
    if (globalRegime === "MIXED" && !signalResult.isLong) {
      const btcCtx = await this.redisService.get<{ rsi: number; priceVsEma9: number }>("cache:ai:regime:btc-context");
      if (btcCtx && btcCtx.rsi > 65) {
        this.logger.log(
          `[AiSignal] ${signalKey} SHORT blocked — MIXED + BTC RSI overbought (${btcCtx.rsi.toFixed(0)})`,
        );
        return;
      }
    }

    // ── LONG confidence penalty: only in STRONG_BEAR (historically LONGs lose in bear markets)
    // In MIXED/RANGE_BOUND/SIDEWAYS: let GPT-4o validation gate decide instead of hardcoded penalty
    if (signalResult.isLong && globalRegime === "STRONG_BEAR") {
      const penalty = 20;
      params.confidence = Math.max(10, params.confidence - penalty);
      this.logger.debug(
        `[AiSignal] ${coin.toUpperCase()} LONG confidence penalty -${penalty} in ${globalRegime} (now ${params.confidence})`,
      );
      // Re-check confidence threshold after penalty
      if (params.confidence < (params.minConfidenceToTrade || 40)) {
        this.logger.log(
          `[AiSignal] ${coin.toUpperCase()} LONG blocked — confidence ${params.confidence} < threshold ${params.minConfidenceToTrade} after penalty`,
        );
        return;
      }
    }

    // ── Recent SL direction bias: block direction that keeps losing ─────────
    // If 3+ of last 5 SLs are in one direction, block that direction temporarily
    const recentPerf = await this.redisService.get<any[]>("cache:ai:recent-perf") || [];
    const recentSLs = recentPerf.filter((p) => p.closeReason === "STOP_LOSS").slice(-5);
    if (recentSLs.length >= 3) {
      const longSLs = recentSLs.filter((p) => p.direction === "LONG").length;
      const shortSLs = recentSLs.filter((p) => p.direction === "SHORT").length;
      if (longSLs >= 3 && signalResult.isLong) {
        this.logger.log(`[AiSignal] ${coin.toUpperCase()} LONG blocked — ${longSLs}/${recentSLs.length} recent SLs are LONGs`);
        return;
      }
      if (shortSLs >= 3 && !signalResult.isLong) {
        this.logger.log(`[AiSignal] ${coin.toUpperCase()} SHORT blocked — ${shortSLs}/${recentSLs.length} recent SLs are SHORTs`);
        return;
      }
    }

    // ── Per-coin 4h EMA trend alignment ─────────────────────────────────────
    // Block signals that go against the coin's own 4h trend, regardless of global regime.
    // Neutral zone (spread below threshold) = no clear trend → both directions allowed.
    // Regime-aware: ranging markets use 2.0% (small trends are noise), trending uses 1.0%.
    // Confluence signals (2+ strategies confirmed) get a higher threshold — multi-TA agreement
    // is strong enough to trade against mild 4h trends.
    const isConfluenceSignal = signalResult.strategy.includes("+");
    try {
      const htf4hCloses = await this.indicatorService.getCloses(coin, "4h");
      if (htf4hCloses.length >= 55) {
        const ema21 = this.indicatorService.getEma(htf4hCloses, 21);
        const ema50 = this.indicatorService.getEma(htf4hCloses, 50);
        const spreadPct = (Math.abs(ema21.last - ema50.last) / ema50.last) * 100;

        const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
        // Confluence signals get 50% higher threshold (e.g. 3% instead of 2% for ranging)
        const baseThreshold = isRanging ? 2.0 : 1.0;
        const trendSpreadThreshold = isConfluenceSignal ? baseThreshold * 1.5 : baseThreshold;

        if (spreadPct > trendSpreadThreshold) {
          const coinTrendUp = ema21.last > ema50.last;
          if (signalResult.isLong && !coinTrendUp) {
            this.logger.log(
              `[AiSignal] ${signalKey} LONG blocked — 4h downtrend (EMA21 < EMA50, spread=${spreadPct.toFixed(2)}%${isConfluenceSignal ? ", confluence threshold=" + trendSpreadThreshold.toFixed(1) + "%" : ""})`,
            );
            return;
          }
          if (!signalResult.isLong && coinTrendUp) {
            // Allow SHORT against 4h uptrend if futures sentiment is strongly bearish
            if (sentiment && sentiment.score <= -SENTIMENT_OVERRIDE_THRESHOLD) {
              this.logger.log(
                `[AiSignal] ${signalKey} SHORT allowed against 4h uptrend — futures sentiment bearish (${sentiment.score})`,
              );
            } else {
              this.logger.log(
                `[AiSignal] ${signalKey} SHORT blocked — 4h uptrend (EMA21 > EMA50, spread=${spreadPct.toFixed(2)}%)${sentiment ? ` [sentiment=${sentiment.score}]` : ""}`,
              );
              return;
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[AiSignal] Trend filter error for ${signalKey}: ${err?.message}`);
    }

    // AI validation gate — lightweight GPT check to filter low-quality signals
    const validationCooldownKey = `cache:ai:validation-cooldown:${signalKey}`;
    try {
      // Check cooldown — skip validation (and signal) if recently rejected
      const cooldown = await this.redisService.get<boolean>(validationCooldownKey);
      if (cooldown) {
        return; // silently skip — coin is on cooldown from recent rejection
      }

      const validation = await this.aiOptimizerService.validateSignal({
        symbol: `${coin.toUpperCase()}${currency.toUpperCase()}`,
        direction: signalResult.isLong ? "LONG" : "SHORT",
        strategy: signalResult.strategy,
        confidence: params.confidence ?? 0,
        regime: params.regime,
        indicators: params as any,
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
      });
      if (!validation.approved) {
        // Set 30-minute cooldown for this coin
        await this.redisService.set(validationCooldownKey, true, 30 * 60);
        this.logger.log(
          `[AiSignal] ${signalKey} REJECTED by AI gate (30min cooldown): ${validation.reason}`,
        );
        return;
      }
    } catch (err) {
      // On error, block signal (fail-closed — all signals must be validated)
      this.logger.warn(`[AiSignal] AI validation gate error for ${signalKey}: ${err?.message} — BLOCKED`);
      return;
    }

    // ── Daily signal cap: atomic check+increment to prevent over-trading ──
    const MAX_DAILY_SIGNALS = 18;
    const dailyCountKey = "cache:ai:daily-signal-count";
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    midnight.setUTCHours(0, 0, 0, 0);
    const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
    const newDailyCount = await this.redisService.initAndIncr(dailyCountKey, 0, ttl);
    if (newDailyCount > MAX_DAILY_SIGNALS) {
      await this.redisService.decr(dailyCountKey); // rollback
      this.logger.debug(`[AiSignal] Daily signal cap reached (${MAX_DAILY_SIGNALS}) — skipping ${coin.toUpperCase()}`);
      return;
    }

    const isTestMode = await this.isTestModeEnabled();

    this.logger.log(
      `[AiSignal]${isTestMode ? " [TEST]" : ""} Signal: ${coin.toUpperCase()}${currency.toUpperCase()} ${signalResult.isLong ? "LONG" : "SHORT"} (${signalResult.strategy}) — ${signalResult.reason}`,
    );

    const queueResult = await this.signalQueueService.handleNewSignal(
      coin,
      currency,
      signalResult,
      params,
      params.regime,
      isTestMode,
      forceProfile,
    );

    if (queueResult.action === "EXECUTED") {
      let activeSignal =
        await this.signalQueueService.getActiveSignal(signalKey);
      if (activeSignal) {
        // Refresh entry price to current market price (candle close can be stale)
        const livePrice = this.marketDataService.getLatestPrice(activeSignal.symbol);
        if (livePrice && livePrice > 0) {
          activeSignal = await this.signalQueueService.refreshEntryPrice(activeSignal, livePrice);
        }

        if (isTestMode) {
          // Test mode: send "[TEST]" notification instead of placing real trades
          await this.notifySignalTestMode(activeSignal);
        } else {
          // Live mode: place real trades + send AI-enriched notification
          await this.broadcastSignal(activeSignal);
        }
        await this.notifySignalActive(activeSignal, params, isTestMode);

        // Trigger real order placement for users with real mode enabled (runs independently of test mode)
        this.userRealTradingService.onSignalActivated(activeSignal, params).catch((err) =>
          this.logger.error(`[AiSignal] Real trading error: ${err?.message}`),
        );
      }
    } else if (queueResult.action === "QUEUED") {
      const queuedSignal =
        await this.signalQueueService.getQueuedSignal(signalKey);
      if (queuedSignal) {
        await this.notifySignalQueued(queuedSignal, isTestMode);
      }
    }
    // If signal was SKIPPED by queue (already active), rollback the daily count
    if (queueResult.action === "SKIPPED") {
      await this.redisService.decr(dailyCountKey).catch(() => {});
    }
    // EXECUTED/QUEUED — daily count already incremented above
    } finally {
      this.processingCoins.delete(lockKey);
    }
  }

  // ─── Market-wide SL cooldown ─────────────────────────────────────────────

  /**
   * Track a stop loss hit. If too many SLs fire within 1 hour,
   * activate a market-wide cooldown to let the market stabilize.
   * Prevents the bot from opening new positions into a crash.
   */
  private async trackSlHitAndMaybeCooldown(): Promise<void> {
    // Increment rolling SL counter (1h window)
    const current = ((await this.redisService.get<number>(AI_SL_COUNTER_KEY)) || 0) + 1;
    await this.redisService.set(AI_SL_COUNTER_KEY, current, 60 * 60); // 1h TTL

    this.logger.log(`[AiSignal] SL hit #${current}/${MAX_SL_BEFORE_COOLDOWN} in rolling 1h window`);

    if (current >= MAX_SL_BEFORE_COOLDOWN) {
      await this.redisService.set(AI_MARKET_COOLDOWN_KEY, true, MARKET_COOLDOWN_DURATION);
      // Reset counter so cooldown doesn't re-trigger immediately after expiry
      await this.redisService.delete(AI_SL_COUNTER_KEY);

      // Force regime reassessment — market conditions have changed
      await this.redisService.delete("cache:ai:regime");

      this.logger.warn(
        `[AiSignal] ⚠️ Market cooldown activated — ${current} SL hits in 1h. Pausing new signals for ${MARKET_COOLDOWN_DURATION / 60} min.`,
      );

      // Notify subscribers about cooldown
      const subscribers = await this.subscriptionService.findRealModeSubscribers();
      const cooldownMin = MARKET_COOLDOWN_DURATION / 60;
      const text =
        `⏸️ *Tạm Dừng Tín Hiệu*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${current} lệnh SL liên tiếp trong 1h.\n` +
        `Thị trường bất ổn — tạm dừng tín hiệu mới *${cooldownMin} phút* để thị trường ổn định.\n\n` +
        `Các lệnh đang mở vẫn được giám sát bình thường.\n\n` +
        `_Tự động mở lại sau ${cooldownMin} phút._`;

      for (const sub of subscribers) {
        await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
      }
    }
  }

  // ─── Regime reversal: auto-close positions going against the new regime ───

  /**
   * When regime shifts significantly (e.g. BEAR→BULL or BULL→BEAR),
   * close ACTIVE signals that go against the new regime direction.
   * Only triggers on major shifts, not every regime fluctuation.
   */
  private async handleRegimeReversal(currentRegime: string): Promise<void> {
    const lastRegime = await this.redisService.get<string>(AI_LAST_REGIME_KEY);
    await this.redisService.set(AI_LAST_REGIME_KEY, currentRegime, 24 * 60 * 60);

    if (!lastRegime || lastRegime === currentRegime) {
      // Regime stable — clear any pending reversal
      await this.redisService.delete(AI_PENDING_REVERSAL_KEY);
      return;
    }

    // Only act on significant regime shifts
    const bearRegimes = ["STRONG_BEAR"];
    const bullRegimes = ["STRONG_BULL"];
    const wasBear = bearRegimes.includes(lastRegime);
    const wasBull = bullRegimes.includes(lastRegime);
    const nowBear = bearRegimes.includes(currentRegime);
    const nowBull = bullRegimes.includes(currentRegime);

    let closeDirection: string | null = null;
    if (wasBear && !nowBear) closeDirection = "SHORT";
    if (wasBull && !nowBull) closeDirection = "LONG";

    if (!closeDirection) return;

    // ── Phase 1: Detect change → store pending reversal with 15-min cooldown ──
    const pending = await this.redisService.get<{ from: string; to: string; direction: string; detectedAt: number }>(AI_PENDING_REVERSAL_KEY);

    if (!pending) {
      // First detection — start cooldown, do NOT close yet
      await this.redisService.set(AI_PENDING_REVERSAL_KEY, {
        from: lastRegime,
        to: currentRegime,
        direction: closeDirection,
        detectedAt: Date.now(),
      }, REGIME_REVERSAL_COOLDOWN_SEC + 60); // TTL slightly longer than cooldown

      this.logger.log(
        `[AiSignal] ⏳ Regime shift detected: ${lastRegime} → ${currentRegime} — waiting 15min to confirm before closing ${closeDirection} positions`,
      );
      return;
    }

    // ── Phase 2: Check if 15 min have passed since detection ──
    const elapsed = Date.now() - pending.detectedAt;
    if (elapsed < REGIME_REVERSAL_COOLDOWN_SEC * 1000) {
      // Still in cooldown — log and wait
      const remainMin = ((REGIME_REVERSAL_COOLDOWN_SEC * 1000 - elapsed) / 60000).toFixed(1);
      this.logger.debug(
        `[AiSignal] ⏳ Regime reversal pending — ${remainMin}min remaining before confirmation`,
      );
      return;
    }

    // ── Phase 3: Confirmed — regime still changed after 15 min, execute closes ──
    await this.redisService.delete(AI_PENDING_REVERSAL_KEY);

    this.logger.log(
      `[AiSignal] ⚡ Regime reversal CONFIRMED after 15min: ${pending.from} → ${currentRegime} — closing ${closeDirection} positions`,
    );

    try {
      const activeSignals = await this.signalQueueService.getAllActiveSignals();
      const isTestMode = await this.isTestModeEnabled();
      let closedCount = 0;

      for (const signal of activeSignals) {
        if (signal.direction !== closeDirection) continue;
        // Skip positions with trailing SL locked in >= 2% profit (peak >= 4%)
        if ((signal as any).peakPnlPct >= 4) continue;

        const currentPrice = await this.marketDataService.getPrice(signal.symbol).catch(() => 0);
        if (!currentPrice) continue;

        const pnlPct = signal.direction === "LONG"
          ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
          : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

        // Close if losing or small profit (< +1.5%) — positions with good profit can ride
        if (pnlPct < 1.5) {
          const reason = `REGIME_REVERSAL (${pending.from}→${currentRegime})`;
          this.logger.log(
            `[AiSignal] ⚡ Closing ${signal.symbol} ${signal.direction} — PnL: ${pnlPct.toFixed(2)}% — ${reason}`,
          );

          // Use closeActiveSignalWithPnl for both modes — it uses docSignalKey()
          // which correctly handles dual-timeframe keys (e.g. BTCUSDT:INTRADAY)
          try {
            await this.signalQueueService.closeActiveSignalWithPnl(signal, currentPrice, reason);

            if (!isTestMode) {
              const subscribers = await this.subscriptionService.findRealModeSubscribers();
              for (const sub of subscribers) {
                await this.userRealTradingService.closeRealPosition(
                  sub.telegramId, sub.chatId, signal.symbol, reason,
                ).catch((err) =>
                  this.logger.warn(`[AiSignal] Failed to close real position for ${sub.telegramId}: ${err?.message}`),
                );
              }
            }

            await this.redisService.delete(`cache:ai:cooldown:${signal.symbol}`);
          } finally {
            // Always unregister listener to free resources, even if close fails
            this.positionMonitorService.unregisterListener(signal);
          }
          closedCount++;
        }
      }

      if (closedCount > 0) {
        this.logger.log(
          `[AiSignal] ⚡ Regime reversal closed ${closedCount} ${closeDirection} positions`,
        );

        const subscribers = await this.subscriptionService.findRealModeSubscribers();
        const text =
          `⚡ *Đảo Chiều Regime (xác nhận 15 phút)*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `${pending.from} → *${currentRegime}*\n\n` +
          `Đã đóng *${closedCount}* lệnh ${closeDirection} đang lỗ/hòa vốn.\n` +
          `Lệnh đang có lời (+1.5%+) hoặc đã khóa SL vẫn giữ.\n\n` +
          `_Bot sẽ tìm tín hiệu mới theo regime mới._`;

        for (const sub of subscribers) {
          await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
        }
      } else {
        this.logger.log(
          `[AiSignal] ⚡ Regime reversal confirmed but no positions to close`,
        );
      }
    } catch (err) {
      this.logger.error(`[AiSignal] handleRegimeReversal error: ${err?.message}`);
    }
  }

  // ─── Broadcast to execution layer (live mode only) ────────────────────────

  async broadcastSignal(signal: AiSignalDocument): Promise<void> {
    await this.aiSignalModel
      .findByIdAndUpdate(signal._id, { $inc: { sentToUsers: 1 } })
      .catch(() => {});
  }

  // ─── Test mode simulation ─────────────────────────────────────────────────

  private async notifySignalTestMode(signal: AiSignalDocument): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const dirColor = signal.direction === "LONG" ? "🟢" : "🔴";
    const fmtP = this.fmtPrice;
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}* 🧪\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `${this.getProfileTag(signal)}\n` +
      `_${time} • Test mode_`;

    const subscribers = await this.subscriptionService.findSignalOnlySubscribers();
    let notified = 0;
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
      notified++;
    }

    await this.aiSignalModel
      .findByIdAndUpdate(signal._id, { sentToUsers: notified })
      .catch(() => {});
  }

  /**
   * In test mode, periodically check if current price would have hit TP or SL.
   */
  private async checkTestModeSignal(signal: AiSignalDocument): Promise<void> {
    const currentPrice = await this.marketDataService.getPrice(signal.symbol);
    if (!currentPrice || currentPrice <= 0) return;

    const isLong = signal.direction === "LONG";

    // ─── Auto risk management ─────────────────────────────────────────────
    const pnlPct = isLong
      ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    // ── Trailing SL: after 1.5% profit, trail SL at peak - 1.2% (never lower) ──
    const TRAIL_TRIGGER = 1.5;
    const TRAIL_DISTANCE = 1.2;

    // Track peak PnL
    const prevPeak = (signal as any).peakPnlPct || 0;
    if (pnlPct > prevPeak) {
      (signal as any).peakPnlPct = pnlPct;
    }
    const peak = (signal as any).peakPnlPct || 0;

    if (peak >= TRAIL_TRIGGER && !(signal as any).slMovedToEntry) {
      // First time reaching 2% → move SL to entry (break-even)
      await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
      (signal as any).stopLossPrice = signal.entryPrice;
      (signal as any).slMovedToEntry = true;
      this.logger.log(
        `[AiSignal] [TEST] 🛡️ ${signal.symbol} SL moved to entry ${signal.entryPrice} (PnL: ${pnlPct.toFixed(2)}%)`,
      );
      await this.notifySlMovedToEntry(signal.symbol, signal.entryPrice);
    }

    // Continuous trailing: SL = entry + (peak - 2%), only raise
    if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER) {
      const trailPct = Math.max(0, peak - TRAIL_DISTANCE);
      const trailSl = isLong
        ? signal.entryPrice * (1 + trailPct / 100)
        : signal.entryPrice * (1 - trailPct / 100);

      const currentSl = (signal as any).stopLossPrice || signal.entryPrice;
      const shouldRaise = isLong ? trailSl > currentSl : trailSl < currentSl;

      if (shouldRaise) {
        (signal as any).stopLossPrice = trailSl;
        await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
        this.logger.log(
          `[AiSignal] [TEST] 📈 ${signal.symbol} trailing SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak: ${peak.toFixed(2)}%`,
        );
      }
    }

    // Check both TP and SL (no auto-close at 5% — we trail instead)
    const tpHit = isLong
      ? currentPrice >= signal.takeProfitPrice
      : currentPrice <= signal.takeProfitPrice;
    const slHit = isLong
      ? currentPrice <= (signal as any).stopLossPrice
      : currentPrice >= (signal as any).stopLossPrice;

    if (!tpHit && !slHit) return;

    const reason = tpHit ? "TAKE_PROFIT" : "STOP_LOSS";
    const pnl = isLong
      ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    this.logger.log(
      `[AiSignal] [TEST] ${signal.symbol} ${reason} at $${currentPrice} (PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%)`,
    );

    // Use profile-aware signal key for dual-timeframe coins
    const sigKey = this.getSignalKey(signal);

    // Mark COMPLETED directly in MongoDB (don't rely on Redis key existing)
    await this.aiSignalModel.findByIdAndUpdate(signal._id, {
      status: "COMPLETED",
      closeReason: reason,
      exitPrice: currentPrice,
      pnlPercent: pnl,
      positionClosedAt: new Date(),
    });
    // Also clean Redis active key if it exists
    await this.signalQueueService.resolveActiveSignal(
      sigKey,
      currentPrice,
      reason as any,
    ).catch(() => {});

    // Track SL hits for market-wide cooldown
    if (reason === "STOP_LOSS") {
      await this.trackSlHitAndMaybeCooldown();
    }

    // Record result for GPT context
    await this.aiOptimizerService.recordTradeResult({
      symbol: signal.symbol,
      direction: signal.direction,
      strategy: signal.strategy || "",
      pnlPercent: pnl,
      closeReason: reason,
    }).catch(() => {});

    // Set cooldown to prevent ping-pong recreation (30 min)
    await this.redisService.set(
      `cache:ai:cooldown:${sigKey}`,
      true,
      30 * 60,
    );

    // TP/SL notifications only for admin (real-mode users get notified via UserRealTradingService)

    // Activate queued if any
    let queued = await this.signalQueueService.activateQueuedSignal(sigKey);
    if (queued) {
      // Refresh entry price — queued signals can be hours old, SL/TP must reflect current market
      const livePrice = this.marketDataService.getLatestPrice(queued.symbol);
      if (livePrice && livePrice > 0) {
        queued = await this.signalQueueService.refreshEntryPrice(queued, livePrice);
      }
      await this.notifySignalTestMode(queued);
      this.userRealTradingService.onSignalActivated(queued, {} as any).catch((err) =>
        this.logger.error(`[AiSignal] Real trading error (queued promoted): ${err?.message}`),
      );
    }
  }

  // ─── Telegram notifications ───────────────────────────────────────────────

  /**
   * For dual-timeframe coins (BTC/ETH), returns `SYMBOL:PROFILE` so both
   * INTRADAY and SWING can coexist as separate active signals.
   * For all other coins, returns just the symbol.
   */
  private getSignalKey(signal: AiSignalDocument): string {
    const coin = signal.coin.toUpperCase();
    const profile = (signal as any).timeframeProfile;
    if (DUAL_TIMEFRAME_COINS.includes(coin) && profile) {
      return `${signal.symbol}:${profile}`;
    }
    return signal.symbol;
  }

  /** Reset all coin profile stats (admin full reset). */
  async resetCoinProfileStats(): Promise<number> {
    const result = await this.aiCoinProfileModel.updateMany({}, { $set: { wins: 0, losses: 0, totalTrades: 0 } });
    return result.modifiedCount;
  }

  /** Format price for Telegram display */
  private fmtPrice = (p: number): string =>
    p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
    p >= 1 ? `$${p.toFixed(2)}` :
    p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

  /** Returns a display tag like "⚡ Intraday (15m)" or "🌊 Swing (4h)" */
  private getProfileTag(signal: AiSignalDocument): string {
    const profile = (signal as any).timeframeProfile;
    return profile === "SWING" ? "🌊 Swing (4h)" : "⚡ Intraday (15m)";
  }

  /**
   * Notify subscribers about a new ACTIVE signal (live mode only).
   */
  private async notifySignalActive(
    signal: AiSignalDocument,
    _params: AiTunedParams,
    isTestMode: boolean,
  ): Promise<void> {
    if (isTestMode) return; // Test mode uses notifySignalTestMode instead

    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const dirColor = signal.direction === "LONG" ? "🟢" : "🔴";
    const fmtP = this.fmtPrice;
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `${this.getProfileTag(signal)}\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findSignalOnlySubscribers();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifySignalQueued(
    signal: AiSignalDocument,
    isTestMode: boolean,
  ): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const dirColor = signal.direction === "LONG" ? "🟢" : "🔴";
    const testLabel = isTestMode ? " 🧪" : "";
    const fmtP = this.fmtPrice;
    const hoursLeft = Math.max(0, (signal.expiresAt.getTime() - Date.now()) / 3600000);
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}* 📋${testLabel}\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `⏳ _Đang chờ — hết hạn ${hoursLeft.toFixed(1)}h_\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findSignalOnlySubscribers();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifyQueueActivated(
    signal: AiSignalDocument,
    closedInfo: ResolvedSignalInfo,
  ): Promise<void> {
    const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
    const dirColor = signal.direction === "LONG" ? "🟢" : "🔴";
    const pnlSign = closedInfo.pnlPercent >= 0 ? "+" : "";
    const pnlEmoji = closedInfo.pnlPercent >= 0 ? "🟢" : "🔴";
    const testLabel = signal.isTestMode ? " 🧪" : "";
    const fmtP = this.fmtPrice;
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

    const text =
      `${pnlEmoji} *${closedInfo.symbol} ${closedInfo.direction} đã đóng*\n` +
      `${fmtP(closedInfo.entryPrice)} → ${fmtP(closedInfo.exitPrice)} (*${pnlSign}${closedInfo.pnlPercent.toFixed(2)}%*)\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirEmoji} *Lệnh chờ — ${signal.symbol}*${testLabel}\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findSignalOnlySubscribers();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifySlMovedToEntry(_symbol: string, _entryPrice: number): Promise<void> {
    // No-op: real-mode users get notified via UserRealTradingService
  }

  private async notifyTpBoosted(_symbol: string, _newTp: number, _newTpPct: number, _direction: string): Promise<void> {
    // No-op: real-mode users get notified via UserRealTradingService
  }

  private async notifyPositionClosed(info: ResolvedSignalInfo): Promise<void> {
    // Real-mode users get notified via UserRealTradingService; non-real users don't need close notifications
    const pnlSign = info.pnlPercent >= 0 ? "+" : "";
    this.logger.log(
      `[AiSignal] ${info.symbol} ${info.direction} ${info.closeReason}: ${pnlSign}${info.pnlPercent.toFixed(2)}%`,
    );
  }

  private async notifyAdminOnly(text: string): Promise<void> {
    const adminIdStr = this.configService.get<string>(
      "AI_ADMIN_TELEGRAM_ID",
      "",
    );
    const adminIds = adminIdStr
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));

    for (const adminId of adminIds) {
      // Admin chatId is usually same as telegramId for private bots
      await this.telegramService
        .sendTelegramMessage(adminId, text)
        .catch(() => {});
    }
  }

  // ─── Coin profile update ──────────────────────────────────────────────────

  private async updateCoinProfile(info: ResolvedSignalInfo): Promise<void> {
    const recentSignal = await this.aiSignalModel.findOne({
      symbol: info.symbol,
      status: "COMPLETED",
      positionClosedAt: { $gte: new Date(Date.now() - 15000) },
    });
    if (!recentSignal) return;

    const isWin = info.pnlPercent > 0;
    const strategy = recentSignal.strategy;

    await this.aiCoinProfileModel.findOneAndUpdate(
      { symbol: info.symbol },
      {
        $inc: {
          [`strategyStats.${strategy}.totalSignals`]: 1,
          [`strategyStats.${strategy}.wins`]: isWin ? 1 : 0,
        },
        $set: {
          [`strategyStats.${strategy}.lastUsedAt`]: new Date(),
          lastRegime: recentSignal.regime,
          lastStrategy: strategy,
        },
        $setOnInsert: {
          coin: info.symbol.replace("USDT", "").toLowerCase(),
          currency: "usdt",
        },
      },
      { upsert: true },
    );
  }

  // ─── Admin API ────────────────────────────────────────────────────────────

  async pause(): Promise<void> {
    await this.redisService.set(AI_PAUSED_KEY, true, 24 * 60 * 60);
    this.logger.log("[AiSignal] Signal generation PAUSED");
  }

  async resume(): Promise<void> {
    await this.redisService.delete(AI_PAUSED_KEY);
    this.logger.log("[AiSignal] Signal generation RESUMED");
  }

  async enableTestMode(): Promise<void> {
    await this.redisService.set(AI_TEST_MODE_KEY, true);
    this.logger.log("[AiSignal] TEST MODE enabled");
  }

  async disableTestMode(): Promise<void> {
    await this.redisService.delete(AI_TEST_MODE_KEY);
    this.logger.log("[AiSignal] TEST MODE disabled — LIVE mode");
  }

  async isTestModeEnabled(): Promise<boolean> {
    const val = await this.redisService.get<boolean>(AI_TEST_MODE_KEY);
    return !!val;
  }

  async getStatus(): Promise<{
    paused: boolean;
    testMode: boolean;
    globalRegime: string;
    activeCount: number;
    queuedCount: number;
    shortlist: string[];
  }> {
    const [paused, testMode, regime, actives, queued, shortlist] =
      await Promise.all([
        this.redisService.get<boolean>(AI_PAUSED_KEY),
        this.redisService.get<boolean>(AI_TEST_MODE_KEY),
        this.redisService.get<string>("cache:ai:regime"),
        this.signalQueueService.getAllActiveSignals(),
        this.signalQueueService.getAllQueuedSignals(),
        this.coinFilterService.getShortlist(),
      ]);

    return {
      paused: !!paused,
      testMode: !!testMode,
      globalRegime: regime || "UNKNOWN",
      activeCount: actives.length,
      queuedCount: queued.length,
      shortlist: shortlist.map((s) => s.symbol),
    };
  }

  async getParamsForSymbol(coin: string, currency: string): Promise<any> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    return this.redisService.get(`cache:ai:params:${symbol}`);
  }

  async getAllCoinParams(): Promise<
    {
      symbol: string;
      confidence: number;
      regime: string;
      strategy: string;
      lastPrice: number;
      quoteVolume: number;
      priceChangePercent: number;
    }[]
  > {
    const shortlist = await this.coinFilterService.getShortlist();
    const results: {
      symbol: string;
      confidence: number;
      regime: string;
      strategy: string;
      lastPrice: number;
      quoteVolume: number;
      priceChangePercent: number;
    }[] = [];

    const globalRegime = await this.redisService.get<string>("cache:ai:regime") || "MIXED";
    for (const entry of shortlist) {
      const params = await this.redisService.get<any>(
        `cache:ai:params:${entry.symbol}`,
      );
      results.push({
        symbol: entry.symbol,
        confidence: params?.confidence || 0,
        regime: params?.regime || globalRegime,
        strategy: params?.strategy || "N/A",
        lastPrice: entry.lastPrice || 0,
        quoteVolume: entry.quoteVolume || 0,
        priceChangePercent: entry.priceChangePercent || 0,
      });
    }
    return results;
  }

  async generateMarketOverview(): Promise<string> {
    const coinData = await this.getAllCoinParams();

    // Fetch futures analytics (funding, OI, L/S) for top coins
    const topSymbols = coinData
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 10)
      .map((c) => c.symbol);
    const analytics = await this.futuresAnalyticsService.fetchAnalytics(topSymbols);

    // Convert to plain object for ai-optimizer
    const analyticsObj: Record<string, any> = {};
    analytics.forEach((v, k) => { analyticsObj[k] = v; });

    return this.aiOptimizerService.generateMarketOverview(coinData, analyticsObj);
  }

  async overrideStrategy(
    coin: string,
    currency: string,
    strategy: string,
  ): Promise<void> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const cacheKey = `cache:ai:params:${symbol}`;
    const current = await this.redisService.get<any>(cacheKey);
    if (current) {
      current.strategy = strategy;
      await this.redisService.set(cacheKey, current, 4 * 60 * 60);
    }
    this.logger.log(`[AiSignal] Override strategy for ${symbol}: ${strategy}`);
  }
}
