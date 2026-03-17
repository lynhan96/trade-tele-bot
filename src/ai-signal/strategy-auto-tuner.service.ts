import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { RedisService } from "../redis/redis.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiReview, AiReviewDocument } from "../schemas/ai-review.schema";
import { TelegramBotService } from "../telegram/telegram.service";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";
import { TradingConfigService } from "./trading-config";

/**
 * StrategyAutoTuner — evaluates strategy performance every 4h and auto-disables
 * strategies with poor PnL/R:R. Results stored in Redis, checked by RuleEngine
 * before firing any strategy.
 *
 * Redis key: cache:strategy-gates → JSON { [strategyName]: { enabled, wr, pnlUsdt, reason, updatedAt } }
 *
 * Criteria to DISABLE a strategy:
 * - 10+ completed trades AND PnL USDT < -$20
 * - OR 10+ trades AND WR < 40%
 * - OR avg loss > 2× avg win (R:R < 0.5)
 *
 * Criteria to RE-ENABLE:
 * - Strategy was disabled but last 5 trades show positive PnL → re-enable (market changed)
 *
 * Admin can override via Redis: cache:strategy-override:{name} = "enable" | "disable"
 */

const STRATEGY_GATES_KEY = "cache:strategy-gates";
const COIN_BLACKLIST_KEY = "cache:coin-blacklist"; // Set<string> of blocked coins
const COIN_BLOCKED_AT_KEY = "cache:coin-blocked-at"; // Record<string, isoString> — when each coin was blocked
const MARKET_GUARD_KEY = "cache:ai:market-guard"; // auto market condition guard
const STRATEGY_GATES_TTL = 5 * 60 * 60; // 5h (re-evaluated every 4h)
const MARKET_GUARD_TTL = 35 * 60; // 35min (re-evaluated every 15min)
const MIN_TRADES_TO_EVALUATE = 8; // need at least 8 trades to judge
const MIN_COIN_TRADES = 1; // only 1 trade needed — a $20+ loss is enough signal
const LOOKBACK_DAYS = 3; // 3-day window — fast reaction to current market
const MIN_BLOCK_HOURS = 12; // minimum hours a coin stays blocked before re-evaluation


export interface MarketGuard {
  blockLong: boolean;
  blockShort: boolean;
  pauseAll: boolean;
  confidenceFloor: number; // dynamic override for confidence floor
  reason: string;
  btcPrice: number;
  regime: string;
  updatedAt: string;
}

interface StrategyGate {
  enabled: boolean;
  wr: number;
  pnlUsdt: number;
  avgWin: number;
  avgLoss: number;
  trades: number;
  reason: string;
  updatedAt: string;
}

@Injectable()
export class StrategyAutoTunerService {
  private readonly logger = new Logger(StrategyAutoTunerService.name);

  private readonly anthropic: Anthropic | null = null;

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiReview.name)
    private readonly aiReviewModel: Model<AiReviewDocument>,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly indicatorService: IndicatorService,
    private readonly configService: ConfigService,
    private readonly tradingConfig: TradingConfigService,
  ) {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (apiKey) this.anthropic = new Anthropic({ apiKey });
    // Run on startup after 30s delay
    setTimeout(() => {
      this.evaluateStrategies().catch(() => {});
      this.evaluateCoins().catch(() => {});
      this.evaluateMarketGuard().catch(() => {});
      // AI review on startup (60s delay for data to load)
      setTimeout(() => this.aiReviewStrategies().catch(() => {}), 30_000);
    }, 30_000);
  }

  /**
   * Get current strategy gates from Redis.
   * Returns map of strategy → gate info. Empty map = all enabled (no data yet).
   */
  async getGates(): Promise<Record<string, StrategyGate>> {
    const cached = await this.redisService.get<Record<string, StrategyGate>>(STRATEGY_GATES_KEY);
    return cached || {};
  }

  /**
   * Check if a specific strategy is enabled. Returns true if no gate exists (default enabled).
   */
  async isStrategyEnabled(strategy: string): Promise<boolean> {
    // Check admin override first
    const override = await this.redisService.get<string>(`cache:strategy-override:${strategy}`);
    if (override === "enable") return true;
    if (override === "disable") return false;

    const gates = await this.getGates();
    const gate = gates[strategy];
    if (!gate) return true; // no data = enabled by default
    return gate.enabled;
  }

  /**
   * Get current market guard from Redis.
   * Returns safe defaults (nothing blocked) if no guard set yet.
   */
  async getMarketGuard(): Promise<MarketGuard> {
    const guard = await this.redisService.get<MarketGuard>(MARKET_GUARD_KEY);
    return guard || {
      blockLong: false,
      blockShort: false,
      pauseAll: false,
      confidenceFloor: 63,
      reason: "No guard data",
      btcPrice: 0,
      regime: "UNKNOWN",
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Cron: evaluate market conditions every 15min and set market guard.
   * Auto-pauses or restricts signal direction based on BTC price + regime + recent perf.
   */
  // NOTE: Market Guard is now handled by AiMarketAnalystService (AI-driven).
  // This rule-based version is kept as fallback — runs only if AI analysis is missing.
  @Cron("0 */15 * * * *") // every 15min
  async evaluateMarketGuard(): Promise<void> {
    // Skip if AI Market Analyst has already set a guard (within last 20min)
    const aiAnalysis = await this.redisService.get<any>("cache:ai:market-analysis");
    if (aiAnalysis) {
      this.logger.debug("[MarketGuard] Skipping rule-based guard — AI analysis active");
      return;
    }
    try {
      // Get BTC price
      const btcRaw = await this.redisService.get<string | number>("price:BTCUSDT");
      const btcPrice = btcRaw ? parseFloat(String(btcRaw)) : 0;

      // Get BTC 4h candles for dynamic momentum scoring (already cached by MarketDataService)
      const btc4hCloses = await this.redisService.get<number[]>("cache:candle:close:BTC:4h");

      // Get regime + BTC context
      const regime = await this.redisService.get<string>("cache:ai:regime:global") || "MIXED";
      const btcCtx = await this.redisService.get<{ rsi: number; rsi4h: number; priceVsEma9: number; priceVsEma200: number }>("cache:ai:regime:btc-context");

      // Get recent performance
      const recentPerf = await this.redisService.get<any[]>("cache:ai:recent-perf") || [];

      const prevGuard = await this.getMarketGuard();

      let blockLong = false;
      let blockShort = false;
      let pauseAll = false;
      let confidenceFloor = 63;
      const reasons: string[] = [];

      // ── Rule 1: Dynamic BTC momentum — relative % moves, no hardcoded prices ─
      // Uses BTC candle data already cached in Redis to measure momentum
      if (btcPrice > 0 && btc4hCloses && btc4hCloses.length >= 2) {
        const prev4h = btc4hCloses[btc4hCloses.length - 2];
        const change4h = prev4h > 0 ? ((btcPrice - prev4h) / prev4h) * 100 : 0;

        // 24h change: compare last 6x 4h candles (= 24h ago)
        const prev24hIdx = Math.max(0, btc4hCloses.length - 7);
        const prev24h = btc4hCloses[prev24hIdx];
        const change24h = prev24h > 0 ? ((btcPrice - prev24h) / prev24h) * 100 : 0;

        // BTC below EMA200 = structural bear (from btcCtx)
        const belowEma200 = btcCtx ? (btcCtx.priceVsEma200 ?? 1) < 0 : false;
        const belowEma9   = btcCtx ? btcCtx.priceVsEma9 < -0.5 : false;

        if (change24h <= -8 || (change4h <= -4 && belowEma200)) {
          // Panic: -8% in 24h OR sharp dump -4% in 4h while below EMA200
          pauseAll = true;
          reasons.push(`BTC panic: 24h=${change24h.toFixed(1)}% 4h=${change4h.toFixed(1)}% belowEMA200=${belowEma200}`);
        } else if (change4h <= -2.5 || (belowEma200 && btcCtx && btcCtx.rsi < 42)) {
          // Bear: -2.5% in 4h OR structurally below EMA200 with RSI weak
          blockLong = true;
          confidenceFloor = 70;
          reasons.push(`BTC bear: 4h=${change4h.toFixed(1)}% belowEMA200=${belowEma200} RSI=${btcCtx?.rsi ?? '?'}`);
        } else if (change4h >= 1.5 && btcCtx && btcCtx.priceVsEma9 > 0.2) {
          // Bull momentum: +1.5% in 4h + above EMA9
          reasons.push(`BTC bull momentum: 4h=+${change4h.toFixed(1)}%`);
        }
      } else if (btcCtx) {
        // No candle data — fall back to indicator-only scoring
        const belowEma200 = (btcCtx.priceVsEma200 ?? 1) < 0;
        if (belowEma200 && btcCtx.rsi < 40 && (btcCtx.rsi4h ?? 50) < 40) {
          blockLong = true;
          confidenceFloor = 70;
          reasons.push(`BTC structural bear: below EMA200, RSI=${btcCtx.rsi}, RSI4h=${btcCtx.rsi4h}`);
        }
      }

      // ── Rule 2: Regime-based direction blocking ─────────────────────────────
      const isRanging = regime === "MIXED" || regime === "RANGE_BOUND" || regime === "SIDEWAYS";
      if (!pauseAll && isRanging && btcCtx) {
        // Compute directional score from BTC indicators
        let bearScore = 0;
        let bullScore = 0;

        if (btcCtx.rsi < 45) bearScore += 2;
        else if (btcCtx.rsi > 55) bullScore += 2;

        if ((btcCtx.rsi4h ?? 50) < 45) bearScore += 2;
        else if ((btcCtx.rsi4h ?? 50) > 55) bullScore += 2;

        if (btcCtx.priceVsEma9 < -0.3) bearScore += 1;
        else if (btcCtx.priceVsEma9 > 0.3) bullScore += 1;

        if ((btcCtx.priceVsEma200 ?? 0) < 0) bearScore += 1;
        else if ((btcCtx.priceVsEma200 ?? 0) > 0) bullScore += 1;

        if (bearScore >= 4) {
          blockLong = true;
          reasons.push(`${regime} + bearish score ${bearScore}/6 (RSI=${btcCtx.rsi}, RSI4h=${btcCtx.rsi4h})`);
        } else if (bullScore >= 4) {
          blockShort = true;
          reasons.push(`${regime} + bullish score ${bullScore}/6`);
        } else if (bearScore >= 3) {
          // Softer block: raise confidence floor instead
          confidenceFloor = 70;
          reasons.push(`${regime} + mild bear score ${bearScore}/6 → floor +7`);
        } else {
          // Unclear direction: raise floor in ranging regimes
          confidenceFloor = 70;
          reasons.push(`${regime} → confidence floor 70 (no clear direction)`);
        }
      }

      // ── Rule 3: Recent performance override ────────────────────────────────
      // If 3+ of last 5 completed trades are SL in same direction → block that direction for this cycle
      // Always add reason even if already blocked (needed for deadlock resolver)
      if (!pauseAll && recentPerf.length >= 3) {
        const recent5 = recentPerf.slice(-5);
        const longSLs = recent5.filter((p) => p.direction === "LONG" && p.closeReason === "STOP_LOSS" && (p.pnlPercent || 0) < 0).length;
        const shortSLs = recent5.filter((p) => p.direction === "SHORT" && p.closeReason === "STOP_LOSS" && (p.pnlPercent || 0) < 0).length;

        if (longSLs >= 3) {
          blockLong = true;
          reasons.push(`${longSLs}/5 recent LONG SLs — blocking LONG`);
        }
        if (shortSLs >= 3) {
          blockShort = true;
          reasons.push(`${shortSLs}/5 recent SHORT SLs — blocking SHORT`);
        }
      }

      // Prevent deadlock: if both directions blocked → only block the weaker direction
      // (allow the direction that indicators/regime favor)
      if (blockLong && blockShort && !pauseAll) {
        // Regime scoring already determined a preferred direction
        // Recent perf is short-term noise — regime scoring is more reliable
        // Keep the regime-based block, drop the recent-perf block
        if (reasons.some(r => r.includes("recent LONG SLs"))) {
          blockLong = false; // regime says bullish → allow LONG despite recent SLs
          confidenceFloor = Math.max(confidenceFloor, 72); // but raise bar
          reasons.push("deadlock resolved: allow LONG with higher floor");
        } else if (reasons.some(r => r.includes("recent SHORT SLs"))) {
          blockShort = false;
          confidenceFloor = Math.max(confidenceFloor, 72);
          reasons.push("deadlock resolved: allow SHORT with higher floor");
        } else {
          // Both from regime scoring — shouldn't happen, but fallback: allow both with high floor
          blockLong = false;
          blockShort = false;
          confidenceFloor = 75;
          reasons.push("deadlock resolved: both open with floor 75");
        }
      }

      const reason = reasons.join(" | ") || "Normal market";
      const guard: MarketGuard = {
        blockLong,
        blockShort,
        pauseAll,
        confidenceFloor,
        reason,
        btcPrice,
        regime,
        updatedAt: new Date().toISOString(),
      };

      await this.redisService.set(MARKET_GUARD_KEY, guard, MARKET_GUARD_TTL);

      // Notify admin on significant state changes
      const changed =
        prevGuard.blockLong !== blockLong ||
        prevGuard.blockShort !== blockShort ||
        prevGuard.pauseAll !== pauseAll;

      if (changed) {
        const icon = pauseAll ? "🛑" : (blockLong && blockShort) ? "⛔" : blockLong ? "🔴" : blockShort ? "🔵" : "🟢";
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `${icon} *Market Guard Update*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `${pauseAll ? "🛑 ALL signals PAUSED" : blockLong ? "🔴 LONG blocked" : blockShort ? "🔵 SHORT blocked" : "🟢 All directions open"}\n` +
          `Confidence floor: ${confidenceFloor}\n\n` +
          `_${reason}_\n\n` +
          `BTC: $${btcPrice.toLocaleString()} | Regime: ${regime}`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }

      this.logger.log(
        `[MarketGuard] pauseAll=${pauseAll} blockLong=${blockLong} blockShort=${blockShort} floor=${confidenceFloor} BTC=$${btcPrice.toLocaleString()} | ${reason}`,
      );
    } catch (err) {
      this.logger.error(`[MarketGuard] Error: ${err?.message}`);
    }
  }

  /**
   * Get blacklisted coins from Redis. Used by AiSignalService to skip coins.
   */
  async getCoinBlacklist(): Promise<Set<string>> {
    const list = await this.redisService.get<string[]>(COIN_BLACKLIST_KEY);
    return new Set(list || []);
  }

  /**
   * Cron: evaluate coin performance every 4 hours.
   * Blacklist criteria (2 layers):
   *
   * A. PnL-based (needs trade history):
   *    - 0% WR on 2+ trades
   *    - PnL < -$20 on 3+ trades
   *
   * B. Market-based (no history needed — catches bad coins before they trade):
   *    - Extreme funding rate: |funding| > 0.3% (crowded, manipulation risk)
   *    - ATR > 5% on 1h (too volatile — SL 3% is not enough)
   *    - Very low volume: < $30M 24h volume (easy to manipulate)
   *
   * Safe coins (BTC, ETH, SOL, BNB, XRP, ADA, DOT, LINK, AVAX) never blacklisted.
   */
  @Cron("0 5 */4 * * *") // every 4h, 5min offset from strategy eval
  async evaluateCoins(): Promise<void> {
    try {
      const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const signals = await this.aiSignalModel.find({
        status: "COMPLETED",
        createdAt: { $gte: lookbackDate },
      }).lean();

      const SAFE_COINS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOT", "LINK", "AVAX"]);

      // A. PnL-based blacklist
      const byCoin: Record<string, { w: number; l: number; usdt: number; winUsdt: number; lossUsdt: number }> = {};
      for (const s of signals) {
        const coin = ((s as any).symbol || "").replace("USDT", "");
        if (!coin || SAFE_COINS.has(coin)) continue;
        if (!byCoin[coin]) byCoin[coin] = { w: 0, l: 0, usdt: 0, winUsdt: 0, lossUsdt: 0 };
        const pnl = (s as any).pnlPercent || 0;
        const usdt = (s as any).pnlUsdt || (pnl / 100 * ((s as any).simNotional || 1000));
        if (usdt > 0) { byCoin[coin].w++; byCoin[coin].winUsdt += usdt; }
        else { byCoin[coin].l++; byCoin[coin].lossUsdt += usdt; }
        byCoin[coin].usdt += usdt;
      }

      const blacklist: string[] = [];
      const blacklistReasons: Record<string, string> = {};
      const prevBlacklist = await this.getCoinBlacklist();
      const blockedAt = await this.redisService.get<Record<string, string>>(COIN_BLOCKED_AT_KEY) || {};
      const changes: string[] = [];

      // Build map of most-recent trade per coin (for auto-unblock check)
      const lastTradeByCoin: Record<string, { pnlUsdt: number; createdAt: Date }> = {};
      for (const s of signals) {
        const coin = ((s as any).symbol || "").replace("USDT", "");
        if (!coin) continue;
        const ts = new Date((s as any).createdAt || 0);
        if (!lastTradeByCoin[coin] || ts > lastTradeByCoin[coin].createdAt) {
          const pnl = (s as any).pnlPercent || 0;
          const usdt = (s as any).pnlUsdt || (pnl / 100 * ((s as any).simNotional || 1000));
          lastTradeByCoin[coin] = { pnlUsdt: usdt, createdAt: ts };
        }
      }

      for (const [coin, d] of Object.entries(byCoin)) {
        const n = d.w + d.l;
        if (n < MIN_COIN_TRADES) continue;
        const wr = (d.w / n) * 100;

        // Block if: big loss, zero WR, negative PnL, or terrible R:R
        const avgWin = d.w > 0 ? d.winUsdt / d.w : 0;
        const avgLoss = d.l > 0 ? d.lossUsdt / d.l : 0;
        const rr = avgWin > 0 && d.l > 0 ? avgWin / Math.abs(avgLoss) : 99;
        const shouldBlock =
          (d.usdt < -20 && n >= 1) ||       // 1 trade losing $20+ is enough
          (wr === 0 && n >= 2) ||            // 2 trades, zero wins
          (d.usdt < -15 && n >= 2) ||        // 2 trades, combined $15+ loss
          (rr < 0.4 && n >= 3);              // 3+ trades, avg loss > 2.5× avg win

        if (!shouldBlock) continue;

        // Auto-unblock check: if coin was blocked 12h+ ago AND most recent trade is a WIN → skip re-block
        const blockedTime = blockedAt[coin] ? new Date(blockedAt[coin]).getTime() : 0;
        const hoursSinceBlock = (Date.now() - blockedTime) / (1000 * 60 * 60);
        const lastTrade = lastTradeByCoin[coin];
        if (
          prevBlacklist.has(coin) &&
          hoursSinceBlock >= MIN_BLOCK_HOURS &&
          lastTrade && lastTrade.pnlUsdt > 0
        ) {
          // Most recent trade is a win → market recovered → unblock
          this.logger.log(`[AutoTuner] ✅ ${coin} auto-unblocked: last trade +${lastTrade.pnlUsdt.toFixed(1)}$ (was blocked ${hoursSinceBlock.toFixed(0)}h ago)`);
          continue;
        }

        blacklist.push(coin);
        blacklistReasons[coin] = `WR=${wr.toFixed(0)}% PnL=${d.usdt.toFixed(0)}$ (${n} trades)`;
      }

      // B. Market-based blacklist (extreme funding, ATR too high)
      try {
        const analytics = await this.futuresAnalyticsService.getCachedAnalytics();
        for (const [symbol, fa] of analytics.entries()) {
          const coin = symbol.replace("USDT", "");
          if (SAFE_COINS.has(coin) || blacklist.includes(coin)) continue;

          // Extreme funding > 0.1% = crowded position, manipulation risk (was 0.3%)
          const fundingPct = Math.abs(fa.fundingRate * 100);
          if (fundingPct > 0.1) {
            blacklist.push(coin);
            blacklistReasons[coin] = `extreme funding ${(fa.fundingRate * 100).toFixed(3)}%`;
            continue;
          }
        }
      } catch {}

      // Deduplicate
      const uniqueBlacklist = [...new Set(blacklist)];

      // Track changes + update blockedAt timestamps
      const newBlockedAt = { ...blockedAt };
      for (const coin of uniqueBlacklist) {
        if (!prevBlacklist.has(coin)) {
          changes.push(`🚫 ${coin}: ${blacklistReasons[coin] || "market filter"}`);
          newBlockedAt[coin] = new Date().toISOString(); // record when newly blocked
        }
      }
      for (const coin of prevBlacklist) {
        if (!uniqueBlacklist.includes(coin)) {
          changes.push(`✅ ${coin} UNBLOCKED`);
          delete newBlockedAt[coin];
        }
      }

      await this.redisService.set(COIN_BLACKLIST_KEY, uniqueBlacklist, STRATEGY_GATES_TTL);
      await this.redisService.set(COIN_BLOCKED_AT_KEY, newBlockedAt, STRATEGY_GATES_TTL);

      this.logger.log(`[AutoTuner] Coin blacklist (${uniqueBlacklist.length}): ${uniqueBlacklist.length > 0 ? uniqueBlacklist.join(", ") : "(none)"}`);

      if (changes.length > 0) {
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `🪙 *Coin Auto-Blacklist*\n━━━━━━━━━━━━━━━━━━\n\n` +
          changes.join("\n") +
          `\n\n_${uniqueBlacklist.length} coins blocked / ${LOOKBACK_DAYS} ngày_`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }
    } catch (err) {
      this.logger.error(`[AutoTuner] Coin evaluation error: ${err?.message}`);
    }
  }

  /**
   * Cron: evaluate all strategies every 4 hours.
   */
  @Cron("0 0 */4 * * *") // every 4h
  async evaluateStrategies(): Promise<void> {
    try {
      const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      const signals = await this.aiSignalModel.find({
        status: "COMPLETED",
        createdAt: { $gte: lookbackDate },
        strategy: { $not: /^EXTERNAL_/ }, // don't evaluate external signals
      }).lean();

      if (signals.length < 5) {
        this.logger.log(`[AutoTuner] Only ${signals.length} signals in last ${LOOKBACK_DAYS}d — skipping evaluation`);
        return;
      }

      // Group by strategy
      const byStrategy: Record<string, typeof signals> = {};
      for (const s of signals) {
        const st = (s as any).strategy || "?";
        if (!byStrategy[st]) byStrategy[st] = [];
        byStrategy[st].push(s);
      }

      const gates: Record<string, StrategyGate> = {};
      const changes: string[] = [];
      const prevGates = await this.getGates();

      for (const [strategy, trades] of Object.entries(byStrategy)) {
        const n = trades.length;
        let wins = 0, losses = 0, winUsdt = 0, lossUsdt = 0;

        for (const t of trades) {
          const pnl = (t as any).pnlPercent || 0;
          const notional = (t as any).simNotional || 1000;
          const usdt = (t as any).pnlUsdt || (pnl / 100 * notional);
          if (pnl > 0) { wins++; winUsdt += usdt; }
          else { losses++; lossUsdt += usdt; }
        }

        const wr = n > 0 ? (wins / n) * 100 : 0;
        const totalUsdt = winUsdt + lossUsdt;
        const avgWin = wins > 0 ? winUsdt / wins : 0;
        const avgLoss = losses > 0 ? lossUsdt / losses : 0;

        let enabled = true;
        let reason = "OK";

        if (n >= MIN_TRADES_TO_EVALUATE) {
          // USDT-first disable criteria (profit matters more than WR)
          const rr = avgWin > 0 && losses > 0 ? avgWin / Math.abs(avgLoss) : 99;
          if (totalUsdt < -15) {
            enabled = false;
            reason = `PnL ${totalUsdt.toFixed(0)}$ < -$15 (${n} trades)`;
          } else if (rr < 0.5 && n >= 5) {
            enabled = false;
            reason = `R:R ${rr.toFixed(2)}:1 < 0.5 — avg loss $${Math.abs(avgLoss).toFixed(0)} > 2× avg win $${avgWin.toFixed(0)}`;
          } else if (wr < 35) {
            enabled = false;
            reason = `WR ${wr.toFixed(0)}% < 35% (${n} trades)`;
          }

          // Stricter re-enable: last 5 trades PnL > +$10 AND WR >= 60%
          if (!enabled) {
            const recent5 = trades.slice(-5);
            if (recent5.length >= 5) {
              const recent5Pnl = recent5.reduce((sum, t) => {
                const pnl = (t as any).pnlPercent || 0;
                return sum + ((t as any).pnlUsdt || (pnl / 100 * ((t as any).simNotional || 1000)));
              }, 0);
              const recent5Wins = recent5.filter(t => ((t as any).pnlUsdt || 0) > 0).length;
              const recent5Wr = (recent5Wins / recent5.length) * 100;
              if (recent5Pnl > 10 && recent5Wr >= 60) {
                enabled = true;
                reason = `Re-enabled: last 5 trades +${recent5Pnl.toFixed(0)}$ WR=${recent5Wr.toFixed(0)}%`;
              }
            }
          }
        } else {
          reason = `Insufficient data (${n}/${MIN_TRADES_TO_EVALUATE} trades)`;
        }

        gates[strategy] = {
          enabled,
          wr: Math.round(wr),
          pnlUsdt: Math.round(totalUsdt * 100) / 100,
          avgWin: Math.round(avgWin * 100) / 100,
          avgLoss: Math.round(avgLoss * 100) / 100,
          trades: n,
          reason,
          updatedAt: new Date().toISOString(),
        };

        // Track changes
        const wasEnabled = prevGates[strategy]?.enabled ?? true;
        if (wasEnabled && !enabled) {
          changes.push(`🔴 ${strategy} DISABLED: ${reason}`);
        } else if (!wasEnabled && enabled) {
          changes.push(`🟢 ${strategy} RE-ENABLED: ${reason}`);
        }
      }

      // Save to Redis
      await this.redisService.set(STRATEGY_GATES_KEY, gates, STRATEGY_GATES_TTL);

      // Log summary
      const enabledCount = Object.values(gates).filter(g => g.enabled).length;
      const disabledCount = Object.values(gates).filter(g => !g.enabled).length;
      this.logger.log(
        `[AutoTuner] Evaluated ${Object.keys(gates).length} strategies: ${enabledCount} enabled, ${disabledCount} disabled`,
      );

      for (const [st, g] of Object.entries(gates)) {
        const icon = g.enabled ? "✅" : "❌";
        this.logger.log(
          `[AutoTuner] ${icon} ${st.padEnd(22)} WR=${g.wr}% PnL=${g.pnlUsdt >= 0 ? "+" : ""}${g.pnlUsdt}$ avgW=${g.avgWin.toFixed(1)}$ avgL=${g.avgLoss.toFixed(1)}$ n=${g.trades} — ${g.reason}`,
        );
      }

      // Notify admin on changes
      if (changes.length > 0) {
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `📊 *Strategy Auto-Tuner*\n━━━━━━━━━━━━━━━━━━\n\n` +
          changes.join("\n") +
          `\n\n_Đánh giá ${signals.length} signals / ${LOOKBACK_DAYS} ngày_`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }
    } catch (err) {
      this.logger.error(`[AutoTuner] Error: ${err?.message}`);
    }
  }

  // ── AI Strategy Reviewer — Haiku reviews overall system every 4h ──────
  @Cron("0 30 */4 * * *") // every 4h at :30 (offset from evaluateStrategies)
  async aiReviewStrategies(): Promise<void> {
    if (!this.anthropic) return;

    try {
      const lookbackDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      // Gather context
      const signals = await this.aiSignalModel.find({
        status: "COMPLETED",
        createdAt: { $gte: lookbackDate },
      }).lean();

      if (signals.length < 5) {
        this.logger.log("[AIReview] Not enough data (<5 signals) — skipping");
        return;
      }

      // Strategy stats
      const stratStats: Record<string, { n: number; w: number; pnl: number; avgW: number; avgL: number }> = {};
      for (const s of signals) {
        const st = (s as any).strategy || "UNKNOWN";
        if (!stratStats[st]) stratStats[st] = { n: 0, w: 0, pnl: 0, avgW: 0, avgL: 0 };
        stratStats[st].n++;
        const pnl = (s as any).pnlUsdt || 0;
        stratStats[st].pnl += pnl;
        if (pnl > 0) { stratStats[st].w++; stratStats[st].avgW += pnl; }
        else stratStats[st].avgL += pnl;
      }
      for (const st of Object.keys(stratStats)) {
        const s = stratStats[st];
        s.avgW = s.w > 0 ? s.avgW / s.w : 0;
        s.avgL = (s.n - s.w) > 0 ? s.avgL / (s.n - s.w) : 0;
      }

      // Coin stats (top losers)
      const coinStats: Record<string, { n: number; pnl: number; w: number }> = {};
      for (const s of signals) {
        const coin = (s as any).symbol?.replace("USDT", "") || "?";
        if (!coinStats[coin]) coinStats[coin] = { n: 0, pnl: 0, w: 0 };
        coinStats[coin].n++;
        coinStats[coin].pnl += (s as any).pnlUsdt || 0;
        if (((s as any).pnlUsdt || 0) > 0) coinStats[coin].w++;
      }

      // Direction stats
      let longPnl = 0, longN = 0, longW = 0, shortPnl = 0, shortN = 0, shortW = 0;
      for (const s of signals) {
        const pnl = (s as any).pnlUsdt || 0;
        if ((s as any).direction === "LONG") { longPnl += pnl; longN++; if (pnl > 0) longW++; }
        else { shortPnl += pnl; shortN++; if (pnl > 0) shortW++; }
      }

      // Market context
      const guard = await this.getMarketGuard();
      const gates = await this.getGates();
      const blacklist = await this.getCoinBlacklist();
      const cfg = this.tradingConfig.get();

      // Recent 5 trades
      const recent = signals.slice(-5).map(s => ({
        symbol: (s as any).symbol, direction: (s as any).direction,
        strategy: (s as any).strategy, pnl: ((s as any).pnlUsdt || 0).toFixed(1),
        close: (s as any).closeReason,
      }));

      // Top 5 losing coins
      const topLosers = Object.entries(coinStats)
        .sort((a, b) => a[1].pnl - b[1].pnl)
        .slice(0, 5)
        .map(([coin, s]) => `${coin}: ${s.n} trades, ${s.w}W, $${s.pnl.toFixed(0)}`);

      const prompt = `You are a crypto futures trading system reviewer. Analyze the following 3-day performance data and return ONLY a JSON object with recommended actions.

STRATEGY PERFORMANCE (3 days):
${Object.entries(stratStats).map(([st, s]) => `${st}: ${s.n} trades, WR=${s.w}/${s.n} (${Math.round(s.w/s.n*100)}%), PnL=$${s.pnl.toFixed(0)}, avgWin=$${s.avgW.toFixed(0)}, avgLoss=$${s.avgL.toFixed(0)}`).join("\n")}

DIRECTION PERFORMANCE:
LONG: ${longN} trades, WR=${Math.round(longW/Math.max(longN,1)*100)}%, PnL=$${longPnl.toFixed(0)}
SHORT: ${shortN} trades, WR=${Math.round(shortW/Math.max(shortN,1)*100)}%, PnL=$${shortPnl.toFixed(0)}

TOP LOSING COINS: ${topLosers.join(" | ")}

MARKET: BTC=$${guard.btcPrice} regime=${guard.regime} RSI=${(await this.redisService.get<any>("cache:ai:regime:btc-context"))?.rsi ?? "?"}
Guard: blockLong=${guard.blockLong} blockShort=${guard.blockShort}
Current blacklist: [${[...blacklist].join(",")}]
Current config: tpMax=${cfg.tpMax}%, slMax=${cfg.slMax}%, confidenceFloor=${cfg.confidenceFloor}

RECENT 5 TRADES: ${JSON.stringify(recent)}

CURRENT STRATEGY GATES: ${JSON.stringify(Object.fromEntries(Object.entries(gates).map(([k,v]) => [k, {enabled: v.enabled, reason: v.reason}])))}

Rules:
- Disable strategy if: PnL < -$15 OR 0% WR on 2+ trades OR R:R < 0.4 (avgLoss > 2.5× avgWin)
- Re-enable if: was disabled but recent data shows recovery (WR>50% on 3+ recent trades)
- Blacklist coin if: 0% WR on 2+ trades OR single trade loss > $20 OR total PnL < -$20
- Adjust confidenceFloor: raise to 70+ if market uncertain, lower to 63 if trending clear
- Do NOT change tpMax or slMax unless data strongly supports it

Return ONLY valid JSON (no markdown, no explanation):
{
  "disableStrategies": ["STRATEGY_NAME"],
  "enableStrategies": ["STRATEGY_NAME"],
  "blacklistCoins": ["COIN"],
  "unblacklistCoins": ["COIN"],
  "confidenceFloor": 63,
  "reasoning": "brief explanation"
}`;

      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content[0] as any)?.text || "";
      this.logger.log(`[AIReview] Haiku response: ${text}`);

      // Parse JSON
      let actions: {
        disableStrategies?: string[];
        enableStrategies?: string[];
        blacklistCoins?: string[];
        unblacklistCoins?: string[];
        confidenceFloor?: number;
        reasoning?: string;
      };
      try {
        actions = JSON.parse(text);
      } catch {
        // Try to extract JSON from text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) actions = JSON.parse(jsonMatch[0]);
        else throw new Error("No valid JSON in response");
      }

      const appliedActions: string[] = [];

      // Apply strategy disables
      if (actions.disableStrategies?.length) {
        const currentGates = await this.getGates();
        for (const st of actions.disableStrategies) {
          if (currentGates[st]?.enabled !== false) {
            await this.redisService.set(`cache:strategy-override:${st}`, "disable", 5 * 60 * 60);
            appliedActions.push(`❌ Disabled ${st}`);
          }
        }
      }

      // Apply strategy enables
      if (actions.enableStrategies?.length) {
        for (const st of actions.enableStrategies) {
          await this.redisService.delete(`cache:strategy-override:${st}`);
          appliedActions.push(`✅ Enabled ${st}`);
        }
      }

      // Apply coin blacklist
      if (actions.blacklistCoins?.length) {
        const currentBl = await this.getCoinBlacklist();
        for (const coin of actions.blacklistCoins) {
          currentBl.add(coin.toUpperCase());
        }
        await this.redisService.set(COIN_BLACKLIST_KEY, [...currentBl], 0);
        appliedActions.push(`🚫 Blacklisted: ${actions.blacklistCoins.join(", ")}`);
      }

      // Apply coin unblacklist
      if (actions.unblacklistCoins?.length) {
        const currentBl = await this.getCoinBlacklist();
        for (const coin of actions.unblacklistCoins) {
          currentBl.delete(coin.toUpperCase());
        }
        await this.redisService.set(COIN_BLACKLIST_KEY, [...currentBl], 0);
        appliedActions.push(`✅ Unblacklisted: ${actions.unblacklistCoins.join(", ")}`);
      }

      // Apply confidence floor
      if (actions.confidenceFloor && actions.confidenceFloor !== cfg.confidenceFloor) {
        await this.tradingConfig.update({ confidenceFloor: actions.confidenceFloor });
        appliedActions.push(`📊 Confidence floor: ${cfg.confidenceFloor} → ${actions.confidenceFloor}`);
      }

      // Save to DB
      await this.aiReviewModel.create({
        type: "strategy_review",
        context: {
          strategyStats: stratStats,
          direction: { long: { n: longN, w: longW, pnl: longPnl }, short: { n: shortN, w: shortW, pnl: shortPnl } },
          topLosers,
          recent,
          currentGates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, { enabled: v.enabled, reason: v.reason }])),
          blacklist: [...blacklist],
        },
        prompt,
        rawResponse: text,
        actions,
        reasoning: actions.reasoning || "",
        appliedActions,
        signalsAnalyzed: signals.length,
        regime: guard.regime,
        btcPrice: guard.btcPrice,
        model: "claude-haiku-4-5",
      }).catch(e => this.logger.warn(`[AIReview] DB save error: ${e?.message}`));

      // Notify admin
      if (appliedActions.length > 0) {
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `🤖 *AI Strategy Review*\n━━━━━━━━━━━━━━━━━━\n\n` +
          appliedActions.join("\n") +
          `\n\n_${actions.reasoning || "No reasoning"}_` +
          `\n\n_${signals.length} signals analyzed / 3 days_`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
        this.logger.log(`[AIReview] Applied ${appliedActions.length} actions: ${appliedActions.join(", ")}`);
      } else {
        this.logger.log(`[AIReview] No changes recommended. Reasoning: ${actions.reasoning || "N/A"}`);
      }
    } catch (err) {
      this.logger.warn(`[AIReview] Error: ${err?.message}`);
    }
  }
}
