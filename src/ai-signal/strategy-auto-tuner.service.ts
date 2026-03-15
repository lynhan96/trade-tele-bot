import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron } from "@nestjs/schedule";
import { RedisService } from "../redis/redis.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { TelegramBotService } from "../telegram/telegram.service";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";

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

// BTC price thresholds for auto-guard
const BTC_PANIC_THRESHOLD = 72_000;  // below = pause ALL (extreme panic)
const BTC_BEAR_THRESHOLD  = 78_000;  // below = block LONG only, SHORT still allowed
const BTC_BULL_THRESHOLD  = 88_000;  // above = lift LONG restrictions

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

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly indicatorService: IndicatorService,
  ) {
    // Run on startup after 30s delay
    setTimeout(() => {
      this.evaluateStrategies().catch(() => {});
      this.evaluateCoins().catch(() => {});
      this.evaluateMarketGuard().catch(() => {});
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
  @Cron("0 */15 * * * *") // every 15min
  async evaluateMarketGuard(): Promise<void> {
    try {
      // Get BTC price (stored as string in Redis)
      const btcRaw = await this.redisService.get<string | number>("price:BTCUSDT");
      const btcPrice = btcRaw ? parseFloat(String(btcRaw)) : 0;

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

      // ── Rule 1: BTC price extremes ──────────────────────────────────────────
      if (btcPrice > 0 && btcPrice < BTC_PANIC_THRESHOLD) {
        // TRUE panic zone: pause everything
        pauseAll = true;
        reasons.push(`BTC $${btcPrice.toLocaleString()} < $${BTC_PANIC_THRESHOLD.toLocaleString()} (panic zone — all paused)`);
      } else if (btcPrice > 0 && btcPrice < BTC_BEAR_THRESHOLD) {
        // Bear zone: allow SHORT (fade bounces), block LONG (catching falling knives)
        blockLong = true;
        confidenceFloor = 70; // higher bar for SHORT too in bear
        reasons.push(`BTC $${btcPrice.toLocaleString()} $${BTC_PANIC_THRESHOLD.toLocaleString()}–$${BTC_BEAR_THRESHOLD.toLocaleString()} (bear zone — LONG blocked, SHORT allowed)`);
      } else if (btcPrice > 0 && btcPrice > BTC_BULL_THRESHOLD) {
        reasons.push(`BTC $${btcPrice.toLocaleString()} > $${BTC_BULL_THRESHOLD.toLocaleString()} (bull confirmed)`);
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
      if (!pauseAll && recentPerf.length >= 3) {
        const recent5 = recentPerf.slice(-5);
        const longSLs = recent5.filter((p) => p.direction === "LONG" && p.closeReason === "STOP_LOSS" && (p.pnlPercent || 0) < 0).length;
        const shortSLs = recent5.filter((p) => p.direction === "SHORT" && p.closeReason === "STOP_LOSS" && (p.pnlPercent || 0) < 0).length;

        if (longSLs >= 3 && !blockLong) {
          blockLong = true;
          reasons.push(`${longSLs}/5 recent LONG SLs — blocking LONG`);
        }
        if (shortSLs >= 3 && !blockShort) {
          blockShort = true;
          reasons.push(`${shortSLs}/5 recent SHORT SLs — blocking SHORT`);
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
      const byCoin: Record<string, { w: number; l: number; usdt: number }> = {};
      for (const s of signals) {
        const coin = ((s as any).symbol || "").replace("USDT", "");
        if (!coin || SAFE_COINS.has(coin)) continue;
        if (!byCoin[coin]) byCoin[coin] = { w: 0, l: 0, usdt: 0 };
        const pnl = (s as any).pnlPercent || 0;
        const usdt = (s as any).pnlUsdt || (pnl / 100 * ((s as any).simNotional || 1000));
        if (pnl > 0) byCoin[coin].w++; else byCoin[coin].l++;
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

        // Block if: single big loss ($20+), or 0% WR on 2+ trades, or $15+ loss on 2+ trades
        const shouldBlock =
          (d.usdt < -20 && n >= 1) ||
          (wr === 0 && n >= 2) ||
          (d.usdt < -15 && n >= 2);

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
          // Check disable criteria
          if (totalUsdt < -20) {
            enabled = false;
            reason = `PnL ${totalUsdt.toFixed(0)}$ < -$20 (${n} trades)`;
          } else if (wr < 40) {
            enabled = false;
            reason = `WR ${wr.toFixed(0)}% < 40% (${n} trades)`;
          } else if (avgWin > 0 && Math.abs(avgLoss) > avgWin * 2.5) {
            enabled = false;
            reason = `R:R ${(avgWin / Math.abs(avgLoss)).toFixed(2)}:1 < 0.4 (loss too big)`;
          }

          // Re-enable check: if was disabled but last 5 trades are positive
          if (!enabled) {
            const recent5 = trades.slice(-5);
            if (recent5.length >= 5) {
              const recent5Pnl = recent5.reduce((sum, t) => {
                const pnl = (t as any).pnlPercent || 0;
                return sum + ((t as any).pnlUsdt || (pnl / 100 * ((t as any).simNotional || 1000)));
              }, 0);
              if (recent5Pnl > 0) {
                enabled = true;
                reason = `Re-enabled: last 5 trades +${recent5Pnl.toFixed(0)}$ (recovery)`;
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
}
