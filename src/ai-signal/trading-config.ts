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
  regimeTrailKeepRatio: Record<string, number>; // Per-regime trail keep ratio
  peakDecayAfterMin: number;  // Start peak decay after N min without new peak
  peakDecayPerHour: number;   // Decay ratio per hour

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
  gateSMCFVG: number;         // Min confidence for SMC_FVG (default 82)

  // ── Funding ──────────────────────────────────────────────────────────────
  fundingDirectionalBlock: number;  // Block directional if |funding| > this % (default 0.1)
  fundingExtremeBlock: number;      // Block entirely if |funding| > this % (default 0.3)

  // ── Filters ──────────────────────────────────────────────────────────────
  enabledStrategies: string;        // "disable:STRAT1,STRAT2" blacklist format (admin-managed)
  maxDailySignals: number;          // Daily cap (default 35)
  maxActiveSignals: number;         // Max concurrent positions (default 25)
  marketMomentumPnl: number;        // Block direction if avg PnL < this % (default -0.7)
  marketMomentumSLs: number;        // Require N SLs to confirm (default 2)
  positionImbalancePct: number;     // Block when X% in one direction (default 0.65)
  positionImbalanceMin: number;     // Min signals to apply imbalance filter (default 4)
  riskScoreThreshold: number;       // Block signal if risk score > threshold (default 55)

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

  // ── Sim Trading ──────────────────────────────────────────────────────
  simNotional: number;               // Simulated volume per trade (default 1000)
  simTakerFeePct: number;            // Taker fee % per side (default 0.04 = 0.04%)
  simMakerFeePct: number;            // Maker fee % per side (default 0.02 = 0.02%)
  simFundingEnabled: boolean;        // Apply funding fee in sim (default true)

  // ── Singapore Strategy Filters (toggle on/off) ──────────────────────
  opLineEnabled: boolean;            // Daily Open Price bias filter (default true)
  volumeAnalysisEnabled: boolean;    // Smart money vs retail volume (default true)
  srLevelEnabled: boolean;           // Support/Resistance level filter (default true)

  // ── On-Chain Filters (Binance futures data) ────────────────────────
  onChainFilterEnabled: boolean;     // Master switch (default true)
  onChainFundingRateEnabled: boolean; // Funding rate filter (default true)
  onChainFundingThreshold: number;   // FR extreme threshold % (default 0.05)
  onChainLongShortEnabled: boolean;  // Long/Short ratio contrarian (default true)
  onChainLongShortExtreme: number;   // Extreme L/S threshold % (default 60)
  onChainTakerFlowEnabled: boolean;  // Taker buy/sell flow (default true)
  onChainTakerBuyThreshold: number;  // Strong buy ratio (default 1.3)
  onChainTakerSellThreshold: number; // Strong sell ratio (default 0.7)
  onChainOIEnabled: boolean;         // Open Interest change (default true)
  onChainOIDropThreshold: number;    // OI drop % to block entry (default -5)
  onChainMarketSentimentEnabled: boolean; // Market-wide L/S check (default true)
  onChainMarketSentimentThreshold: number; // Block when crowd > X% one side (default 63)

  // ── OP + On-Chain Strategy ─────────────────────────────────────────────
  opOnchainEnabled: boolean;         // Enable OP_ONCHAIN strategy (default true)
  gateOpOnchain: number;             // Min confidence for OP_ONCHAIN (default 65)

  // Regime-adaptive SL/TP overrides (key = regime name)
  regimeSlTp: Record<string, { slMin: number; slMax: number; tpMin: number; tpMax: number; gridEnabled?: boolean }>;
}

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  // SL/TP
  slMin: 1.5, slMax: 2.5, tpMin: 3.0, tpMax: 3.0,
  tpRrMultiplier: 1.5, dcaTpPct: 3.0,

  // Trailing — match market amplitude (~2% avg peak)
  trailTrigger: 2.0, trailKeepRatio: 0.75,
  tpProximityLock: 0.5, tpBoostTrigger: 2.5, tpBoostExtend: 2.0, tpBoostCap: 6.0,

  // Dynamic trail keep ratio per regime (override trailKeepRatio)
  regimeTrailKeepRatio: {
    STRONG_BULL: 0.85, STRONG_BEAR: 0.85,
    MIXED: 0.75, RANGE_BOUND: 0.75, SIDEWAYS: 0.75,
    VOLATILE: 0.65,
  } as Record<string, number>,

  // Peak decay: after N minutes without new peak, decay ratio per hour
  peakDecayAfterMin: 120,   // Start decaying after 2h without new peak
  peakDecayPerHour: 0.35,   // Lose 35% of (peak - current) per hour

  // Confidence
  confidenceFloor: 65, confidenceFloorRanging: 65, confidenceFloorStrongBull: 80,
  regimeCaps: { SIDEWAYS: 70, RANGE_BOUND: 70, MIXED: 68, VOLATILE: 70, BTC_CORRELATION: 68, STRONG_BULL: 80, STRONG_BEAR: 72 },

  // Strategy gates
  gateEMAPullback: 78, gateTrendEMA: 80, gateStochEMAKDJ: 82, gateRSICross: 75, gateSMCFVG: 82,

  // Funding
  fundingDirectionalBlock: 0.1, fundingExtremeBlock: 0.3,

  // Filters
  enabledStrategies: '', maxDailySignals: 15, maxActiveSignals: 7,
  marketMomentumPnl: -0.7, marketMomentumSLs: 2,
  positionImbalancePct: 0.65, positionImbalanceMin: 4, riskScoreThreshold: 55,

  // Price position
  pricePositionBlockLong: 70, pricePositionBlockShort: 30,

  // Time stop
  timeStopHours: 12, timeStopPnlRange: 1.0,

  // DCA Grid — 4 levels to average down before hedge trigger
  gridLevelCount: 4, gridFillCooldownMin: 5,
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
  hedgePartialTriggerPct: 4.0,       // Trigger at -4% (was -3%, too sensitive to noise)
  hedgeFullTriggerPct: 4.0,        // Same as partial — always go FULL immediately
  hedgePartialSizeRatio: 1.0,      // Always 100% — partial was too weak
  hedgeFullSizeRatio: 1.0,
  hedgeTpPctTrend: 3.5,               // TP for trends
  hedgeTpPctVolatile: 4.0,            // TP for volatile
  hedgeTpPctDefault: 3.0,             // TP default (was 2.5, data shows room for more)
  hedgeSlImprovementRatio: 0.8,
  hedgeMaxCycles: 100,            // Unlimited — no SL for hedge, let it run
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

  // Sim Trading
  simNotional: 1000,       // Simulated volume per trade (match real tradingBalance)
  simTakerFeePct: 0.04,   // 0.04% per side (market orders — Binance standard)
  simMakerFeePct: 0.02,   // 0.02% per side (limit orders)
  simFundingEnabled: true, // Apply funding fee from Binance API

  // Singapore Strategy Filters
  opLineEnabled: false,          // Daily Open Price bias — DISABLED: redundant with EMA trend + on-chain
  volumeAnalysisEnabled: true,   // Smart money vs retail volume
  srLevelEnabled: true,          // Support/Resistance levels

  // On-Chain Filters (Binance futures data)
  onChainFilterEnabled: true,
  onChainFundingRateEnabled: true,
  onChainFundingThreshold: 0.05,   // 0.05% extreme
  onChainLongShortEnabled: true,
  onChainLongShortExtreme: 60,     // 60% = extreme
  onChainTakerFlowEnabled: true,
  onChainTakerBuyThreshold: 1.3,   // Strong buy
  onChainTakerSellThreshold: 0.7,  // Strong sell
  onChainOIEnabled: true,
  onChainOIDropThreshold: -5,      // -5% OI drop = avoid
  onChainMarketSentimentEnabled: true,
  onChainMarketSentimentThreshold: 63, // 63% crowd = extreme

  // OP + On-Chain Strategy
  opOnchainEnabled: true,
  gateOpOnchain: 65,

  // Regime-adaptive SL/TP — let winners run in trending, tight in sideways
  regimeSlTp: {
    STRONG_BULL: { slMin: 1.5, slMax: 2.5, tpMin: 4.0, tpMax: 6.0, gridEnabled: true },
    STRONG_BEAR: { slMin: 1.5, slMax: 2.5, tpMin: 4.0, tpMax: 6.0, gridEnabled: true },
    VOLATILE:    { slMin: 2.5, slMax: 3.5, tpMin: 3.0, tpMax: 4.5, gridEnabled: true },
    SIDEWAYS:    { slMin: 1.5, slMax: 2.0, tpMin: 1.5, tpMax: 2.5, gridEnabled: false },
    RANGE_BOUND: { slMin: 1.5, slMax: 2.0, tpMin: 1.5, tpMax: 2.5, gridEnabled: false },
  },
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
    // Hard floors — prevent config from setting destructive values
    const cfg = this.cached;
    if (cfg.hedgePartialTriggerPct < 2) cfg.hedgePartialTriggerPct = 2;
    if (cfg.hedgeFullTriggerPct < 2) cfg.hedgeFullTriggerPct = 2;
    return cfg;
  }

  /** Force load from Redis. */
  async load(): Promise<TradingConfig> {
    try {
      const stored = await this.redisService.get<Partial<TradingConfig>>(TRADING_CONFIG_KEY);
      if (stored) {
        // Merge stored over defaults — filter undefined to preserve defaults
        const clean = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined));
        this.cached = { ...DEFAULT_TRADING_CONFIG, ...clean };
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
    // Filter out undefined values to prevent overriding defaults
    const cleanPartial = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
    const merged = { ...current, ...cleanPartial };
    await this.redisService.set(TRADING_CONFIG_KEY, merged, TRADING_CONFIG_TTL);
    // Merge: defaults ← Redis ← clean (undefined doesn't override defaults)
    const cleanMerged = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    this.cached = { ...DEFAULT_TRADING_CONFIG, ...cleanMerged };
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
