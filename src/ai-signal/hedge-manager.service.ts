import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { TradingConfigService } from './trading-config';

export interface HedgeAction {
  action: 'OPEN_PARTIAL' | 'UPGRADE_FULL' | 'CLOSE_HEDGE' | 'NONE';
  hedgeDirection?: string;
  hedgeNotional?: number;
  hedgeTpPrice?: number;
  hedgePnlPct?: number;
  hedgePnlUsdt?: number;
  newSlPrice?: number;
  reason: string;
}

const LOCK_TTL_SECONDS = 30;
const HEDGE_LOCK_PREFIX = 'cache:hedge:lock:';
const MAX_SIGNAL_AGE_HOURS = 20;

@Injectable()
export class HedgeManagerService {
  private readonly logger = new Logger(HedgeManagerService.name);

  /** In-memory peak PnL tracking for hedge trailing stop */
  private hedgePeakMap = new Map<string, number>();

  constructor(
    private readonly redisService: RedisService,
    private readonly tradingConfig: TradingConfigService,
  ) {}

  /**
   * Called by PositionMonitor on every price tick for active signals.
   * Checks if hedge should be opened, upgraded, or closed.
   */
  async checkHedge(
    signal: any,
    currentPrice: number,
    pnlPct: number,
    regime: string,
  ): Promise<HedgeAction | null> {
    try {
      const cfg = this.tradingConfig.get();

      if (!cfg.hedgeEnabled) {
        return null;
      }

      const signalId = signal._id?.toString();
      if (!signalId) return null;

      // If hedge is already active, check for exit
      if (signal.hedgeActive) {
        return this.checkHedgeExit(signal, currentPrice);
      }

      // --- Pre-checks before opening a new hedge ---

      // Block in certain regimes
      if (cfg.hedgeBlockRegimes?.includes(regime)) {
        return null;
      }

      // Don't hedge if max cycles reached
      if ((signal.hedgeCycleCount || 0) >= cfg.hedgeMaxCycles) {
        return null;
      }

      // Don't hedge if signal is too old (near time-stop)
      if (signal.openedAt) {
        const ageMs = Date.now() - new Date(signal.openedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > MAX_SIGNAL_AGE_HOURS) {
          return null;
        }
      }

      // Cooldown check between hedge cycles
      if (signal.hedgeHistory?.length > 0) {
        const lastHedge = signal.hedgeHistory[signal.hedgeHistory.length - 1];
        if (lastHedge?.closedAt) {
          const elapsed = Date.now() - new Date(lastHedge.closedAt).getTime();
          const cooldownMs = cfg.hedgeCooldownMin * 60 * 1000;
          if (elapsed < cooldownMs) {
            return null;
          }
        }
      }

      // PnL not bad enough to hedge
      if (pnlPct > -cfg.hedgePartialTriggerPct) {
        return null;
      }

      // Acquire Redis lock to prevent double-trigger
      const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
      const acquired = await this.redisService.setNX(lockKey, 1, LOCK_TTL_SECONDS);
      if (!acquired) {
        return null;
      }

      const hedgeDirection = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
      const positionNotional = signal.simNotional || signal.notional || 0;

      if (positionNotional <= 0) {
        this.logger.warn(`[${signal.coin}] Cannot hedge: no notional found`);
        return null;
      }

      // Determine phase based on PnL severity
      if (pnlPct <= -cfg.hedgeFullTriggerPct) {
        // Full hedge
        const hedgeNotional = positionNotional * cfg.hedgeFullSizeRatio;
        const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

        this.logger.log(
          `[${signal.coin}] FULL HEDGE triggered | PnL: ${pnlPct.toFixed(2)}% | ` +
          `Direction: ${hedgeDirection} | Notional: $${hedgeNotional.toFixed(2)} | TP: ${hedgeTpPrice}`,
        );

        return {
          action: signal.hedgePhase === 'PARTIAL' ? 'UPGRADE_FULL' : 'OPEN_PARTIAL',
          hedgeDirection,
          hedgeNotional,
          hedgeTpPrice,
          reason: `PnL ${pnlPct.toFixed(2)}% hit full hedge threshold (-${cfg.hedgeFullTriggerPct}%)`,
        };
      }

      // Partial hedge (pnlPct is between -partialTrigger and -fullTrigger)
      const hedgeNotional = positionNotional * cfg.hedgePartialSizeRatio;
      const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

      this.logger.log(
        `[${signal.coin}] PARTIAL HEDGE triggered | PnL: ${pnlPct.toFixed(2)}% | ` +
        `Direction: ${hedgeDirection} | Notional: $${hedgeNotional.toFixed(2)} | TP: ${hedgeTpPrice}`,
      );

      return {
        action: 'OPEN_PARTIAL',
        hedgeDirection,
        hedgeNotional,
        hedgeTpPrice,
        reason: `PnL ${pnlPct.toFixed(2)}% hit partial hedge threshold (-${cfg.hedgePartialTriggerPct}%)`,
      };
    } catch (err) {
      this.logger.error(
        `[${signal?.coin || 'UNKNOWN'}] checkHedge error: ${err.message}`,
        err.stack,
      );
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

    if (direction === 'LONG') {
      return +(entryPrice * (1 + tpPct / 100)).toFixed(6);
    } else {
      return +(entryPrice * (1 - tpPct / 100)).toFixed(6);
    }
  }

  /**
   * Check if hedge side should be closed (TP hit or trail).
   * Called when signal.hedgeActive === true.
   */
  checkHedgeExit(signal: any, currentPrice: number): HedgeAction | null {
    try {
      const cfg = this.tradingConfig.get();
      const signalId = signal._id?.toString();
      if (!signalId) return null;

      const hedgeEntry = signal.hedgeEntryPrice;
      const hedgeDir = signal.hedgeDirection;
      const hedgeQty = signal.hedgeQuantity || 0;
      const hedgeNotional = signal.hedgeSimNotional || (hedgeEntry * hedgeQty);

      if (!hedgeEntry || !hedgeDir) {
        return null;
      }

      // Calculate hedge PnL
      let hedgePnlPct: number;
      if (hedgeDir === 'LONG') {
        hedgePnlPct = ((currentPrice - hedgeEntry) / hedgeEntry) * 100;
      } else {
        hedgePnlPct = ((hedgeEntry - currentPrice) / hedgeEntry) * 100;
      }

      const hedgePnlUsdt = (hedgePnlPct / 100) * hedgeNotional;

      // Check TP hit
      if (signal.hedgeTpPrice) {
        const tpHit = hedgeDir === 'LONG'
          ? currentPrice >= signal.hedgeTpPrice
          : currentPrice <= signal.hedgeTpPrice;

        if (tpHit) {
          this.cleanupPeakTracking(signalId);

          const originalNotional = signal.simNotional || signal.notional || 0;
          const originalEntry = signal.entryPrice;
          const currentSl = signal.hedgeSafetySlPrice || signal.slPrice;
          const newSlPrice = this.calculateSlImprovement(
            hedgePnlUsdt,
            originalNotional,
            originalEntry,
            currentSl,
            signal.direction,
          );

          this.logger.log(
            `[${signal.coin}] Hedge TP HIT | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
            `SL improved: ${currentSl} → ${newSlPrice}`,
          );

          return {
            action: 'CLOSE_HEDGE',
            hedgePnlPct,
            hedgePnlUsdt,
            newSlPrice,
            reason: `Hedge TP hit at ${currentPrice}`,
          };
        }
      }

      // Trailing stop on hedge side
      const peakKey = signalId;
      const currentPeak = this.hedgePeakMap.get(peakKey) || 0;

      if (hedgePnlPct > currentPeak) {
        this.hedgePeakMap.set(peakKey, hedgePnlPct);
      }

      const peak = this.hedgePeakMap.get(peakKey) || 0;

      if (peak >= cfg.hedgeTrailTrigger) {
        const trailLevel = peak * cfg.hedgeTrailKeepRatio;

        if (hedgePnlPct <= trailLevel && hedgePnlPct > 0) {
          this.cleanupPeakTracking(signalId);

          const originalNotional = signal.simNotional || signal.notional || 0;
          const originalEntry = signal.entryPrice;
          const currentSl = signal.hedgeSafetySlPrice || signal.slPrice;
          const newSlPrice = this.calculateSlImprovement(
            hedgePnlUsdt,
            originalNotional,
            originalEntry,
            currentSl,
            signal.direction,
          );

          this.logger.log(
            `[${signal.coin}] Hedge TRAIL CLOSE | Peak: ${peak.toFixed(2)}% → Current: ${hedgePnlPct.toFixed(2)}% | ` +
            `PnL: $${hedgePnlUsdt.toFixed(2)} | SL improved: ${currentSl} → ${newSlPrice}`,
          );

          return {
            action: 'CLOSE_HEDGE',
            hedgePnlPct,
            hedgePnlUsdt,
            newSlPrice,
            reason: `Hedge trail stop: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`,
          };
        }
      }

      // Safety SL on hedge side (wide): if hedge PnL is deeply negative, cut it
      // Use the inverse of hedgeSafetySlPct as max loss tolerance for hedge
      if (hedgePnlPct <= -cfg.hedgeSafetySlPct) {
        this.cleanupPeakTracking(signalId);

        this.logger.warn(
          `[${signal.coin}] Hedge SAFETY SL | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)})`,
        );

        return {
          action: 'CLOSE_HEDGE',
          hedgePnlPct,
          hedgePnlUsdt,
          newSlPrice: undefined,
          reason: `Hedge safety SL hit: ${hedgePnlPct.toFixed(2)}% loss`,
        };
      }

      return null;
    } catch (err) {
      this.logger.error(
        `[${signal?.coin || 'UNKNOWN'}] checkHedgeExit error: ${err.message}`,
        err.stack,
      );
      return null;
    }
  }

  /**
   * Calculate SL improvement after closing a profitable hedge.
   * Returns the new (improved) SL price.
   *
   * Formula:
   *   slImprovement = hedgePnlUsdt * hedgeSlImprovementRatio / originalNotional * entryPrice
   *   LONG:  newSL = oldSL + slImprovement
   *   SHORT: newSL = oldSL - slImprovement
   */
  calculateSlImprovement(
    hedgePnlUsdt: number,
    originalNotional: number,
    originalEntry: number,
    currentSl: number,
    direction: string,
  ): number {
    // Only improve SL if hedge was profitable
    if (hedgePnlUsdt <= 0 || originalNotional <= 0 || originalEntry <= 0) {
      return currentSl;
    }

    const cfg = this.tradingConfig.get();
    const slImprovement =
      (hedgePnlUsdt * cfg.hedgeSlImprovementRatio) / originalNotional * originalEntry;

    let newSl: number;
    if (direction === 'LONG') {
      newSl = currentSl + slImprovement;
      // Don't let improved SL exceed entry (would guarantee loss on close)
      newSl = Math.min(newSl, originalEntry * 0.998);
    } else {
      newSl = currentSl - slImprovement;
      // Don't let improved SL go below entry for SHORT
      newSl = Math.max(newSl, originalEntry * 1.002);
    }

    return +newSl.toFixed(6);
  }

  /**
   * Clean up in-memory peak tracking for a signal.
   * Called when hedge is closed.
   */
  private cleanupPeakTracking(signalId: string): void {
    this.hedgePeakMap.delete(signalId);
  }

  /**
   * Clean up all state for a signal (call when signal is fully closed).
   */
  async cleanupSignal(signalId: string): Promise<void> {
    this.cleanupPeakTracking(signalId);
    const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
    try {
      await this.redisService.delete(lockKey);
    } catch {
      // Ignore cleanup errors
    }
  }
}
