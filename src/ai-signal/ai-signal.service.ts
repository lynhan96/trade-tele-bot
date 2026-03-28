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
import {
  AiSignalValidation,
  AiSignalValidationDocument,
} from "../schemas/ai-signal-validation.schema";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { UserRealTradingService } from "./user-real-trading.service";
import { MarketDataService } from "../market-data/market-data.service";
import { CoinGeckoService } from "../coingecko/coingecko.service";
import { StrategyAutoTunerService } from "./strategy-auto-tuner.service";
import { AiMarketAnalystService } from "./ai-market-analyst.service";
import { TradingConfigService } from "./trading-config";
import { RiskScoreService } from "./risk-score.service";

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
const MAX_ACTIVE_SIGNALS = 25; // Cap concurrent positions to reduce correlated risk

/** Coins that run BOTH INTRADAY (15m) and SWING (4h) strategies simultaneously.
 * Top 5 by market cap — 15m catches more frequent signals than 4h alone. */
const DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

@Injectable()
export class AiSignalService implements OnModuleInit {
  private readonly logger = new Logger(AiSignalService.name);

  // Track coins being processed in current scan to prevent race conditions
  private readonly processingCoins = new Set<string>();

  // Cache getAllActiveSignals to avoid 150 identical DB queries per scan cycle
  private activeSignalsCache: { data: any[]; ts: number } | null = null;
  private readonly ACTIVE_CACHE_TTL = 15000; // 15s

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
    private readonly coinGeckoService: CoinGeckoService,
    private readonly strategyAutoTuner: StrategyAutoTunerService,
    private readonly aiMarketAnalyst: AiMarketAnalystService,
    private readonly tradingConfig: TradingConfigService,
    private readonly riskScoreService: RiskScoreService,
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiCoinProfile.name)
    private readonly aiCoinProfileModel: Model<AiCoinProfileDocument>,
    @InjectModel(AiSignalValidation.name)
    private readonly validationModel: Model<AiSignalValidationDocument>,
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

      // Track SL hits for market-wide cooldown (only losing SLs)
      if (info.closeReason === "STOP_LOSS" && info.pnlPercent < 0) {
        await this.trackSlHitAndMaybeCooldown();
      }

      // Record result for AI context (recent performance awareness)
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

    this.positionMonitorService.setHedgeCallback(async (signal, action, price) => {
      await this.notifyHedgeEvent(signal, action, price);
      // Track hedge as UserTrade for real users (sim record only, no real Binance order)
      await this.userRealTradingService.onHedgeEvent(signal, action, price).catch((err) =>
        this.logger.warn(`[AiSignal] hedge UserTrade tracking error: ${err?.message}`),
      );
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

      // ── Extreme move filter: skip coins with >50% 24h price change ──────
      // After a 50%+ dump/pump the move is done, high risk of reversal/dead cat bounce.
      // Raised from 30% to 50% — market-wide pumps (30-40%) are common in bull runs.
      const EXTREME_MOVE_PCT = 50;
      const filtered = shortlist.filter((entry) => {
        if (Math.abs(entry.priceChangePercent) > EXTREME_MOVE_PCT) {
          this.logger.log(
            `[AiSignal] ${entry.coin.toUpperCase()} skipped — extreme 24h move (${entry.priceChangePercent > 0 ? "+" : ""}${entry.priceChangePercent.toFixed(1)}%)`,
          );
          this.redisService.initAndIncr('cache:ai:filter:extreme_move', 0, 86400).catch(() => {});
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
    // Always run — checkAndResolve already skips isTestMode signals (line 1544)
    // Live positions must be monitored even when test mode is ON

    try {
      const resolved = await this.positionMonitorService.checkAndResolve();

      for (const info of resolved) {
        // Use profile-aware key for cooldown on dual-timeframe coins
        const signalKey = info.signalKey || info.symbol;
        // Cooldown to prevent ping-pong recreation (30 min)
        await this.redisService.set(`cache:ai:cooldown:${signalKey}`, true, 30 * 60);

        // Track SL hits for market-wide cooldown (only losing SLs)
        if (info.closeReason === "STOP_LOSS" && info.pnlPercent < 0) {
          await this.trackSlHitAndMaybeCooldown();
        }

        // Record trade result for AI context
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
      const { count } = await this.signalQueueService.cleanupExpiredQueued();
      if (count > 0) {
        this.logger.log(`[AiSignal] Cleaned up ${count} expired QUEUED signal(s)`);
      }
      // Time-stop removed — hedge/trail/DCA handle exits
    } catch (err) {
      this.logger.error(`[AiSignal] cleanupExpiredSignals error: ${err?.message}`);
    }
  }

  // ─── Pre-filter: fast cache-only checks (no indicator/API calls) ────────

  private async preFilter(
    coin: string,
    symbol: string,
    signalKey: string,
    isDual: boolean,
    forceProfile?: string,
  ): Promise<{ pass: boolean; marketGuard?: any; reason?: string }> {
    // Coin blacklist (auto-tuner disabled due to poor PnL)
    const coinBlacklist = await this.strategyAutoTuner.getCoinBlacklist();
    if (coinBlacklist.has(coin.toUpperCase())) {
      return { pass: false, reason: 'blacklisted' };
    }

    // Active signal check
    const hasActive = await this.signalQueueService.getActiveSignal(signalKey);
    if (hasActive) return { pass: false, reason: 'has_active' };

    // Cap total active signals
    const cfg = this.tradingConfig.get();
    const maxSignals = Math.min(cfg.maxActiveSignals || MAX_ACTIVE_SIGNALS, MAX_ACTIVE_SIGNALS);
    let allActives;
    if (this.activeSignalsCache && Date.now() - this.activeSignalsCache.ts < this.ACTIVE_CACHE_TTL) {
      allActives = this.activeSignalsCache.data;
    } else {
      allActives = await this.signalQueueService.getAllActiveSignals();
      this.activeSignalsCache = { data: allActives, ts: Date.now() };
    }
    if (allActives.length >= maxSignals) {
      this.logger.debug(`[AiSignal] Active cap reached (${allActives.length}/${maxSignals}${cfg.maxActiveSignals ? ' [config]' : ' [default]'}) — skipping`);
      return { pass: false, reason: 'active_cap' };
    }

    // Dual-timeframe conflict
    if (isDual && forceProfile) {
      const otherProfile = forceProfile === "INTRADAY" ? "SWING" : "INTRADAY";
      const otherActive = await this.signalQueueService.getActiveSignal(`${symbol}:${otherProfile}`);
      if (otherActive) return { pass: false, reason: 'dual_conflict' };
    }

    // Cooldown after SL/TP
    const cooldown = await this.redisService.get<boolean>(`cache:ai:cooldown:${signalKey}`);
    if (cooldown) {
      this.redisService.initAndIncr('cache:ai:filter:cooldown', 0, 86400).catch(() => {});
      return { pass: false, reason: 'cooldown' };
    }

    // Market Guard pauseAll
    const marketGuard = await this.strategyAutoTuner.getMarketGuard();
    if (marketGuard.pauseAll) {
      this.logger.log(`[AiSignal] ${coin.toUpperCase()} skipped — Market Guard: ALL paused (${marketGuard.reason})`);
      return { pass: false, marketGuard, reason: 'market_guard_pause' };
    }

    // Daily signal cap
    const MAX_DAILY_SIGNALS = cfg.maxDailySignals || 35;
    const dailyCountKey = "cache:ai:daily-signal-count";
    const currentDailyCount = await this.redisService.get<number>(dailyCountKey) ?? 0;
    if (currentDailyCount >= MAX_DAILY_SIGNALS) {
      this.logger.debug(`[AiSignal] Daily signal cap reached (${MAX_DAILY_SIGNALS}) — skipping ${coin.toUpperCase()}`);
      return { pass: false, reason: 'daily_cap' };
    }

    return { pass: true, marketGuard };
  }

  // ─── Core: process a single coin (3-tier pipeline) ─────────────────────

  private async processCoin(
    coin: string,
    currency: string,
    globalRegime: string,
    forceProfile?: string,
  ): Promise<void> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const coinUpper = coin.toUpperCase();
    const isDual = DUAL_TIMEFRAME_COINS.includes(coinUpper);
    const lockKey = isDual && forceProfile ? `${symbol}:${forceProfile}` : symbol;
    const signalKey = isDual && forceProfile ? `${symbol}:${forceProfile}` : symbol;

    // In-memory lock to prevent same coin+profile being processed concurrently
    if (this.processingCoins.has(lockKey)) return;
    this.processingCoins.add(lockKey);

    // Symbol-level lock for dual coins: prevent INTRADAY+SWING racing each other
    if (isDual) {
      while (this.processingCoins.has(`${symbol}:__DUAL_LOCK__`)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      this.processingCoins.add(`${symbol}:__DUAL_LOCK__`);
    }

    try {

    // ═══ TIER 1: Pre-filter (cache only) ═══
    const pre = await this.preFilter(coin, symbol, signalKey, isDual, forceProfile);
    if (!pre.pass) return;
    const marketGuard = pre.marketGuard;
    const cfg = this.tradingConfig.get();

    // ═══ TIER 2: Strategy + Confluence ═══
    const params = await this.aiOptimizerService.tuneParamsForSymbol(
      coin, currency, globalRegime, forceProfile,
    );

    // Confidence floor: regime-aware, boosted by market guard
    const CONFIDENCE_FLOOR = cfg.confidenceFloor || 63;
    const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
    const rangingFloor = cfg.confidenceFloorRanging || 67;
    const effectiveFloor = isRanging
      ? Math.max(rangingFloor, marketGuard.confidenceFloor)
      : Math.max(CONFIDENCE_FLOOR, marketGuard.confidenceFloor);
    params.minConfidenceToTrade = Math.max(params.minConfidenceToTrade ?? 0, effectiveFloor);
    const MAX_CONFIDENCE_CAP = (cfg as any).maxConfidenceCap || 68;
    if (params.minConfidenceToTrade > MAX_CONFIDENCE_CAP) {
      params.minConfidenceToTrade = MAX_CONFIDENCE_CAP;
    }

    // Rule engine evaluate (confluence + agent brain + Singapore/on-chain filters)
    const signalResult = await this.ruleEngineService.evaluate(coin, currency, params);
    if (!signalResult) return;

    // Futures analytics: confidence adjustment (boost/penalize based on direction alignment)
    const cachedAnalytics = await this.futuresAnalyticsService.getCachedAnalytics();
    const fa = cachedAnalytics.get(symbol);
    if (fa) {
      let adj = 0;
      const isLong = signalResult.isLong;
      if (fa.fundingRate > 0.001) adj += isLong ? -8 : 8;
      else if (fa.fundingRate < -0.001) adj += isLong ? 8 : -8;
      else if (Math.abs(fa.fundingRate) < 0.0003) adj += 3;
      if (fa.longShortRatio > 2.0) adj += isLong ? -10 : 10;
      else if (fa.longShortRatio < 0.5) adj += isLong ? 10 : -10;
      if (fa.takerBuyRatio < 0.7) adj += isLong ? -5 : 5;
      else if (fa.takerBuyRatio > 1.3) adj += isLong ? 5 : -5;
      if (adj !== 0) {
        params.confidence = Math.max(10, Math.min(95, params.confidence + adj));
        this.logger.debug(
          `[AiSignal] ${coinUpper} confidence ${adj > 0 ? "+" : ""}${adj} from futures data (now ${params.confidence})`,
        );
      }
    }

    // Main confidence gate (after futures adjustment)
    if (params.confidence < params.minConfidenceToTrade) {
      this.logger.debug(
        `[AiSignal] ${coinUpper} ${signalResult.isLong ? "LONG" : "SHORT"} blocked — confidence ${params.confidence} < min ${params.minConfidenceToTrade} (${params.regime})`,
      );
      this.redisService.initAndIncr('cache:ai:filter:confidence_block', 0, 86400).catch(() => {});
      this.logValidation(symbol, signalResult, params, false, `confidence ${params.confidence} < ${params.minConfidenceToTrade}`);
      return;
    }

    // ═══ TIER 3: Risk Score ═══
    let signalFuturesData: { fundingRate?: number; longShortRatio?: number; takerBuyRatio?: number; openInterestUsd?: number } | undefined;
    try {
      const analyticsCache = await this.futuresAnalyticsService.getCachedAnalytics();
      let faData = analyticsCache.get(symbol);
      if (!faData) {
        this.logger.debug(`[AiSignal] ${signalKey} no cached analytics — fetching live funding rate`);
        faData = await this.futuresAnalyticsService.fetchSingleCoin(symbol);
      }
      if (faData) {
        signalFuturesData = {
          fundingRate: faData.fundingRate,
          longShortRatio: faData.longShortRatio,
          takerBuyRatio: faData.takerBuyRatio,
          openInterestUsd: faData.openInterestUsd || 0,
        };
      }
    } catch (err) {
      this.logger.debug(`[AiSignal] Futures data fetch error for ${signalKey}: ${err?.message}`);
    }

    const fundingRate = signalFuturesData?.fundingRate || fa?.fundingRate || 0;
    const agentBrain = await this.redisService.get<any>('cache:agent:brain');
    const risk = await this.riskScoreService.computeRiskScore(
      coin, signalResult.isLong, globalRegime, marketGuard, agentBrain, fundingRate, cfg,
    );
    if (risk.blocked) {
      this.logger.debug(`[AiSignal] ${coin} risk score ${risk.score} > threshold — skipped`);
      await this.redisService.initAndIncr('cache:ai:filter:risk_score', 0, 86400);
      this.logValidation(symbol, signalResult, params, false, `risk_score ${risk.score} > threshold`);
      return;
    }

    // Agent strategy blacklist (enabledStrategies = "disable:X,Y")
    const enabledStrats = cfg.enabledStrategies || '';
    if (enabledStrats.startsWith('disable:')) {
      const disabled = enabledStrats.replace('disable:', '').split(',').map(s => s.trim()).filter(Boolean);
      if (disabled.some(d => signalResult.strategy.includes(d))) {
        this.logger.debug(`[AiSignal] ${signalKey} BLOCKED — strategy ${signalResult.strategy} disabled by agent (${enabledStrats})`);
        return;
      }
    }

    // Strategy weight check (deterministic disable only — weight <= 0)
    try {
      const weight = await this.aiMarketAnalyst.getStrategyWeight(signalResult.strategy);
      if (weight <= 0) {
        this.logger.log(`[AiSignal] ${signalKey} BLOCKED — strategy ${signalResult.strategy} weight=0 (AI disabled)`);
        return;
      }
    } catch {}

    // Regime-adaptive SL/TP override
    const regimeSlTp = cfg.regimeSlTp?.[params.regime];
    if (regimeSlTp) {
      const origSl = params.stopLossPercent;
      const origTp = params.takeProfitPercent;
      params.stopLossPercent = Math.max(regimeSlTp.slMin, Math.min(regimeSlTp.slMax, params.stopLossPercent || regimeSlTp.slMax));
      params.takeProfitPercent = Math.max(regimeSlTp.tpMin, Math.min(regimeSlTp.tpMax, params.takeProfitPercent || regimeSlTp.tpMax));
      if (origSl !== params.stopLossPercent || origTp !== params.takeProfitPercent) {
        this.logger.log(`[AiSignal] ${signalKey} regime ${params.regime} SL/TP adjusted: SL ${origSl}→${params.stopLossPercent}% TP ${origTp}→${params.takeProfitPercent}%`);
      }
    }

    // ═══ Emit Signal ═══
    const isTestMode = await this.isTestModeEnabled();

    this.logValidation(symbol, signalResult, params, true, undefined, fundingRate);

    this.logger.log(
      `[AiSignal]${isTestMode ? " [TEST]" : ""} Signal: ${symbol} ${signalResult.isLong ? "LONG" : "SHORT"} (${signalResult.strategy}) — ${signalResult.reason} [risk=${risk.score}]`,
    );

    const queueResult = await this.signalQueueService.handleNewSignal(
      coin, currency, signalResult, params, params.regime, isTestMode, forceProfile, signalFuturesData,
    );

    // Only increment daily count for signals that were actually EXECUTED or QUEUED
    if (queueResult.action === "EXECUTED" || queueResult.action === "QUEUED") {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setUTCDate(midnight.getUTCDate() + 1);
      midnight.setUTCHours(0, 0, 0, 0);
      const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
      await this.redisService.initAndIncr("cache:ai:daily-signal-count", 0, ttl);
    }

    if (queueResult.action === "EXECUTED") {
      await this.handlePostActivation(signalKey, params, isTestMode);
    } else if (queueResult.action === "QUEUED") {
      const queuedSignal = await this.signalQueueService.getQueuedSignal(signalKey);
      if (queuedSignal) {
        await this.notifySignalQueued(queuedSignal, isTestMode);
      }
    }

    } finally {
      this.processingCoins.delete(lockKey);
      if (isDual) this.processingCoins.delete(`${symbol}:__DUAL_LOCK__`);
    }
  }

  // ─── Post-activation flow (shared by internal + external signals) ────────

  /**
   * After a signal is EXECUTED: refresh entry price, notify, trigger real trading.
   * Called by processCoin() and ExternalSignalService.
   */
  async handlePostActivation(
    signalKey: string,
    params: Record<string, any>,
    isTestMode?: boolean,
  ): Promise<void> {
    // Invalidate active signals cache — a new signal just activated
    this.activeSignalsCache = null;

    if (isTestMode === undefined) {
      isTestMode = await this.isTestModeEnabled();
    }
    let activeSignal = await this.signalQueueService.getActiveSignal(signalKey);
    if (!activeSignal) return;

    // Refresh entry price to current market price (candle close can be stale)
    const livePrice = this.marketDataService.getLatestPrice(activeSignal.symbol);
    if (livePrice && livePrice > 0) {
      activeSignal = await this.signalQueueService.refreshEntryPrice(activeSignal, livePrice);
    }

    // Register price listener for real-time monitoring (hedge, DCA, trail SL/TP)
    // Must use registerListener (not refreshSignalReference) because this is a NEW signal
    this.positionMonitorService.registerListener(activeSignal);

    if (isTestMode) {
      await this.notifySignalTestMode(activeSignal);
    } else {
      await this.broadcastSignal(activeSignal);
    }
    await this.notifySignalActive(activeSignal, params as any, isTestMode);

    // Trigger real order placement for users with real mode enabled (skip test signals)
    if (!isTestMode) {
      this.userRealTradingService.onSignalActivated(activeSignal, params as any).catch((err) =>
        this.logger.error(`[AiSignal] Real trading error: ${err?.message}`),
      );
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

        const entryRef = (signal as any).gridAvgEntry || signal.entryPrice;
        const pnlPct = signal.direction === "LONG"
          ? ((currentPrice - entryRef) / entryRef) * 100
          : ((entryRef - currentPrice) / entryRef) * 100;

        // Only close positions that are actually losing (< -0.5%)
        // Positions near breakeven or profitable should keep running with their SL/TP
        if (pnlPct < -0.5) {
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
          `Đã đóng *${closedCount}* lệnh ${closeDirection} đang lỗ (< -0.5%).\n` +
          `Lệnh hòa vốn/có lời vẫn giữ với SL/TP riêng.\n\n` +
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

    // Simulated volume: $1000 notional per trade
    const simNotional = 1000;
    const simQuantity = simNotional / signal.entryPrice;

    // Singapore filter info from signal metadata
    const sgFilters: string[] = (signal as any).sgFilters || [];
    const sgLines = sgFilters.length > 0
      ? sgFilters.map(r => {
          if (r.includes('OP line OK')) return `📊 OP: ${r.replace('OP line OK: ', '')}`;
          if (r.includes('Volume:')) return `💰 ${r}`;
          if (r.includes('S/R OK')) return `📐 ${r.replace('S/R OK: ', 'S/R: ')}`;
          return '';
        }).filter(Boolean).join('\n')
      : '';

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}* 🧪\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `Vol: *$${simNotional.toLocaleString()}* | Qty: *${simQuantity.toFixed(4)}*\n` +
      (sgLines ? `\n${sgLines}\n` : '') +
      `\n${this.getProfileTag(signal)}\n` +
      `_${time} • Test mode_`;

    // Test mode: only notify admin
    await this.notifyAdminOnly(text);

    await this.aiSignalModel
      .findByIdAndUpdate(signal._id, { sentToUsers: 1 })
      .catch(() => {});
  }

  /**
   * In test mode, periodically check if current price would have hit TP or SL.
   */
  private async checkTestModeSignal(signal: AiSignalDocument): Promise<void> {
    // Grid signals are fully managed by position-monitor's handlePriceTick — skip here
    if ((signal as any).gridLevels?.length > 0) return;

    const currentPrice = await this.marketDataService.getPrice(signal.symbol);
    if (!currentPrice || currentPrice <= 0) return;

    const isLong = signal.direction === "LONG";

    // ─── Auto risk management ─────────────────────────────────────────────
    const pnlPct = isLong
      ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    // ── Trailing SL: use config values ──
    const cfg = this.tradingConfig.get();
    const TRAIL_TRIGGER = cfg.trailTrigger;
    const TRAIL_KEEP_RATIO = cfg.trailKeepRatio;

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
        `[AiSignal] [TEST] 🛡️ ${signal.symbol} SL moved to entry ${signal.entryPrice} at 1.5% profit (PnL: ${pnlPct.toFixed(2)}%)`,
      );
      await this.notifySlMovedToEntry(signal.symbol, signal.entryPrice);
    }

    // Continuous trailing: SL = entry + (peak × keepRatio), only raise
    // TP proximity lock: freeze trail when within tpProximityLock% of TP
    if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER) {
      const tpPrice = signal.takeProfitPrice;
      const distanceToTp = tpPrice
        ? Math.abs((tpPrice - currentPrice) / currentPrice) * 100
        : 999;
      const nearTp = distanceToTp < cfg.tpProximityLock;

      if (!nearTp) {
        const trailPct = peak * TRAIL_KEEP_RATIO;
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
    }

    // Check both TP and SL (no auto-close at 5% — we trail instead)
    const tpHit = isLong
      ? currentPrice >= signal.takeProfitPrice
      : currentPrice <= signal.takeProfitPrice;
    const slHit = isLong
      ? currentPrice <= (signal as any).stopLossPrice
      : currentPrice >= (signal as any).stopLossPrice;

    if (!tpHit && !slHit) return;

    // Use gridAvgEntry for grid signals
    const entryForPnl = (signal as any).gridAvgEntry || signal.entryPrice;
    // Trail stop: SL hit but position is in profit (trail SL moved above entry)
    const slPrice = (signal as any).stopLossPrice;
    const isTrailStop = slHit && !tpHit && (
      (isLong && slPrice > entryForPnl) ||
      (!isLong && slPrice < entryForPnl)
    );
    const reason = tpHit ? "TAKE_PROFIT" : isTrailStop ? "TRAIL_STOP" : "STOP_LOSS";
    const pnl = isLong
      ? ((currentPrice - entryForPnl) / entryForPnl) * 100
      : ((entryForPnl - currentPrice) / entryForPnl) * 100;

    this.logger.log(
      `[AiSignal] [TEST] ${signal.symbol} ${reason} at $${currentPrice} (PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%)`,
    );

    // Use profile-aware signal key for dual-timeframe coins
    const sigKey = this.getSignalKey(signal);

    // Per-grid USDT PnL (each grid has different fillPrice) — deduct fees
    const takerFeePct = cfg.simTakerFeePct / 100;
    const makerFeePct = cfg.simMakerFeePct / 100;
    const fundingRate = Math.abs((signal as any).fundingRate || 0);
    const hoursHeld = (signal as any).executedAt
      ? (Date.now() - new Date((signal as any).executedAt).getTime()) / 3600000 : 0;
    const fundingIntervals = Math.floor(hoursHeld / 8);

    const grids: any[] = (signal as any).gridLevels || [];
    let simPnlUsdt: number;
    if (grids.length > 0) {
      let totalUsdt = 0;
      let totalFees = 0;
      for (const g of grids) {
        if (g.status === "FILLED") {
          const vol = g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100);
          const gPnl = isLong
            ? ((currentPrice - g.fillPrice) / g.fillPrice) * 100
            : ((g.fillPrice - currentPrice) / g.fillPrice) * 100;
          totalUsdt += (gPnl / 100) * vol;
          const entryFee = g.level === 0 ? vol * takerFeePct : vol * makerFeePct;
          const exitFee = vol * takerFeePct;
          const fundFee = cfg.simFundingEnabled ? vol * fundingRate * fundingIntervals : 0;
          totalFees += entryFee + exitFee + fundFee;
        }
      }
      simPnlUsdt = Math.round((totalUsdt - totalFees) * 100) / 100;
    } else {
      // No grids = L0 only = 40% of simNotional
      const filledVol = ((signal as any).simNotional || 1000) * 0.4;
      const rawPnl = (pnl / 100) * filledVol;
      const fees = filledVol * takerFeePct * 2 + (cfg.simFundingEnabled ? filledVol * fundingRate * fundingIntervals : 0);
      simPnlUsdt = Math.round((rawPnl - fees) * 100) / 100;
    }

    // Mark COMPLETED directly in MongoDB (don't rely on Redis key existing)
    await this.aiSignalModel.findByIdAndUpdate(signal._id, {
      status: "COMPLETED",
      closeReason: reason,
      exitPrice: currentPrice,
      pnlPercent: pnl,
      pnlUsdt: simPnlUsdt,
      positionClosedAt: new Date(),
    });
    // Also clean Redis active key if it exists
    await this.signalQueueService.resolveActiveSignal(
      sigKey,
      currentPrice,
      reason as any,
    ).catch(() => {});

    // Track SL hits for market-wide cooldown (only losing SLs)
    if (reason === "STOP_LOSS" && pnl < 0) {
      await this.trackSlHitAndMaybeCooldown();
    }

    // Record trade result for AI context
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

    // Send test mode close notification to subscribers
    {
      const emoji = pnl >= 0 ? "🟢" : "🔴";
      const dirEmoji = signal.direction === "LONG" ? "📈" : "📉";
      const pnlSign = pnl >= 0 ? "+" : "";
      const usdSign = simPnlUsdt >= 0 ? "+" : "";
      const fmtP = this.fmtPrice;
      // Calculate filled volume (sum of FILLED grid notionals, or full simNotional if no grids)
      const closedGrids: any[] = (signal as any).gridLevels || [];
      const filledVol = closedGrids.length > 0
        ? closedGrids.filter((g: any) => g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED")
            .reduce((s: number, g: any) => s + (g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100)), 0)
        : (signal as any).simNotional || 1000;

      const text =
        `${emoji} *${signal.symbol} ${signal.direction} da dong* 🧪\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${dirEmoji} ${fmtP(signal.entryPrice)} → ${fmtP(currentPrice)}\n` +
        `PnL: *${pnlSign}${pnl.toFixed(2)}% (${usdSign}${simPnlUsdt.toFixed(2)} USDT)*\n` +
        `Vol: *$${Math.round(filledVol).toLocaleString()}*\n\n` +
        `_${reason} • Test mode_`;

      const subscribers = await this.subscriptionService.findSignalOnlySubscribers();
      for (const sub of subscribers) {
        await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
      }
    }

    // Activate queued if any
    let queued = await this.signalQueueService.activateQueuedSignal(sigKey);
    if (queued) {
      // Refresh entry price — queued signals can be hours old, SL/TP must reflect current market
      const livePrice = this.marketDataService.getLatestPrice(queued.symbol);
      if (livePrice && livePrice > 0) {
        queued = await this.signalQueueService.refreshEntryPrice(queued, livePrice);
      }
      this.positionMonitorService.registerListener(queued);
      await this.notifySignalTestMode(queued);
      const promotedParams = (queued as any).aiParams ?? {};
      this.userRealTradingService.onSignalActivated(queued, promotedParams).catch((err) =>
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
    const pnlSign = info.pnlPercent >= 0 ? "+" : "";
    this.logger.log(
      `[AiSignal] ${info.symbol} ${info.direction} ${info.closeReason}: ${pnlSign}${info.pnlPercent.toFixed(2)}%`,
    );

    // Send close notification to subscribers for test mode signals (with simulated USDT PnL)
    if (info.simNotional && info.pnlUsdt !== undefined) {
      const emoji = info.pnlPercent >= 0 ? "🟢" : "🔴";
      const dirEmoji = info.direction === "LONG" ? "📈" : "📉";
      const usdSign = info.pnlUsdt >= 0 ? "+" : "";
      const fmtP = this.fmtPrice;

      const text =
        `${emoji} *${info.symbol} ${info.direction} da dong* 🧪\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${dirEmoji} ${fmtP(info.entryPrice)} → ${fmtP(info.exitPrice)}\n` +
        `PnL: *${pnlSign}${info.pnlPercent.toFixed(2)}% (${usdSign}${info.pnlUsdt.toFixed(2)} USDT)*\n` +
        `Vol: *$${(info.filledVol ?? info.simNotional).toLocaleString()}*\n\n` +
        `_${info.closeReason} • Test mode_`;

      // Test mode: only notify admin
      await this.notifyAdminOnly(text);
    }
  }

  private async notifyHedgeEvent(signal: any, action: any, price: number): Promise<void> {
    try {
      const fmtP = this.fmtPrice;
      const sym = signal.symbol;
      const dir = signal.direction;
      const hedgeDir = action.hedgeDirection || (dir === "LONG" ? "SHORT" : "LONG");
      const cfg = this.tradingConfig.get();
      const isTest = await this.isTestModeEnabled();
      const modeLabel = isTest ? "Test mode" : "Live";
      const cycle = (signal.hedgeCycleCount || 0) + 1;

      if (action.action === "OPEN_FULL" || action.action === "OPEN_PARTIAL" || action.action === "UPGRADE_FULL") {
        const phaseLabel = action.hedgePhase === "FULL" ? "FULL 100%" : "PARTIAL 50%";
        const banked = action.bankedProfit ?? 0;
        const text =
          `🔄 *Auto-Hedge #${cycle}*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `${sym} — Hedge *${hedgeDir}*\n` +
          `Entry: *${fmtP(price)}*\n` +
          `TP: *${fmtP(action.hedgeTpPrice)}*\n` +
          `Vol: *$${action.hedgeNotional?.toFixed(0)}*\n` +
          `Phase: ${phaseLabel}\n\n` +
          `💰 Đã tích lũy: *$${banked.toFixed(2)} USDT*\n` +
          `_Cycle ${cycle}/${cfg.hedgeMaxCycles} • ${modeLabel}_`;
        await this.notifyAdminOnly(text);
      } else if (action.action === "CLOSE_HEDGE") {
        const pnlPct = action.hedgePnlPct ?? 0;
        const pnlUsdt = action.hedgePnlUsdt ?? 0;
        const isProfit = pnlPct >= 0;

        if (isProfit) {
          // --- Hedge close with profit ---
          const oldSl = signal.stopLossPrice;
          const newSl = action.newSlPrice;
          const totalBanked = action.bankedProfit ?? 0;
          const cooldown = cfg.hedgeReEntryCooldownMin || cfg.hedgeCooldownMin || 5;

          let text =
            `✅ *Hedge #${cycle} Đóng Lời*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `${sym} — PnL: *+${pnlPct.toFixed(2)}% (+${pnlUsdt.toFixed(2)} USDT)*\n` +
            `💰 Tổng tích lũy: *$${totalBanked.toFixed(2)} USDT*\n` +
            `📈 SL cải thiện: ${fmtP(oldSl)} → ${fmtP(newSl)}`;

          if (action.newSafetySlPrice) {
            text += `\n🔓 Safety SL mở rộng → ${fmtP(action.newSafetySlPrice)}`;
          }

          text += `\n\n_Chờ ${cooldown}p rồi vào lại... • ${modeLabel}_`;
          await this.notifyAdminOnly(text);
        } else {
          // --- Hedge close with loss (recovery close — main recovered) ---
          let text =
            `🔄 *Hedge #${cycle} Đóng*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `${sym} — PnL: *${pnlPct.toFixed(2)}% (${pnlUsdt.toFixed(2)} USDT)*\n` +
            `📊 Main recovered — hedge no longer needed`;

          text += `\n\n_Chờ vào lại nếu cần... • ${modeLabel}_`;
          await this.notifyAdminOnly(text);
        }
      }
    } catch (err) {
      this.logger.warn(`[AiSignal] Hedge notification error: ${err?.message}`);
    }
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

  private logValidation(
    symbol: string,
    signalResult: { isLong: boolean; strategy: string; reason: string },
    params: any,
    approved: boolean,
    rejectReason?: string,
    fundingRate?: number,
  ): void {
    this.validationModel.create({
      symbol,
      direction: signalResult.isLong ? "LONG" : "SHORT",
      strategy: signalResult.strategy,
      regime: params.regime || "UNKNOWN",
      confidence: params.confidence || 0,
      stopLossPercent: params.stopLossPercent || 3,
      takeProfitPercent: params.takeProfitPercent || 2.5,
      approved,
      model: "rule-engine",
      reason: approved
        ? `Rules passed: ${signalResult.reason}`
        : `Rejected by: ${rejectReason} (${signalResult.reason})`,
      rejectedBy: approved ? [] : [rejectReason || 'unknown'],
    }).catch((err) => this.logger.debug(`[AiSignal] validation log error: ${err?.message}`));
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
