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
import {
  DailyMarketSnapshot,
  DailyMarketSnapshotDocument,
} from "../schemas/daily-market-snapshot.schema";
import { UserRealTradingService } from "./user-real-trading.service";

const AI_PAUSED_KEY = "cache:ai:paused";
const AI_TEST_MODE_KEY = "cache:ai:test-mode";
const AI_SCANNING_KEY = "cache:ai:scanning";

/** Coins that run BOTH INTRADAY (15m) and SWING (4h) strategies simultaneously. */
const DUAL_TIMEFRAME_COINS = ["BTC", "ETH"];

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
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiCoinProfile.name)
    private readonly aiCoinProfileModel: Model<AiCoinProfileDocument>,
    @InjectModel(DailyMarketSnapshot.name)
    private readonly dailySnapshotModel: Model<DailyMarketSnapshotDocument>,
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

    // Register callback for 5% milestone (SL raised to +2% profit)
    this.positionMonitorService.setSl5PctCallback(async (symbol, newSl, direction) => {
      await this.notifySl5PctMilestone(symbol, newSl, direction);
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

    // Generate daily snapshot if missing (delay 30s to let data populate)
    const today = new Date().toISOString().slice(0, 10);
    const snap = await this.dailySnapshotModel.findOne({ date: today });
    if (!snap) {
      setTimeout(() => this.generateDailySnapshot().catch(() => {}), 30_000);
      this.logger.log(
        "[AiSignal] Daily snapshot missing — will generate in 30s",
      );
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

  // ─── Cron: money flow monitor (every 5 minutes, offset 2.5 min) ───────────

  @Cron("2-59/5 * * * *")
  async monitorMoneyFlow() {
    try {
      const shortlist = await this.coinFilterService.getShortlist();
      if (shortlist.length === 0) return;

      const symbols = shortlist.map((s) => s.symbol);
      const analytics = await this.futuresAnalyticsService.fetchAnalytics(symbols);

      const priceVolData = shortlist.map((s) => ({
        symbol: s.symbol,
        lastPrice: s.lastPrice,
        quoteVolume: s.quoteVolume,
        priceChangePercent: s.priceChangePercent,
      }));

      const alerts = await this.futuresAnalyticsService.detectMoneyFlowAlerts(analytics, priceVolData);

      if (alerts.length === 0) {
        // Clear last fingerprint when no alerts (so next alert batch is "new")
        await this.redisService.delete("cache:moneyflow:lastfp");
        return;
      }

      // Build alert message — group by coin for readability
      const highAlerts = alerts.filter((a) => a.severity === "HIGH");
      const medAlerts = alerts.filter((a) => a.severity === "MEDIUM");

      // Only send if there are HIGH alerts, or at least 3 MEDIUM alerts
      if (highAlerts.length === 0 && medAlerts.length < 3) return;

      // Change detection: only send when alert set actually changed
      const fingerprint = alerts
        .map((a) => `${a.symbol}:${a.alertType}:${a.severity}`)
        .sort()
        .join("|");
      const lastFp = await this.redisService.get<string>("cache:moneyflow:lastfp");
      if (fingerprint === lastFp) return; // same alerts — skip
      await this.redisService.set("cache:moneyflow:lastfp", fingerprint, 30 * 60); // 30 min TTL

      const fmtVol = (v: number) =>
        v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` :
        v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e3).toFixed(0)}K`;

      const fmtPrice = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` :
        p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

      // Group alerts by symbol
      const coinAlertMap = new Map<string, typeof alerts>();
      for (const a of alerts) {
        if (!coinAlertMap.has(a.symbol)) coinAlertMap.set(a.symbol, []);
        coinAlertMap.get(a.symbol)!.push(a);
      }

      // Sort: HIGH severity coins first, then by volume
      const sortedCoins = [...coinAlertMap.entries()].sort((a, b) => {
        const aHigh = a[1].some((x) => x.severity === "HIGH") ? 1 : 0;
        const bHigh = b[1].some((x) => x.severity === "HIGH") ? 1 : 0;
        return bHigh - aHigh;
      });

      let text = `🚨 *Cảnh Báo Dòng Tiền*\n`;
      text += `━━━━━━━━━━━━━━━━━━\n\n`;

      for (const [symbol, coinAlerts] of sortedCoins.slice(0, 8)) {
        const coin = symbol.replace("USDT", "");
        const entry = shortlist.find((s) => s.symbol === symbol);
        if (!entry) continue;

        const hasHigh = coinAlerts.some((a) => a.severity === "HIGH");
        const icon = hasHigh ? "🔴" : "🟡";
        const changeSign = entry.priceChangePercent >= 0 ? "+" : "";
        const changeIcon = entry.priceChangePercent > 5 ? "🟢" : entry.priceChangePercent < -5 ? "🔴" : "";

        text += `${icon} *${coin}* ${fmtPrice(entry.lastPrice)} ${changeIcon}${changeSign}${entry.priceChangePercent.toFixed(1)}%\n`;
        text += `   Vol: ${fmtVol(entry.quoteVolume)}`;

        const fa = analytics.get(symbol);
        if (fa) {
          const fundPct = (fa.fundingRate * 100);
          text += ` | F: ${fundPct >= 0 ? "+" : ""}${fundPct.toFixed(3)}%`;
          text += ` | L${fa.longPercent.toFixed(0)}/S${fa.shortPercent.toFixed(0)}`;
        }
        text += `\n`;

        // Show alert details as tags
        const tags: string[] = [];
        for (const a of coinAlerts) {
          if (a.alertType === "VOLUME_SPIKE") tags.push("💰 Volume bất thường");
          if (a.alertType === "FUNDING_EXTREME" && a.data.fundingRate > 0) tags.push("⚠️ Long trả phí cao");
          if (a.alertType === "FUNDING_EXTREME" && a.data.fundingRate < 0) tags.push("⚠️ Short trả phí cao");
          if (a.alertType === "OI_SURGE") tags.push(`📈 OI tăng ${a.data.oiChange.toFixed(0)}%`);
          if (a.alertType === "OI_DROP") tags.push(`📉 OI giảm ${Math.abs(a.data.oiChange).toFixed(0)}%`);
          if (a.alertType === "LONG_SHORT_EXTREME" && a.data.lsRatio > 1) tags.push("⚡ Rủi ro Long Squeeze");
          if (a.alertType === "LONG_SHORT_EXTREME" && a.data.lsRatio < 1) tags.push("⚡ Rủi ro Short Squeeze");
        }
        text += `   ${tags.join(" • ")}\n\n`;
      }

      text += `━━━━━━━━━━━━━━━━━━\n`;
      text += `_${new Date().toLocaleTimeString("vi-VN")} • Binance Futures_`;

      // Broadcast to subscribers who have money flow enabled
      const subscribers = await this.subscriptionService.findMoneyFlowSubscribers();
      for (const sub of subscribers) {
        await this.telegramService.sendTelegramMessage(sub.chatId, text);
      }

      this.logger.log(
        `[AiSignal] Money flow alert sent: ${highAlerts.length} HIGH, ${medAlerts.length} MEDIUM to ${subscribers.length} subscribers`,
      );
    } catch (err) {
      this.logger.warn(`[AiSignal] monitorMoneyFlow error: ${err?.message}`);
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

    // Prevent overlapping scans (100 coins in batches of 5 can take >30s)
    const scanning = await this.redisService.get<boolean>(AI_SCANNING_KEY);
    if (scanning) return;

    await this.redisService.set(AI_SCANNING_KEY, true, 300); // 5 min safety TTL
    try {
      const shortlist = await this.coinFilterService.getShortlist();
      if (shortlist.length === 0) return;

      const globalRegime = await this.aiOptimizerService.assessGlobalRegime();

      // Build work items: BTC/ETH get TWO entries (INTRADAY + SWING), all others use SWING (4h)
      const workItems: { coin: string; currency: string; forceProfile?: string }[] = [];
      for (const entry of shortlist) {
        const coinUpper = entry.coin.toUpperCase();
        if (DUAL_TIMEFRAME_COINS.includes(coinUpper)) {
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "INTRADAY" });
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "SWING" });
        } else {
          workItems.push({ coin: entry.coin, currency: entry.currency, forceProfile: "SWING" });
        }
      }

      // Process in batches of 5 to avoid Anthropic concurrent connection limits
      const BATCH_SIZE = 5;
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

  // ─── Cron: cleanup expired QUEUED signals (every 5 minutes) ──────────────

  @Cron("*/5 * * * *")
  async cleanupExpiredQueued() {
    try {
      const { count, cancelledActives } = await this.signalQueueService.cleanupExpiredQueued();
      if (count > 0) {
        this.logger.log(
          `[AiSignal] Cleaned up ${count} expired QUEUED signal(s)`,
        );
      }
      // Notify subscribers for any ACTIVE signals that were TTL-cancelled
      for (const signal of cancelledActives) {
        await this.notifySignalExpired(signal).catch(() => {});
      }
    } catch (err) {
      this.logger.error(
        `[AiSignal] cleanupExpiredQueued error: ${err?.message}`,
      );
    }
  }

  // ─── Cron: daily market snapshot (once per day at 8:00 AM UTC+7) ────────

  @Cron("0 1 * * *") // 01:00 UTC = 08:00 ICT
  async generateDailySnapshot(forceRegenerate = false) {
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Skip if already generated today (unless forced)
      const existing = await this.dailySnapshotModel.findOne({ date: today });
      if (existing && !forceRegenerate) return;
      if (existing && forceRegenerate) {
        await this.dailySnapshotModel.deleteOne({ _id: existing._id });
        this.logger.log(`[AiSignal] Deleted old snapshot for ${today} — regenerating`);
      }

      const shortlist = await this.coinFilterService.getShortlist();
      if (shortlist.length === 0) return;

      const symbols = shortlist.map((s) => s.symbol);
      const analytics = await this.futuresAnalyticsService.fetchAnalytics(symbols);

      // Build coin data with cached params
      const coinData = await Promise.all(
        shortlist.map(async (s) => {
          const coin = s.symbol.replace("USDT", "").toLowerCase();
          const cached = await this.redisService.get<AiTunedParams>(`cache:ai:params:${s.symbol}`);
          return {
            symbol: s.symbol,
            lastPrice: s.lastPrice,
            priceChangePercent: s.priceChangePercent,
            quoteVolume: s.quoteVolume,
            confidence: cached?.confidence || 35,
            regime: cached?.regime || "MIXED",
            strategy: cached?.strategy || "RSI_CROSS",
          };
        }),
      );

      const totalVolume = coinData.reduce((sum, c) => sum + c.quoteVolume, 0);
      const avgChange = coinData.length > 0
        ? coinData.reduce((sum, c) => sum + c.priceChangePercent, 0) / coinData.length
        : 0;
      const gainers = coinData.filter((c) => c.priceChangePercent > 0).length;
      const losers = coinData.filter((c) => c.priceChangePercent < 0).length;
      const globalRegime = await this.redisService.get<string>("cache:ai:regime") || "MIXED";

      // Determine sentiment
      let sentiment: string;
      if (avgChange > 3 && gainers > losers * 2) sentiment = "BULLISH";
      else if (avgChange < -3 && losers > gainers * 2) sentiment = "BEARISH";
      else if (Math.abs(avgChange) < 1) sentiment = "NEUTRAL";
      else sentiment = "MIXED";

      const topCoins = [...coinData].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 10);
      const topGainers = [...coinData].sort((a, b) => b.priceChangePercent - a.priceChangePercent).slice(0, 5);
      const topLosers = [...coinData].sort((a, b) => a.priceChangePercent - b.priceChangePercent).slice(0, 5);

      // Futures data
      const futuresData: any[] = [];
      for (const c of topCoins) {
        const fa = analytics.get(c.symbol);
        if (fa) futuresData.push({
          symbol: c.symbol,
          fundingRate: fa.fundingRate,
          openInterest: fa.openInterest,
          longPercent: fa.longPercent,
          shortPercent: fa.shortPercent,
          takerBuyRatio: fa.takerBuyRatio,
        });
      }

      // Warnings
      const warnings: string[] = [];
      for (const [sym, fa] of analytics) {
        if (Math.abs(fa.fundingRate) > 0.001) {
          warnings.push(`${sym.replace("USDT", "")} funding ${fa.fundingRate > 0 ? "cao" : "âm"} (${(fa.fundingRate * 100).toFixed(3)}%)`);
        }
        if (fa.longShortRatio > 2.5) {
          warnings.push(`${sym.replace("USDT", "")} quá nhiều Long (L/S ${fa.longShortRatio.toFixed(1)})`);
        }
      }

      // Build message
      const fmtVol = (v: number) =>
        v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` :
        v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e3).toFixed(0)}K`;
      const fmtPrice = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` :
        p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

      const sentimentEmoji = sentiment === "BULLISH" ? "🟢" : sentiment === "BEARISH" ? "🔴" : sentiment === "NEUTRAL" ? "⚪" : "🟡";

      let msg = `📊 *Báo Cáo Thị Trường Hàng Ngày*\n`;
      msg += `━━━━━━━━━━━━━━━━━━\n\n`;
      msg += `${sentimentEmoji} Xu hướng: *${sentiment}* | Regime: *${globalRegime}*\n`;
      msg += `📈 Tăng: *${gainers}* | 📉 Giảm: *${losers}* | TB: *${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(1)}%*\n`;
      msg += `💰 Tổng Vol: *${fmtVol(totalVolume)}* (${coinData.length} coins)\n\n`;

      msg += `🚀 *Top tăng:*\n`;
      for (const c of topGainers.slice(0, 3)) {
        msg += `  🟢 ${c.symbol.replace("USDT", "")} +${c.priceChangePercent.toFixed(1)}% (${fmtPrice(c.lastPrice)})\n`;
      }
      msg += `\n📉 *Top giảm:*\n`;
      for (const c of topLosers.slice(0, 3)) {
        msg += `  🔴 ${c.symbol.replace("USDT", "")} ${c.priceChangePercent.toFixed(1)}% (${fmtPrice(c.lastPrice)})\n`;
      }

      // High confidence coins
      const highConf = [...coinData].filter((c) => c.confidence >= 65).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
      if (highConf.length > 0) {
        msg += `\n🎯 *Confidence cao:*\n`;
        for (const c of highConf) {
          msg += `  • ${c.symbol.replace("USDT", "")} — ${c.confidence}% (${c.strategy})\n`;
        }
      }

      if (warnings.length > 0) {
        msg += `\n⚠️ *Cảnh báo:*\n`;
        for (const w of warnings.slice(0, 4)) {
          msg += `  • ${w}\n`;
        }
      }

      msg += `\n━━━━━━━━━━━━━━━━━━\n`;
      msg += `_${today} • Binance Futures_`;

      // Save to MongoDB
      await this.dailySnapshotModel.create({
        date: today,
        sentiment,
        globalRegime,
        totalVolume,
        avgChange,
        gainers,
        losers,
        coinCount: coinData.length,
        topCoins,
        futuresData,
        topGainers: topGainers.slice(0, 5),
        topLosers: topLosers.slice(0, 5),
        warnings,
        messageSent: msg,
      });

      // Broadcast to subscribers
      const subscribers = await this.subscriptionService.findAllActive();
      for (const sub of subscribers) {
        await this.telegramService.sendTelegramMessage(sub.chatId, msg);
      }

      this.logger.log(
        `[AiSignal] Daily snapshot saved: ${today} ${sentiment} (${gainers}↑/${losers}↓) → ${subscribers.length} subscribers`,
      );
    } catch (err) {
      this.logger.error(`[AiSignal] generateDailySnapshot error: ${err?.message}`);
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
    const cachedAnalytics = await this.futuresAnalyticsService.getCachedAnalytics();
    const fa = cachedAnalytics.get(symbol);
    if (fa) {
      let adj = 0;
      // Extreme funding: longs paying high fee → penalize LONG, boost SHORT
      const isTrend = params.regime === "STRONG_BULL" || params.regime === "STRONG_BEAR";
      if (fa.fundingRate > 0.001) adj += isTrend ? -5 : -10;
      else if (fa.fundingRate < -0.001) adj += isTrend ? -5 : -10;
      // Moderate funding confirmation
      else if (Math.abs(fa.fundingRate) < 0.0003) adj += 3;

      // L/S ratio: too many longs = squeeze risk for longs
      if (fa.longShortRatio > 2.5) adj -= 10;
      else if (fa.longShortRatio < 0.4) adj -= 10;

      // Taker buy/sell momentum — only boost confidence when momentum aligns with regime
      if (fa.takerBuyRatio > 1.3 && params.regime !== "STRONG_BEAR") adj += 5; // buy pressure, skip in bear regime
      else if (fa.takerBuyRatio < 0.7 && params.regime !== "STRONG_BULL") adj += 5; // sell pressure, skip in bull regime

      if (adj !== 0) {
        params.confidence = Math.max(10, Math.min(95, params.confidence + adj));
      }
    }

    // Cap minConfidenceToTrade per regime — in ranging/sideways markets Haiku sets thresholds
    // too high (55-65) while confidence is low (35-55), blocking all signals needlessly
    const regimeThresholdCap: Record<string, number> = {
      SIDEWAYS: 40,
      RANGE_BOUND: 48,
      MIXED: 50,
      VOLATILE: 55,
      BTC_CORRELATION: 55,
      STRONG_BULL: 60,
      STRONG_BEAR: 60,
    };
    const cap = regimeThresholdCap[params.regime] ?? 55;
    if (params.minConfidenceToTrade > cap) {
      params.minConfidenceToTrade = cap;
    }

    const signalResult = await this.ruleEngineService.evaluate(
      coin,
      currency,
      params,
    );
    if (!signalResult) return;

    // ── Global regime trend filter ──────────────────────────────────────────
    // STRONG_BEAR: only SHORT signals. STRONG_BULL: only LONG signals.
    // All other regimes (MIXED, SIDEWAYS, RANGE_BOUND, VOLATILE, BTC_CORRELATION) allow both.
    if (params.regime === "STRONG_BEAR" && signalResult.isLong) {
      this.logger.debug(
        `[AiSignal] ${coin.toUpperCase()} LONG skipped — regime STRONG_BEAR (shorts only)`,
      );
      return;
    }
    if (params.regime === "STRONG_BULL" && !signalResult.isLong) {
      this.logger.debug(
        `[AiSignal] ${coin.toUpperCase()} SHORT skipped — regime STRONG_BULL (longs only)`,
      );
      return;
    }

    // ── Per-coin 4h EMA trend alignment ─────────────────────────────────────
    // Block signals that go against the coin's own 4h trend, regardless of global regime.
    // Neutral zone (EMA21/EMA50 spread < 1.0%) = no clear trend → both directions allowed.
    // 1.0% threshold avoids over-filtering in RANGE_BOUND/SIDEWAYS markets where coins
    // drift slightly without a meaningful trend (was 0.3% — too sensitive, blocked ~50% of valid setups).
    try {
      const htf4hCloses = await this.indicatorService.getCloses(coin, "4h");
      if (htf4hCloses.length >= 55) {
        const ema21 = this.indicatorService.getEma(htf4hCloses, 21);
        const ema50 = this.indicatorService.getEma(htf4hCloses, 50);
        const spreadPct = (Math.abs(ema21.last - ema50.last) / ema50.last) * 100;

        if (spreadPct > 1.0) {
          const coinTrendUp = ema21.last > ema50.last;
          if (signalResult.isLong && !coinTrendUp) {
            this.logger.log(
              `[AiSignal] ${signalKey} LONG blocked — 4h downtrend (EMA21 < EMA50, spread=${spreadPct.toFixed(2)}%)`,
            );
            return;
          }
          if (!signalResult.isLong && coinTrendUp) {
            this.logger.log(
              `[AiSignal] ${signalKey} SHORT blocked — 4h uptrend (EMA21 > EMA50, spread=${spreadPct.toFixed(2)}%)`,
            );
            return;
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[AiSignal] Trend filter error for ${signalKey}: ${err?.message}`);
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
      const activeSignal =
        await this.signalQueueService.getActiveSignal(signalKey);
      if (activeSignal) {
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
    // SKIPPED — silent
    } finally {
      this.processingCoins.delete(lockKey);
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
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}* 🧪\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `${this.getProfileTag(signal)}\n` +
      `_${time} • Test mode_`;

    const subscribers = await this.subscriptionService.findAllActive();
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
    const axios = require("axios");
    let currentPrice: number;
    try {
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${signal.symbol}`,
        { timeout: 5000 },
      );
      currentPrice = parseFloat(res.data.price);
    } catch {
      return;
    }
    if (!currentPrice || currentPrice <= 0) return;

    const isLong = signal.direction === "LONG";

    // ─── Auto risk management ─────────────────────────────────────────────
    const pnlPct = isLong
      ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    // At >= 5% profit — raise SL to lock in 2% profit (trailing stop milestone, don't auto-close)
    if (pnlPct >= 5 && !(signal as any).sl5PctRaised) {
      const newSl = isLong
        ? signal.entryPrice * 1.02
        : signal.entryPrice * 0.98;
      await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), newSl);
      (signal as any).stopLossPrice = newSl;
      (signal as any).sl5PctRaised = true;
      this.logger.log(
        `[AiSignal] [TEST] 🚀 ${signal.symbol} SL raised to +2% (${newSl.toFixed(4)}) at ${pnlPct.toFixed(2)}% profit — still running`,
      );
      await this.notifySl5PctMilestone(signal.symbol, newSl, signal.direction);
    }

    // Move SL to entry (break-even) at >= 4% profit
    if (pnlPct >= 4 && !(signal as any).slMovedToEntry) {
      await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
      (signal as any).stopLossPrice = signal.entryPrice;
      (signal as any).slMovedToEntry = true;
      this.logger.log(
        `[AiSignal] [TEST] 🛡️ ${signal.symbol} SL moved to entry ${signal.entryPrice} (PnL: ${pnlPct.toFixed(2)}%)`,
      );
      // Notify subscribers of SL move
      await this.notifySlMovedToEntry(signal.symbol, signal.entryPrice);
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

    // Set cooldown to prevent ping-pong recreation (30 min)
    await this.redisService.set(
      `cache:ai:cooldown:${sigKey}`,
      true,
      30 * 60,
    );

    // Notify subscribers (only once — not every 30s)
    const fmtP = this.fmtPrice;
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    const icon = tpHit ? "🎯" : (pnl > 0 ? "🔒" : "🛑");
    const label = tpHit ? "Take Profit!" : (pnl > 0 ? "Trailing Stop - Co loi!" : "Stop Loss");
    const text =
      `${icon} *${signal.symbol} ${signal.direction} — ${label}* 🧪\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `Exit: ${fmtP(currentPrice)}\n` +
      `PnL: *${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%*\n\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
    }

    // Activate queued if any
    const queued = await this.signalQueueService.activateQueuedSignal(sigKey);
    if (queued) {
      await this.notifySignalTestMode(queued);
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
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `${this.getProfileTag(signal)}\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findAllActive();
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
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    const text =
      `${dirEmoji} *AI Signal — ${signal.symbol}* 📋${testLabel}\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${dirColor} *${signal.direction}*\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)}\n` +
      `SL: ${fmtP(signal.stopLossPrice)}\n\n` +
      `⏳ _Đang chờ — hết hạn ${hoursLeft.toFixed(1)}h_\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findAllActive();
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
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

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

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }
  }

  private async notifySlMovedToEntry(symbol: string, entryPrice: number): Promise<void> {
    const fmtP = this.fmtPrice;
    const text =
      `🛡️ *${symbol} — SL → Break-even*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Profit dat 4%, SL da chuyen ve gia entry ${fmtP(entryPrice)}\n` +
      `Bao ve loi nhuan, khong con rui ro!\n\n` +
      `_${new Date().toLocaleTimeString("vi-VN")}_`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
    }
  }

  private async notifySignalExpired(signal: AiSignalDocument): Promise<void> {
    const fmtP = this.fmtPrice;
    const hoursOpen = ((Date.now() - new Date(signal.generatedAt).getTime()) / 3600000).toFixed(1);
    const testMark = signal.isTestMode ? " 🧪" : "";

    // Fetch current price to show unrealized PnL at expiry
    let pnlLine = "";
    try {
      const axios = require("axios");
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${signal.symbol}`,
        { timeout: 5000 },
      );
      const currentPrice = parseFloat(res.data.price);
      if (currentPrice > 0) {
        const pnl = signal.direction === "LONG"
          ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
          : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;
        const pnlSign = pnl >= 0 ? "+" : "";
        pnlLine = `PnL: *${pnlSign}${pnl.toFixed(2)}%* (gia: ${fmtP(currentPrice)})\n`;
      }
    } catch { /* ignore */ }

    const text =
      `⏰ *${signal.symbol} ${signal.direction} — Het han${testMark}*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Lenh het han (${hoursOpen}h) ma chua dat TP/SL\n` +
      `Entry: ${fmtP(signal.entryPrice)}\n` +
      `TP: ${fmtP(signal.takeProfitPrice)} | SL: ${fmtP(signal.stopLossPrice)}\n` +
      pnlLine + `\n` +
      `_${new Date().toLocaleTimeString("vi-VN")}_`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
    }
  }

  private async notifySl5PctMilestone(symbol: string, newSl: number, direction: string): Promise<void> {
    const fmtP = this.fmtPrice;
    const dirLabel = direction === "LONG" ? "LONG" : "SHORT";
    const text =
      `🚀 *${symbol} ${dirLabel} — Trailing Stop +2%*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Profit dat 5%! SL da nang len +2% loi nhuan\n` +
      `SL moi: *${fmtP(newSl)}*\n` +
      `Lenh tiep tuc chay, dam bao loi toi thieu +2%\n\n` +
      `_${new Date().toLocaleTimeString("vi-VN")}_`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
    }
  }

  private async notifyPositionClosed(info: ResolvedSignalInfo): Promise<void> {
    const pnlSign = info.pnlPercent >= 0 ? "+" : "";
    const fmtP = this.fmtPrice;
    const time = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    let headerIcon: string;
    let headerLabel: string;
    if (info.closeReason === "TAKE_PROFIT") {
      headerIcon = "🎯";
      headerLabel = "Take Profit!";
    } else if (info.closeReason === "STOP_LOSS" && info.pnlPercent > 0) {
      // Trailing stop hit while profitable (5% milestone SL raise)
      headerIcon = "🔒";
      headerLabel = "Trailing Stop - Co loi!";
    } else if (info.closeReason === "STOP_LOSS") {
      headerIcon = "🛑";
      headerLabel = "Stop Loss";
    } else {
      headerIcon = info.pnlPercent >= 0 ? "🟢" : "🔴";
      headerLabel = "Da dong";
    }

    const text =
      `${headerIcon} *${info.symbol} ${info.direction} — ${headerLabel}*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Entry: ${fmtP(info.entryPrice)}\n` +
      `Exit: ${fmtP(info.exitPrice)}\n` +
      `PnL: *${pnlSign}${info.pnlPercent.toFixed(2)}%*\n\n` +
      `_${time}_`;

    const subscribers = await this.subscriptionService.findAllActive();
    for (const sub of subscribers) {
      await this.telegramService
        .sendTelegramMessage(sub.chatId, text)
        .catch(() => {});
    }

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

    for (const entry of shortlist) {
      const params = await this.redisService.get<any>(
        `cache:ai:params:${entry.symbol}`,
      );
      if (params) {
        results.push({
          symbol: entry.symbol,
          confidence: params.confidence || 0,
          regime: params.regime || "UNKNOWN",
          strategy: params.strategy || "N/A",
          lastPrice: entry.lastPrice || 0,
          quoteVolume: entry.quoteVolume || 0,
          priceChangePercent: entry.priceChangePercent || 0,
        });
      }
    }
    return results;
  }

  async generateMarketOverview(): Promise<string> {
    // Fire-and-forget: save daily snapshot if today's is missing
    this.generateDailySnapshot().catch(() => {});

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
