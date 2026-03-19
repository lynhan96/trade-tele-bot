import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisService } from '../redis/redis.service';
import { TradingConfigService } from './trading-config';
import { Order, OrderDocument } from '../schemas/order.schema';

export interface HedgeAction {
  action: 'OPEN_PARTIAL' | 'UPGRADE_FULL' | 'CLOSE_HEDGE' | 'ADJUST_SAFETY_SL' | 'NONE';
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
  reason: string;
}

const LOCK_TTL_SECONDS = 30;
const HEDGE_LOCK_PREFIX = 'cache:hedge:lock:';
const MAX_SIGNAL_AGE_HOURS = 48;

@Injectable()
export class HedgeManagerService {
  private readonly logger = new Logger(HedgeManagerService.name);
  private hedgePeakMap = new Map<string, number>();
  /** Track consecutive losses per signal for auto-stop */
  private consecutiveLossMap = new Map<string, number>();
  /** Track total banked profit per signal */
  private bankedProfitMap = new Map<string, number>();

  constructor(
    private readonly redisService: RedisService,
    private readonly tradingConfig: TradingConfigService,
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
          const cooldownMs = cfg.hedgeReEntryCooldownMin * 60 * 1000;
          if (elapsed < cooldownMs) return null;
        }
      }

      // Calculate banked profit from hedgeHistory (survives restart)
      const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

      // PnL not bad enough to hedge
      if (pnlPct > -cfg.hedgePartialTriggerPct) return null;

      // Acquire Redis lock
      const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
      const acquired = await this.redisService.setNX(lockKey, 1, LOCK_TTL_SECONDS);
      if (!acquired) return null;

      const hedgeDirection = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
      const positionNotional = signal.simNotional || signal.notional || 0;
      if (positionNotional <= 0) return null;

      // Determine phase based on PnL severity
      if (pnlPct <= -cfg.hedgeFullTriggerPct && signal.hedgePhase !== 'FULL') {
        const hedgeNotional = positionNotional * cfg.hedgeFullSizeRatio;
        const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

        this.logger.log(
          `[${signal.coin}] FULL HEDGE #${(signal.hedgeCycleCount || 0) + 1} | PnL: ${pnlPct.toFixed(2)}% | ` +
          `${hedgeDirection} $${hedgeNotional.toFixed(0)} | TP: ${hedgeTpPrice} | Banked: $${banked.toFixed(2)}`,
        );

        return {
          action: signal.hedgePhase === 'PARTIAL' ? 'UPGRADE_FULL' : 'OPEN_PARTIAL',
          hedgeDirection,
          hedgeNotional,
          hedgeTpPrice,
          bankedProfit: banked,
          hedgePhase: 'FULL',
          reason: `PnL ${pnlPct.toFixed(2)}% → full hedge #${(signal.hedgeCycleCount || 0) + 1}`,
        };
      }

      if (pnlPct <= -cfg.hedgePartialTriggerPct) {
        const hedgeNotional = positionNotional * cfg.hedgePartialSizeRatio;
        const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

        this.logger.log(
          `[${signal.coin}] PARTIAL HEDGE #${(signal.hedgeCycleCount || 0) + 1} | PnL: ${pnlPct.toFixed(2)}% | ` +
          `${hedgeDirection} $${hedgeNotional.toFixed(0)} | TP: ${hedgeTpPrice} | Banked: $${banked.toFixed(2)}`,
        );

        return {
          action: 'OPEN_PARTIAL',
          hedgeDirection,
          hedgeNotional,
          hedgeTpPrice,
          bankedProfit: banked,
          hedgePhase: 'PARTIAL',
          reason: `PnL ${pnlPct.toFixed(2)}% → partial hedge #${(signal.hedgeCycleCount || 0) + 1}`,
        };
      }

      return null;
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

      // ── 1. Recovery Close: main recovered past -1% → close hedge (no longer needed) ──
      if (mainPnlPct !== undefined && mainPnlPct > -1.0) {
        this.cleanupPeakTracking(signalId);
        // Use DB hedgeHistory for banked profit (survives restart)
        const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

        this.logger.log(
          `[${signal.coin}] Hedge RECOVERY CLOSE | Main recovered to ${mainPnlPct.toFixed(2)}% | ` +
          `Hedge PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | Banked: $${banked.toFixed(2)}`,
        );

        // Close hedge — profitable or not (main recovered, hedge no longer needed)
        if (hedgePnlUsdt > 0) {
          return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Recovery close: main ${mainPnlPct.toFixed(2)}%`);
        }
        return this.closeHedgeWithLoss(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
          `Recovery close: main ${mainPnlPct.toFixed(2)}%, hedge ${hedgePnlPct.toFixed(2)}%`);
      }

      // ── 2. Check TP hit ──
      if (signal.hedgeTpPrice) {
        const tpHit = hedgeDir === 'LONG'
          ? currentPrice >= signal.hedgeTpPrice
          : currentPrice <= signal.hedgeTpPrice;

        if (tpHit) {
          return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Hedge TP hit at ${currentPrice}`);
        }
      }

      // ── 3. Trailing stop on hedge side (only when profitable) ──
      const currentPeak = this.hedgePeakMap.get(signalId) || 0;
      if (hedgePnlPct > currentPeak) {
        this.hedgePeakMap.set(signalId, hedgePnlPct);
      }
      const peak = this.hedgePeakMap.get(signalId) || 0;

      if (peak >= cfg.hedgeTrailTrigger) {
        const trailLevel = peak * cfg.hedgeTrailKeepRatio;
        if (hedgePnlPct <= trailLevel && hedgePnlPct > 0) {
          return this.closeHedgeWithProfit(signal, signalId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Hedge trail: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`);
        }
      }

      // ── NO hedge SL — when hedge loses, main is recovering. Let it ride. ──

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
    this.cleanupPeakTracking(signalId);

    // Reset consecutive losses on win
    this.consecutiveLossMap.set(signalId, 0);

    // Bank the profit — use DB hedgeHistory (survives restart) + current profit
    const prevBanked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);
    const newBanked = prevBanked + Math.max(0, hedgePnlUsdt);
    this.bankedProfitMap.set(signalId, newBanked); // keep in-memory cache in sync

    // Calculate SL improvement
    const originalNotional = signal.simNotional || signal.notional || 0;
    const originalEntry = signal.entryPrice;
    const currentSl = signal.hedgeSafetySlPrice || signal.stopLossPrice;
    const newSlPrice = this.calculateSlImprovement(
      hedgePnlUsdt, originalNotional, originalEntry, currentSl, signal.direction,
    );

    // Widen safety SL on win (adaptive)
    const newSafetySlPrice = this.adjustSafetySlOnWin(signal, cfg, newBanked);

    this.logger.log(
      `[${signal.coin}] Hedge CLOSED PROFIT | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Banked total: $${newBanked.toFixed(2)} | SL: ${currentSl} → ${newSlPrice}` +
      (newSafetySlPrice ? ` | Safety SL widened → ${newSafetySlPrice}` : ''),
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSlPrice,
      newSafetySlPrice,
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
    this.cleanupPeakTracking(signalId);

    // Increment consecutive losses
    const prevLosses = this.consecutiveLossMap.get(signalId) || 0;
    const newLosses = prevLosses + 1;
    this.consecutiveLossMap.set(signalId, newLosses);

    const banked = (signal.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

    // Tighten safety SL on loss (adaptive)
    const newSafetySlPrice = this.adjustSafetySlOnLoss(signal, cfg);

    this.logger.warn(
      `[${signal.coin}] Hedge CLOSED LOSS | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Consecutive losses: ${newLosses} | Banked: $${banked.toFixed(2)}` +
      (newSafetySlPrice ? ` | Safety SL tightened → ${newSafetySlPrice}` : ''),
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSafetySlPrice,
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

  private cleanupPeakTracking(signalId: string): void {
    this.hedgePeakMap.delete(signalId);
  }

  async cleanupSignal(signalId: string): Promise<void> {
    this.cleanupPeakTracking(signalId);
    this.consecutiveLossMap.delete(signalId);
    this.bankedProfitMap.delete(signalId);
    const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
    try { await this.redisService.delete(lockKey); } catch {}
  }
}
