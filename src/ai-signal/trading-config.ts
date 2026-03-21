/**
 * Central Trading Configuration
 *
 * All trading thresholds in ONE place. Loaded from Redis on startup + every 5min.
 * Admin can update via /admin/trading-config endpoint → immediate effect.
 * Hardcoded values below are DEFAULTS only — Redis overrides take priority.
 *
 * Redis key: cache:ai:trading-config
 */

export interface TradingConfig {
  // ── SL / TP ──────────────────────────────────────────────────────────────
  slMin: number;              // Min SL % (default 1.5)
  slMax: number;              // Max SL % (default 2.5)
  tpMin: number;              // Min TP % (default 2.0)
  tpMax: number;              // Max TP % (default 3.0)
  tpRrMultiplier: number;     // TP ≥ SL × this (default 1.5)
  dcaTpPct: number;           // DCA TP recalc % from avgEntry (default 3.0)

  // ── Trailing Stop ────────────────────────────────────────────────────────
  trailTrigger: number;       // Move SL to BE at this % profit (default 2.0)
  trailKeepRatio: number;     // Keep this fraction of peak (default 0.75)
  tpProximityLock: number;    // Freeze trail within this % of TP (default 0.5)
  tpBoostTrigger: number;     // Boost TP at this % from entry (default 2.5)
  tpBoostExtend: number;      // Extend TP by this % on boost (default 2.0)
  tpBoostCap: number;         // Max TP after boost (default 4.0)

  // ── Confidence ───────────────────────────────────────────────────────────
  confidenceFloor: number;         // Base floor (default 63)
  confidenceFloorRanging: number;  // RANGE_BOUND/SIDEWAYS (default 67)
  confidenceFloorStrongBull: number; // STRONG_BULL (default 80)
  regimeCaps: Record<string, number>; // Per-regime ceiling

  // ── Strategy Gates ───────────────────────────────────────────────────────
  gateEMAPullback: number;    // Min confidence for EMA_PULLBACK (default 75)
  gateTrendEMA: number;       // Min confidence for TREND_EMA (default 70)
  gateStochEMAKDJ: number;    // Min confidence for STOCH_EMA_KDJ (default 82)
  gateRSICross: number;       // Min confidence for RSI_CROSS (default 75)

  // ── Funding ──────────────────────────────────────────────────────────────
  fundingDirectionalBlock: number;  // Block directional if |funding| > this % (default 0.1)
  fundingExtremeBlock: number;      // Block entirely if |funding| > this % (default 0.3)

  // ── Filters ──────────────────────────────────────────────────────────────
  maxDailySignals: number;          // Daily cap (default 35)
  maxActiveSignals: number;         // Max concurrent positions (default 25)
  marketMomentumPnl: number;        // Block direction if avg PnL < this % (default -0.7)
  marketMomentumSLs: number;        // Require N SLs to confirm (default 2)
  positionImbalancePct: number;     // Block when X% in one direction (default 0.65)
  positionImbalanceMin: number;     // Min signals to apply imbalance filter (default 4)

  // ── Price Position ───────────────────────────────────────────────────────
  pricePositionBlockLong: number;   // Block LONG above this % of range (default 70)
  pricePositionBlockShort: number;  // Block SHORT below this % of range (default 30)

  // ── Time Stop ────────────────────────────────────────────────────────────
  timeStopHours: number;            // Close stagnant signals after N hours (default 24)
  timeStopPnlRange: number;         // Only if PnL within ±this % (default 0.5)

  // ── DCA Grid ─────────────────────────────────────────────────────────────
  gridLevelCount: number;           // Number of DCA levels (default 5)
  gridFillCooldownMin: number;      // Minutes between fills (default 5)
  gridRsiLong: number;              // RSI < this for LONG DCA (default 45)
  gridRsiShort: number;             // RSI > this for SHORT DCA (default 55)

  // ── Market Guard (dynamic BTC) ───────────────────────────────────────────
  btcPanic24hPct: number;           // Pause ALL if BTC -X% in 24h (default -8)
  btcPanic4hPct: number;            // Pause ALL if BTC -X% in 4h + below EMA200 (default -4)
  btcBear4hPct: number;             // Block LONG if BTC -X% in 4h (default -2.5)
  btcBull4hPct: number;             // Lift restrictions if BTC +X% in 4h (default 1.5)
  btcBearRsi: number;               // Block LONG if below EMA200 + RSI < this (default 42)

  // ── Cooldowns ────────────────────────────────────────────────────────────
  marketCooldownMin: number;        // Pause after SL hits (default 30)
  maxSLBeforeCooldown: number;      // SL hits to trigger (default 3)

  // ── Auto-Tuner ───────────────────────────────────────────────────────────
  tunerLookbackDays: number;        // Rolling window (default 3)
  tunerMinTrades: number;           // Min trades to evaluate (default 8)
  tunerDisablePnl: number;          // Disable if PnL < this (default -15)
  tunerDisableRR: number;           // Disable if R:R < this (default 0.5)
  tunerReEnablePnl: number;         // Re-enable if last 5 PnL > this (default 10)
  tunerReEnableWR: number;          // Re-enable if last 5 WR ≥ this (default 60)

  // ── Auto-Hedge ─────────────────────────────────────────────────────────
  hedgeEnabled: boolean;              // Master switch (default false)
  hedgeSafetySlPct: number;           // Wide safety net SL % when hedge on (default 8.0)
  hedgePartialTriggerPct: number;     // Trigger partial (50%) at -X% (default 3.0)
  hedgeFullTriggerPct: number;        // Trigger full (100%) at -X% (default 5.0)
  hedgePartialSizeRatio: number;      // Partial hedge size (default 0.5)
  hedgeFullSizeRatio: number;         // Full hedge size (default 1.0)
  hedgeTpPctTrend: number;            // TP for trending regime (default 2.0)
  hedgeTpPctVolatile: number;         // TP for volatile regime (default 2.5)
  hedgeTpPctDefault: number;          // TP default (default 1.5)
  hedgeSlImprovementRatio: number;    // Fraction of profit → SL improvement (default 0.8)
  hedgeMaxCycles: number;             // Max cycles per signal (default 7)
  hedgeCooldownMin: number;           // Min minutes between cycles (default 5)
  hedgeTrailTrigger: number;          // Trail hedge TP trigger % (default 1.0)
  hedgeTrailKeepRatio: number;        // Keep this fraction of hedge peak (default 0.70)
  hedgeBlockRegimes: string[];        // Don't hedge in these regimes
  // ── Adaptive Hedge SL ──
  hedgeSlWidenPerWin: number;         // Widen safety SL by X% per winning cycle (default 2.0)
  hedgeSlTightenPerLoss: number;      // Tighten safety SL by X% per losing cycle (default 3.0)
  hedgeSlMaxPct: number;              // Max safety SL % (default 15.0)
  hedgeSlMinPct: number;              // Min safety SL % (default 5.0)
  hedgeMaxEffectiveLoss: number;      // Max effective loss in USDT after hedge profits (default 35)
  // ── Hedge Re-entry ──
  hedgeReEntryCooldownMin: number;    // Cooldown between cycles (default 5)
  hedgeMaxConsecutiveLosses: number;  // Stop after N consecutive losses (default 2)
  hedgeReEntryRsiLong: number;       // RSI threshold for LONG hedge re-entry (default 55)
  hedgeReEntryRsiShort: number;      // RSI threshold for SHORT hedge re-entry (default 45)

  // ── Sim Trading Fees ─────────────────────────────────────────────────
  simTakerFeePct: number;            // Taker fee % per side (default 0.05 = 0.05%)
  simMakerFeePct: number;            // Maker fee % per side (default 0.02 = 0.02%)
  simFundingEnabled: boolean;        // Apply funding fee in sim (default true)
}

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  // SL/TP
  slMin: 1.5, slMax: 2.5, tpMin: 2.0, tpMax: 3.0,
  tpRrMultiplier: 1.5, dcaTpPct: 3.0,

  // Trailing
  trailTrigger: 2.0, trailKeepRatio: 0.75,
  tpProximityLock: 0.5, tpBoostTrigger: 2.5, tpBoostExtend: 2.0, tpBoostCap: 4.0,

  // Confidence
  confidenceFloor: 63, confidenceFloorRanging: 67, confidenceFloorStrongBull: 80,
  regimeCaps: { SIDEWAYS: 70, RANGE_BOUND: 70, MIXED: 68, VOLATILE: 70, BTC_CORRELATION: 68, STRONG_BULL: 80, STRONG_BEAR: 72 },

  // Strategy gates
  gateEMAPullback: 78, gateTrendEMA: 70, gateStochEMAKDJ: 82, gateRSICross: 75,

  // Funding
  fundingDirectionalBlock: 0.1, fundingExtremeBlock: 0.3,

  // Filters
  maxDailySignals: 35, maxActiveSignals: 25,
  marketMomentumPnl: -0.7, marketMomentumSLs: 2,
  positionImbalancePct: 0.65, positionImbalanceMin: 4,

  // Price position
  pricePositionBlockLong: 70, pricePositionBlockShort: 30,

  // Time stop
  timeStopHours: 24, timeStopPnlRange: 0.5,

  // DCA Grid
  gridLevelCount: 3, gridFillCooldownMin: 5,
  gridRsiLong: 45, gridRsiShort: 55,

  // Market Guard
  btcPanic24hPct: -8, btcPanic4hPct: -4, btcBear4hPct: -2.5,
  btcBull4hPct: 1.5, btcBearRsi: 42,

  // Cooldowns
  marketCooldownMin: 30, maxSLBeforeCooldown: 3,

  // Auto-Tuner
  tunerLookbackDays: 3, tunerMinTrades: 8,
  tunerDisablePnl: -15, tunerDisableRR: 0.5,
  tunerReEnablePnl: 10, tunerReEnableWR: 60,

  // Auto-Hedge
  hedgeEnabled: true,
  hedgeSafetySlPct: 10.0,
  hedgePartialTriggerPct: 3.0,
  hedgeFullTriggerPct: 3.0,        // Same as partial — always go FULL immediately
  hedgePartialSizeRatio: 1.0,      // Always 100% — partial was too weak
  hedgeFullSizeRatio: 1.0,
  hedgeTpPctTrend: 3.5,               // TP for trends
  hedgeTpPctVolatile: 4.0,            // TP for volatile
  hedgeTpPctDefault: 3.0,             // TP default (was 2.5, data shows room for more)
  hedgeSlImprovementRatio: 0.8,
  hedgeMaxCycles: 7,              // Allow more cycles for sideways (vol scales: 100→75→50→50→50...)
  hedgeCooldownMin: 5,
  hedgeTrailTrigger: 1.0,
  hedgeTrailKeepRatio: 0.70,
  hedgeBlockRegimes: ["SIDEWAYS"],
  // Adaptive Hedge SL
  hedgeSlWidenPerWin: 2.0,
  hedgeSlTightenPerLoss: 3.0,
  hedgeSlMaxPct: 15.0,
  hedgeSlMinPct: 5.0,
  hedgeMaxEffectiveLoss: 80,
  // Hedge Re-entry
  hedgeReEntryCooldownMin: 5,
  hedgeMaxConsecutiveLosses: 2,
  hedgeReEntryRsiLong: 55,
  hedgeReEntryRsiShort: 45,

  // Sim Trading Fees
  simTakerFeePct: 0.05,   // 0.05% per side (market orders)
  simMakerFeePct: 0.02,   // 0.02% per side (limit orders)
  simFundingEnabled: true, // Apply funding fee from Binance API
};

const TRADING_CONFIG_KEY = "cache:ai:trading-config";
const TRADING_CONFIG_TTL = 0; // no expiry — persists until changed

/**
 * TradingConfigService — load/save config from Redis.
 * Injected into all services that need trading parameters.
 */
import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class TradingConfigService {
  private readonly logger = new Logger(TradingConfigService.name);
  private cached: TradingConfig = { ...DEFAULT_TRADING_CONFIG };
  private lastLoad = 0;

  constructor(private readonly redisService: RedisService) {
    // Load on startup after 5s
    setTimeout(() => this.load(), 5_000);
  }

  /** Get current config (cached in memory, refreshed every 5min from Redis). */
  get(): TradingConfig {
    // Refresh every 5min
    if (Date.now() - this.lastLoad > 5 * 60 * 1000) {
      this.load().catch(() => {});
    }
    return this.cached;
  }

  /** Force load from Redis. */
  async load(): Promise<TradingConfig> {
    try {
      const stored = await this.redisService.get<Partial<TradingConfig>>(TRADING_CONFIG_KEY);
      if (stored) {
        // Merge stored over defaults (allows partial overrides)
        this.cached = { ...DEFAULT_TRADING_CONFIG, ...stored };
        this.logger.log(`[TradingConfig] Loaded from Redis (${Object.keys(stored).length} overrides)`);
      } else {
        this.cached = { ...DEFAULT_TRADING_CONFIG };
      }
    } catch {
      this.cached = { ...DEFAULT_TRADING_CONFIG };
    }
    this.lastLoad = Date.now();
    return this.cached;
  }

  /** Save partial config update to Redis. Only saves changed fields. */
  async update(partial: Partial<TradingConfig>): Promise<TradingConfig> {
    const current = await this.redisService.get<Partial<TradingConfig>>(TRADING_CONFIG_KEY) || {};
    const merged = { ...current, ...partial };
    await this.redisService.set(TRADING_CONFIG_KEY, merged, TRADING_CONFIG_TTL);
    this.cached = { ...DEFAULT_TRADING_CONFIG, ...merged };
    this.lastLoad = Date.now();
    this.logger.log(`[TradingConfig] Updated: ${Object.keys(partial).join(", ")}`);
    return this.cached;
  }

  /** Get current config as stored in Redis (overrides only). */
  async getOverrides(): Promise<Partial<TradingConfig>> {
    return await this.redisService.get<Partial<TradingConfig>>(TRADING_CONFIG_KEY) || {};
  }

  /** Reset to defaults (remove all overrides). */
  async reset(): Promise<TradingConfig> {
    await this.redisService.delete(TRADING_CONFIG_KEY);
    this.cached = { ...DEFAULT_TRADING_CONFIG };
    this.lastLoad = Date.now();
    return this.cached;
  }
}
