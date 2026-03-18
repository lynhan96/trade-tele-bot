import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { TradingConfigService } from './trading-config';

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

      // --- Pre-checks before opening a new hedge ---

      // Block in certain regimes
      if (cfg.hedgeBlockRegimes?.includes(regime)) return null;

      // Don't hedge if max cycles reached
      if ((signal.hedgeCycleCount || 0) >= cfg.hedgeMaxCycles) return null;

      // Don't hedge if signal is too old
      if (signal.openedAt || signal.executedAt) {
        const openTime = signal.openedAt || signal.executedAt;
        const ageHours = (Date.now() - new Date(openTime).getTime()) / 3600000;
        if (ageHours > MAX_SIGNAL_AGE_HOURS) return null;
      }

      // Check consecutive losses — stop hedging if too many
      const consLosses = this.consecutiveLossMap.get(signalId) || 0;
      if (consLosses >= cfg.hedgeMaxConsecutiveLosses) {
        return null;
      }

      // Check effective max loss: don't widen further if banked profit can't cover
      const banked = this.bankedProfitMap.get(signalId) || 0;
      const filledVol = this.getFilledVol(signal);
      const currentSafetySlPct = signal.hedgeSafetySlPrice && signal.entryPrice
        ? Math.abs((signal.hedgeSafetySlPrice - signal.entryPrice) / signal.entryPrice * 100)
        : cfg.hedgeSafetySlPct;
      const effectiveLoss = (currentSafetySlPct / 100) * filledVol - banked;
      if (effectiveLoss > cfg.hedgeMaxEffectiveLoss) return null;

      // Cooldown check between hedge cycles
      if (signal.hedgeHistory?.length > 0) {
        const lastHedge = signal.hedgeHistory[signal.hedgeHistory.length - 1];
        if (lastHedge?.closedAt) {
          const elapsed = Date.now() - new Date(lastHedge.closedAt).getTime();
          const cooldownMs = cfg.hedgeReEntryCooldownMin * 60 * 1000;
          if (elapsed < cooldownMs) return null;
        }
      }

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
   * Supports: TP hit, trailing stop, hedge own SL, safety SL.
   */
  checkHedgeExit(signal: any, currentPrice: number): HedgeAction | null {
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

      // ── 1. Hedge own SL (tight: -1.5%) — cut quickly on reversal ──
      if (hedgePnlPct <= -cfg.hedgeOwnSlPct) {
        this.cleanupPeakTracking(signalId);
        // Track consecutive loss
        const consLosses = (this.consecutiveLossMap.get(signalId) || 0) + 1;
        this.consecutiveLossMap.set(signalId, consLosses);

        this.logger.warn(
          `[${signal.coin}] Hedge OWN SL | Loss: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
          `ConsecutiveLosses: ${consLosses}/${cfg.hedgeMaxConsecutiveLosses}`,
        );

        // Tighten safety SL on loss
        const newSafetySlPrice = this.adjustSafetySlOnLoss(signal, cfg);

        return {
          action: 'CLOSE_HEDGE',
          hedgePnlPct,
          hedgePnlUsdt,
          newSlPrice: undefined,
          newSafetySlPrice,
          bankedProfit: this.bankedProfitMap.get(signalId) || 0,
          consecutiveLosses: consLosses,
          hedgePhase: signal.hedgePhase,
          reason: `Hedge SL hit: ${hedgePnlPct.toFixed(2)}% (consLoss: ${consLosses})`,
        };
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

      // ── 3. Trailing stop on hedge side ──
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

    // Bank the profit
    const prevBanked = this.bankedProfitMap.get(signalId) || 0;
    const newBanked = prevBanked + Math.max(0, hedgePnlUsdt);
    this.bankedProfitMap.set(signalId, newBanked);

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
