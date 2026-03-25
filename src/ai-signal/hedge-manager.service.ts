import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RSI } from 'technicalindicators';
import { RedisService } from '../redis/redis.service';
import { TradingConfigService } from './trading-config';
import { MarketDataService } from '../market-data/market-data.service';
import { Order, OrderDocument } from '../schemas/order.schema';

export interface HedgeAction {
  action: 'OPEN_FULL' | 'OPEN_PARTIAL' | 'UPGRADE_FULL' | 'CLOSE_HEDGE' | 'ADJUST_SAFETY_SL' | 'NONE';
  hedgeDirection?: string;
  hedgeNotional?: number;
  hedgeTpPrice?: number;
  hedgePnlPct?: number;
  hedgePnlUsdt?: number;
  newSlPrice?: number;
  newSafetySlPrice?: number;
  bankedProfit?: number;
  consecutiveLosses?: number;
  hedgePhase?: string;
  hedgeSlAtEntry?: boolean;
  hedgeTrailActivated?: boolean;
  reason: string;
}

const LOCK_TTL_SECONDS = 30;
const HEDGE_LOCK_PREFIX = 'cache:hedge:lock:';

@Injectable()
export class HedgeManagerService {
  private readonly logger = new Logger(HedgeManagerService.name);
  private consecutiveLossMap = new Map<string, number>();
  private bankedProfitMap = new Map<string, number>();
  /** In-memory cooldown timestamps — set on hedge close to prevent instant re-entry */
  private hedgeCooldownUntil = new Map<string, number>();
  /** Peak PnL tracking for trailing TP */
  private hedgePeakMap = new Map<string, number>();

  constructor(
    private readonly redisService: RedisService,
    private readonly tradingConfig: TradingConfigService,
    private readonly marketDataService: MarketDataService,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
  ) {}

  /**
   * Called by PositionMonitor on every price tick for active signals.
   * Handles: open new hedge, check exit, re-entry after banking profit.
   */
  async checkHedge(
    signal: any,
    currentPrice: number,
    pnlPct: number,
    regime: string,
  ): Promise<HedgeAction | null> {
    try {
      const cfg = this.tradingConfig.get();
      if (!cfg.hedgeEnabled) return null;

      const signalId = signal._id?.toString();
      if (!signalId) return null;

      // If hedge is already active, check for exit
      if (signal.hedgeActive) {
        return this.checkHedgeExit(signal, currentPrice);
      }

      // --- In-memory cooldown (survives stale signal object) ---
      const cooldownUntil = this.hedgeCooldownUntil.get(signalId);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        return null;
      }

      // --- Regime block ---
      if (cfg.hedgeBlockRegimes?.length > 0 && cfg.hedgeBlockRegimes.includes(regime)) {
        this.logger.debug(`[${signal.coin}] Hedge blocked by regime: ${regime}`);
        return null;
      }

      // Cooldown check between hedge cycles (prevent rapid re-entry whipsaw)
      if (signal.hedgeHistory?.length > 0) {
        const lastHedge = signal.hedgeHistory[signal.hedgeHistory.length - 1];
        if (lastHedge?.closedAt) {
          const elapsed = Date.now() - new Date(lastHedge.closedAt).getTime();
          // After breakeven close: 15min cooldown (was whipsawing)
          // After TP/other: normal 5min cooldown
          const isBreakeven = (lastHedge.reason || '').toLowerCase().includes('breakeven');
          const cooldownMin = isBreakeven ? 15 : cfg.hedgeReEntryCooldownMin;
          const cooldownMs = cooldownMin * 60 * 1000;
          if (elapsed < cooldownMs) {
            this.logger.debug(`[${signal.coin}] Hedge cooldown: ${Math.round((cooldownMs - elapsed) / 60000)}min remaining (${isBreakeven ? 'breakeven' : 'normal'})`);
            return null;
          }
        }
      }

      // Calculate banked profit from hedgeHistory (survives restart)
      const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

      // ── Entry conditions ──
      // PnL must be bad enough to hedge
      if (pnlPct > -cfg.hedgePartialTriggerPct) return null;

      // ── Momentum check (CYCLE 2+ ONLY) — cycle 1 enters immediately for protection ──
      // After FLIP: hedgeCycleCount=0 means first cycle for new direction → enter immediately
      const isFirstCycle = !signal.hedgeHistory?.length || (signal.hedgeCycleCount || 0) === 0;
      if (!isFirstCycle) {
        try {
          const coin = signal.coin || signal.symbol?.replace('USDT', '');
          const closes15m = await this.marketDataService.getClosePrices(coin, '15m');
          if (closes15m.length >= 5) {
            const last5 = closes15m.slice(-5);
            const moves: number[] = [];
            for (let i = last5.length - 3; i < last5.length; i++) {
              moves.push(last5[i] - last5[i - 1]);
            }
            const greenMoves = moves.filter(m => m > 0).length;
            const redMoves = moves.filter(m => m < 0).length;
            const bounceSize = Math.abs((last5[last5.length - 1] - last5[last5.length - 4]) / last5[last5.length - 4] * 100);
            const strongBounce = bounceSize > 1.0;

            if (signal.direction === 'LONG' && greenMoves >= 2 && strongBounce) {
              // silent skip — fires every tick
              return null;
            }
            if (signal.direction !== 'LONG' && redMoves >= 2 && strongBounce) {
              // silent skip — fires every tick
              return null;
            }
          }
        } catch (err) { /* proceed without check */ }
      }

      // Cycle 2+: stricter conditions — prevent blind re-entry
      // Skip FLIP_TP entries — they record main TP close, not real hedge exits
      const realHedges = (signal.hedgeHistory || []).filter((h: any) => h.reason !== 'FLIP_TP');
      if (realHedges.length > 0) {
        const lastHedge = realHedges[realHedges.length - 1];

        // 1. Price must be WORSE than last hedge exit (trend continuing)
        const lastExitPrice = lastHedge?.exitPrice || 0;
        if (lastExitPrice > 0) {
          const priceWorse = signal.direction === 'LONG'
            ? currentPrice < lastExitPrice  // LONG: price must be lower
            : currentPrice > lastExitPrice; // SHORT: price must be higher
          if (!priceWorse) {
            return null;
          }
        }

        // 2. PnL must be worse than trigger (not just at -3%, need momentum)
        if (pnlPct > -cfg.hedgePartialTriggerPct * 1.2) {
          return null;
        }

        // 3. Last hedge was breakeven close → price bounced → need deeper trigger
        if (lastHedge?.reason?.includes('breakeven')) {
          if (pnlPct > -cfg.hedgePartialTriggerPct * 1.5) {
            this.logger.debug(`[${signal.coin}] Hedge re-entry after breakeven: need PnL < -${(cfg.hedgePartialTriggerPct * 1.5).toFixed(1)}%`);
            return null;
          }
        }

        // 4. RSI momentum confirmation — 15m + 1h HTF
        // Main LONG → hedge SHORT: need RSI < 40 (bearish momentum continues)
        // Main SHORT → hedge LONG: need RSI > 60 (bullish momentum continues)
        try {
          const coin = signal.coin || signal.symbol?.replace('USDT', '');
          // 15m RSI
          const closes15m = await this.marketDataService.getClosePrices(coin, '15m');
          if (closes15m.length >= 14) {
            const rsiVals = RSI.calculate({ period: 14, values: closes15m });
            const rsi15m = rsiVals[rsiVals.length - 1];
            const rsiOk = signal.direction === 'LONG' ? rsi15m < 40 : rsi15m > 60;
            if (!rsiOk) {
              return null;
            }

            // 1h RSI confirmation
            const closes1h = await this.marketDataService.getClosePrices(coin, '1h');
            if (closes1h.length >= 14) {
              const rsiVals1h = RSI.calculate({ period: 14, values: closes1h });
              const rsi1h = rsiVals1h[rsiVals1h.length - 1];
              const htfOk = signal.direction === 'LONG' ? rsi1h < 45 : rsi1h > 55;
              if (!htfOk) {
                return null;
              }
            }

            this.logger.log(`[${coin}] Hedge re-entry RSI confirmed: 15m=${rsi15m.toFixed(1)} 1h OK`);
          }
        } catch (err) {
          this.logger.debug(`[${signal.coin}] RSI check failed, proceeding: ${err?.message}`);
        }
      }

      // Acquire Redis lock
      const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
      const acquired = await this.redisService.setNX(lockKey, 1, LOCK_TTL_SECONDS);
      if (!acquired) return null;

      const hedgeDirection = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
      const positionNotional = signal.simNotional || signal.notional || 0;
      if (positionNotional <= 0) return null;

      // Fixed 75% notional — consistent hedge size across all cycles
      const cycle = (signal.hedgeCycleCount || 0) + 1;
      const maxCycles = cfg.hedgeMaxCycles ?? 7;
      if (cycle > maxCycles) {
        this.logger.log(`[${signal.coin}] Hedge max cycles (${maxCycles}) reached — no more hedging`);
        return null;
      }
      const hedgeNotional = positionNotional * 0.75;
      const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

      this.logger.log(
        `[${signal.coin}] HEDGE #${cycle} (75%) | PnL: ${pnlPct.toFixed(2)}% | ` +
        `${hedgeDirection} $${hedgeNotional.toFixed(0)} | TP: ${hedgeTpPrice} | Banked: $${banked.toFixed(2)}`,
      );

      return {
        action: 'OPEN_FULL',
        hedgeDirection,
        hedgeNotional,
        hedgeTpPrice,
        bankedProfit: banked,
        hedgePhase: 'FULL',
        reason: `PnL ${pnlPct.toFixed(2)}% → hedge #${cycle} (75%)`,
      };
    } catch (err) {
      this.logger.error(`[${signal?.coin || '?'}] checkHedge error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Calculate hedge TP price based on regime.
   */
  getHedgeTpPrice(entryPrice: number, direction: string, regime: string): number {
    const cfg = this.tradingConfig.get();
    let tpPct: number;
    if (regime === 'STRONG_BULL' || regime === 'STRONG_BEAR') {
      tpPct = cfg.hedgeTpPctTrend;
    } else if (regime === 'VOLATILE') {
      tpPct = cfg.hedgeTpPctVolatile;
    } else {
      tpPct = cfg.hedgeTpPctDefault;
    }
    return direction === 'LONG'
      ? +(entryPrice * (1 + tpPct / 100)).toFixed(6)
      : +(entryPrice * (1 - tpPct / 100)).toFixed(6);
  }

  /**
   * Check if hedge side should be closed.
   * NO hedge SL — hedge only closes on: TP, trail, or main recovery.
   * When hedge is losing, main is recovering → no need to cut hedge.
   */
  checkHedgeExit(signal: any, currentPrice: number, mainPnlPct?: number): HedgeAction | null {
    try {
      const cfg = this.tradingConfig.get();
      const signalId = signal._id?.toString();
      if (!signalId) return null;

      const hedgeEntry = signal.hedgeEntryPrice;
      const hedgeDir = signal.hedgeDirection;
      const hedgeNotional = signal.hedgeSimNotional || 0;
      if (!hedgeEntry || !hedgeDir) return null;

      // Calculate hedge PnL
      const hedgePnlPct = hedgeDir === 'LONG'
        ? ((currentPrice - hedgeEntry) / hedgeEntry) * 100
        : ((hedgeEntry - currentPrice) / hedgeEntry) * 100;
      const hedgePnlUsdt = (hedgePnlPct / 100) * hedgeNotional;

      // NOTE: Net Positive Exit is handled in PositionMonitor.handlePriceTick (closes both hedge + main)
      // Do NOT duplicate here — PositionMonitor has full context to resolve the main signal.

      // ── 1. Recovery Close: ONLY when hedge has meaningful profit (>= 1.5%) ──
      // NEVER close hedge at a loss or tiny profit — let it ride to TP/trail/FLIP
      // ONDO lesson: repeated recovery-close cycles with small profits accumulated net losses
      // Stricter recovery: main must be > 1% (not just > 0) to avoid closing hedge on tiny recovery
      // OR hedge must be very profitable (> 2.5%) to justify closing regardless
      if (mainPnlPct !== undefined && ((mainPnlPct > 1.0 && hedgePnlPct >= 1.5) || hedgePnlPct >= 2.5) && mainPnlPct > 0) {
        const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);
        this.logger.log(
          `[${signal.coin}] Hedge RECOVERY CLOSE (profitable) | Main at +${mainPnlPct.toFixed(2)}% | ` +
          `Hedge PnL: +${hedgePnlPct.toFixed(2)}% (+$${hedgePnlUsdt.toFixed(2)}) | Banked: $${banked.toFixed(2)}`,
        );
        return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
          `Recovery close: main +${mainPnlPct.toFixed(2)}%`);
      }
      if (mainPnlPct !== undefined && mainPnlPct > 0) {
        this.logger.debug(`[${signal.coin}] Recovery skip: main +${mainPnlPct.toFixed(2)}% hedge +${hedgePnlPct.toFixed(2)}% — need main>1%+hedge≥1.5% or hedge≥2.5%`);
      }
      // Hedge losing → hold. Exits: trailing TP, NET_POSITIVE, FLIP (in PositionMonitor)

      // ── 2. Trailing TP — ride the trend ──
      // When hedge reaches TP level, don't close immediately — activate trail
      // Track peak PnL, close when pullback > 1% from peak
      if (signal.hedgeTpPrice) {
        const tpHit = hedgeDir === 'LONG'
          ? currentPrice >= signal.hedgeTpPrice
          : currentPrice <= signal.hedgeTpPrice;

        // Track peak PnL for trailing
        const currentPeak = this.hedgePeakMap.get(signalId) || 0;
        if (hedgePnlPct > currentPeak) {
          this.hedgePeakMap.set(signalId, hedgePnlPct);
        }
        const peak = this.hedgePeakMap.get(signalId) || 0;

        if (tpHit && !signal.hedgeTrailActivated) {
          // TP reached — activate trailing mode (one-time)
          this.logger.log(
            `[${signal.coin}] Hedge TRAIL activated | PnL: +${hedgePnlPct.toFixed(2)}% | Peak: ${peak.toFixed(2)}% | Riding trend...`,
          );
          return {
            action: 'NONE' as const,
            reason: `Hedge trail activated at +${hedgePnlPct.toFixed(2)}%`,
            hedgeSlAtEntry: true,
            hedgeTrailActivated: true,
          };
        }

        // Trail close: pullback > 1% from peak (only after trail activated or peak > TP%)
        if (peak >= (cfg.hedgeTpPctDefault || 3.0) && hedgePnlPct < peak - 1.0) {
          this.logger.log(
            `[${signal.coin}] Hedge TRAIL close | Peak: ${peak.toFixed(2)}% → Current: ${hedgePnlPct.toFixed(2)}% (pullback ${(peak - hedgePnlPct).toFixed(2)}%)`,
          );
          return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Hedge trail: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`);
        }
      }

      // ── Early trail: similar to main trail — activate at +2%, keep 70% of peak ──
      // Supplements TP trail (which rides trends further past TP level)
      if (hedgePnlPct >= 2.0 && !signal.hedgeTrailActivated) {
        const earlyPeak = this.hedgePeakMap.get(signalId) || 0;
        if (hedgePnlPct > earlyPeak) {
          this.hedgePeakMap.set(signalId, hedgePnlPct);
        }
        const peak = this.hedgePeakMap.get(signalId) || hedgePnlPct;
        const keepRatio = cfg.hedgeTrailKeepRatio || 0.70;
        const trailSl = peak * keepRatio;

        // Close when pullback drops below 70% of peak (min +1.0% profit)
        if (peak >= 2.5 && hedgePnlPct <= trailSl && hedgePnlPct >= 1.0) {
          this.logger.log(
            `[${signal.coin}] Hedge EARLY TRAIL close | Peak: ${peak.toFixed(2)}% → Current: ${hedgePnlPct.toFixed(2)}% (trail SL: ${trailSl.toFixed(2)}%)`,
          );
          return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Early trail: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`);
        }
      }

      // ── Hedge breakeven SL: when hedge profitable > 1.5%, move SL to +0.5% ──
      // Buffer: don't close at exact entry, keep 0.5% profit minimum
      if (hedgePnlPct >= 1.5 && !signal.hedgeSlAtEntry) {
        this.logger.log(
          `[${signal.coin}] Hedge SL → +0.5% (protected) | PnL: +${hedgePnlPct.toFixed(2)}%`,
        );
        return {
          action: 'NONE' as const,
          reason: `Hedge SL moved to +0.5% at +${hedgePnlPct.toFixed(2)}%`,
          hedgeSlAtEntry: true,
        };
      }

      // ── Hedge protected SL hit: price came back to +0.5% → close only if still profitable ──
      if (signal.hedgeSlAtEntry && hedgePnlPct <= 0.5 && hedgePnlUsdt >= 0) {
        this.logger.log(
          `[${signal.coin}] Hedge protected SL hit | PnL: +${hedgePnlPct.toFixed(2)}% → close with min profit`,
        );
        return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
          `Hedge protected SL: +${hedgePnlPct.toFixed(2)}%`);
      }
      // If protected SL hit but hedge is losing → reset protection, let it ride
      if (signal.hedgeSlAtEntry && hedgePnlPct < 0) {
        this.logger.log(
          `[${signal.coin}] Hedge protected SL skip — PnL ${hedgePnlPct.toFixed(2)}% losing → hold for TP/FLIP`,
        );
        return {
          action: 'NONE' as const,
          reason: `Hedge SL reset — PnL ${hedgePnlPct.toFixed(2)}% losing, hold`,
          hedgeSlAtEntry: false, // reset so it can re-activate later
        };
      }

      return null;
    } catch (err) {
      this.logger.error(`[${signal?.coin || '?'}] checkHedgeExit error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Close hedge with profit → bank profit → improve SL → potentially widen safety SL.
   */
  private closeHedgeWithProfit(
    signal: any, signalId: string,
    hedgePnlPct: number, hedgePnlUsdt: number,
    cfg: any, reason: string,
  ): HedgeAction {
    // Peak tracking cleaned up (no trail stop)

    // Reset consecutive losses on win
    this.consecutiveLossMap.set(signalId, 0);

    // Set in-memory cooldown + reset peak tracking
    const isBreakeven = reason.toLowerCase().includes('breakeven') || reason.toLowerCase().includes('protected');
    const cooldownMin = isBreakeven ? 15 : (cfg.hedgeReEntryCooldownMin || 5);
    this.hedgeCooldownUntil.set(signalId, Date.now() + cooldownMin * 60 * 1000);
    this.hedgePeakMap.delete(signalId);

    // Bank the profit — use DB hedgeHistory (survives restart) + current profit
    // Note: hedgePnlUsdt here is raw (no fees). Estimate fees for accurate banked total.
    const hedgeNotional = signal.hedgeSimNotional || 0;
    const feePct = (this.tradingConfig.get().simTakerFeePct || 0.05) / 100;
    const estimatedFees = hedgeNotional * feePct * 2; // entry + exit taker fees
    const netPnlUsdt = hedgePnlUsdt - estimatedFees;
    const prevBanked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);
    const newBanked = prevBanked + Math.max(0, netPnlUsdt);
    this.bankedProfitMap.set(signalId, newBanked); // keep in-memory cache in sync

    // Calculate SL improvement — use gridAvgEntry (post-DCA) not original entry
    const originalNotional = signal.simNotional || signal.notional || 0;
    const avgEntry = signal.gridAvgEntry || signal.entryPrice;
    const currentSl = signal.hedgeSafetySlPrice || signal.stopLossPrice;
    const newSlPrice = this.calculateSlImprovement(
      hedgePnlUsdt, originalNotional, avgEntry, currentSl, signal.direction,
    );

    this.logger.log(
      `[${signal.coin}] Hedge CLOSED PROFIT | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Banked total: $${newBanked.toFixed(2)} | SL stays 0 (hedge manages)`,
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSlPrice: 0, // SL stays disabled
      bankedProfit: newBanked,
      consecutiveLosses: 0,
      hedgePhase: signal.hedgePhase,
      reason,
    };
  }

  /**
   * Close hedge with loss → increment consecutive losses → tighten safety SL.
   */
  private closeHedgeWithLoss(
    signal: any, signalId: string,
    hedgePnlPct: number, hedgePnlUsdt: number,
    cfg: any, reason: string,
  ): HedgeAction {
    // Peak tracking cleaned up (no trail stop)

    // Set in-memory cooldown + reset peak tracking
    this.hedgeCooldownUntil.set(signalId, Date.now() + 15 * 60 * 1000);
    this.hedgePeakMap.delete(signalId);

    // Increment consecutive losses
    const prevLosses = this.consecutiveLossMap.get(signalId) || 0;
    const newLosses = prevLosses + 1;
    this.consecutiveLossMap.set(signalId, newLosses);

    const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

    this.logger.warn(
      `[${signal.coin}] Hedge CLOSED LOSS | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Consecutive losses: ${newLosses} | Banked: $${banked.toFixed(2)} | SL stays 0`,
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSlPrice: 0, // SL stays disabled
      bankedProfit: banked,
      consecutiveLosses: newLosses,
      hedgePhase: signal.hedgePhase,
      reason,
    };
  }

  /**
   * Widen safety SL after profitable cycle (more room for next cycle).
   * Only widens if effective max loss stays within bounds.
   */
  private adjustSafetySlOnWin(signal: any, cfg: any, totalBanked: number): number | undefined {
    const entry = signal.entryPrice;
    if (!entry || !signal.hedgeSafetySlPrice) return undefined;

    const currentSafetyPct = Math.abs((signal.hedgeSafetySlPrice - entry) / entry * 100);
    const newSafetyPct = Math.min(currentSafetyPct + cfg.hedgeSlWidenPerWin, cfg.hedgeSlMaxPct);

    if (newSafetyPct <= currentSafetyPct) return undefined; // already at max

    // Check effective loss constraint
    const filledVol = this.getFilledVol(signal);
    const effectiveLoss = (newSafetyPct / 100) * filledVol - totalBanked;
    if (effectiveLoss > cfg.hedgeMaxEffectiveLoss) return undefined;

    // Calculate new safety SL price
    return signal.direction === 'LONG'
      ? +(entry * (1 - newSafetyPct / 100)).toFixed(6)
      : +(entry * (1 + newSafetyPct / 100)).toFixed(6);
  }

  /**
   * Tighten safety SL after losing cycle (reduce exposure).
   */
  private adjustSafetySlOnLoss(signal: any, cfg: any): number | undefined {
    const entry = signal.entryPrice;
    if (!entry || !signal.hedgeSafetySlPrice) return undefined;

    const currentSafetyPct = Math.abs((signal.hedgeSafetySlPrice - entry) / entry * 100);
    const newSafetyPct = Math.max(currentSafetyPct - cfg.hedgeSlTightenPerLoss, cfg.hedgeSlMinPct);

    if (newSafetyPct >= currentSafetyPct) return undefined; // already at min

    return signal.direction === 'LONG'
      ? +(entry * (1 - newSafetyPct / 100)).toFixed(6)
      : +(entry * (1 + newSafetyPct / 100)).toFixed(6);
  }

  /**
   * Calculate SL improvement after closing a profitable hedge.
   */
  calculateSlImprovement(
    hedgePnlUsdt: number,
    originalNotional: number,
    originalEntry: number,
    currentSl: number,
    direction: string,
  ): number {
    if (hedgePnlUsdt <= 0 || originalNotional <= 0 || originalEntry <= 0) {
      return currentSl;
    }

    const cfg = this.tradingConfig.get();
    const slImprovement = (hedgePnlUsdt * cfg.hedgeSlImprovementRatio) / originalNotional * originalEntry;

    let newSl: number;
    if (direction === 'LONG') {
      newSl = currentSl + slImprovement;
      newSl = Math.min(newSl, originalEntry * 0.998);
    } else {
      newSl = currentSl - slImprovement;
      newSl = Math.max(newSl, originalEntry * 1.002);
    }

    return +newSl.toFixed(6);
  }

  /** Get actual filled volume from grid levels */
  private getFilledVol(signal: any): number {
    const total = signal.simNotional || 1000;
    const grids = signal.gridLevels;
    if (grids?.length) {
      const filled = grids.reduce((sum: number, g: any) =>
        sum + (['FILLED', 'TP_CLOSED', 'SL_CLOSED'].includes(g.status) ? (g.simNotional || total * (g.volumePct / 100)) : 0), 0);
      return filled || total * 0.4;
    }
    return total * 0.4;
  }

  /** Get banked profit for a signal */
  getBankedProfit(signalId: string): number {
    return this.bankedProfitMap.get(signalId) || 0;
  }

  /** Get consecutive losses for a signal */
  getConsecutiveLosses(signalId: string): number {
    return this.consecutiveLossMap.get(signalId) || 0;
  }

  async cleanupSignal(signalId: string): Promise<void> {
    this.consecutiveLossMap.delete(signalId);
    this.bankedProfitMap.delete(signalId);
    this.hedgeCooldownUntil.delete(signalId);
    this.hedgePeakMap.delete(signalId);
    const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
    try { await this.redisService.delete(lockKey); } catch {}
  }
}
