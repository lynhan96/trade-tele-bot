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
  hedgePeakPnlPct?: number;
  reason: string;
}

const LOCK_TTL_SECONDS = 3600;
const HEDGE_LOCK_PREFIX = 'cache:hedge:lock:';

/** Context object — decouples hedge logic from signal document.
 *  Sim builds from Order records, Real builds from UserTrade records. */
export interface HedgePositionContext {
  id: string;               // signalId (sim) or tradeId (real)
  symbol: string;
  coin: string;
  direction: string;         // MAIN direction
  entryPrice: number;        // Actual avg entry (order/trade, NOT signal)
  positionNotional: number;  // Actual filled notional
  hedgeActive: boolean;
  hedgeCycleCount: number;
  hedgeHistory: any[];
  hedgeEntryPrice?: number;
  hedgeDirection?: string;
  hedgeNotional?: number;
  hedgeTpPrice?: number;
  hedgeSlAtEntry?: boolean;
  hedgeTrailActivated?: boolean;
  hedgeSafetySlPrice?: number;
  hedgeOpenedAt?: Date;
  hedgePhase?: string;
  hedgePeakPnlPct?: number;
  stopLossPrice?: number;
  regime?: string;
  fundingRate?: number;
}

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
    ctx: HedgePositionContext,
    currentPrice: number,
    pnlPct: number,
    regime: string,
  ): Promise<HedgeAction | null> {
    try {
      const cfg = this.tradingConfig.get();
      if (!cfg.hedgeEnabled) return null;

      const ctxId = ctx.id;
      if (!ctxId) return null;

      // If hedge is already active, check for exit
      if (ctx.hedgeActive) {
        return this.checkHedgeExit(ctx, currentPrice, pnlPct);
      }

      // --- In-memory cooldown ---
      const cooldownUntil = this.hedgeCooldownUntil.get(ctxId);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        return null;
      }

      // --- Regime block ---
      if (cfg.hedgeBlockRegimes?.length > 0 && cfg.hedgeBlockRegimes.includes(regime)) {
        this.logger.debug(`[${ctx.coin}] Hedge blocked by regime: ${regime}`);
        return null;
      }

      // Cooldown check between hedge cycles
      if (ctx.hedgeHistory?.length > 0) {
        const lastHedge = ctx.hedgeHistory[ctx.hedgeHistory.length - 1];
        if (lastHedge?.closedAt) {
          const elapsed = Date.now() - new Date(lastHedge.closedAt).getTime();
          // After breakeven close: 15min cooldown (was whipsawing)
          // After TP/other: normal 5min cooldown
          const isBreakeven = (lastHedge.reason || '').toLowerCase().includes('breakeven');
          const cooldownMin = isBreakeven ? 15 : cfg.hedgeReEntryCooldownMin;
          const cooldownMs = cooldownMin * 60 * 1000;
          if (elapsed < cooldownMs) {
            this.logger.debug(`[${ctx.coin}] Hedge cooldown: ${Math.round((cooldownMs - elapsed) / 60000)}min remaining (${isBreakeven ? 'breakeven' : 'normal'})`);
            return null;
          }
        }
      }

      // Calculate banked profit from hedgeHistory (survives restart)
      const banked = (ctx.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

      // ── Agent Brain hedge intelligence ──
      let triggerPct = cfg.hedgePartialTriggerPct;
      try {
        const brain = await this.redisService.get<any>('cache:agent:brain');
        if (brain) {
          if ((brain.hedgeSkipCoins || []).includes(ctx.symbol)) {
            this.logger.log(`[${ctx.coin}] Hedge skip: agent đánh dấu hedge kém hiệu quả`);
            return null;
          }
          if (brain.hedgeTriggerSuggestion && brain.hedgeTriggerSuggestion > 0) {
            triggerPct = brain.hedgeTriggerSuggestion;
            this.logger.debug(`[${ctx.coin}] Hedge trigger điều chỉnh theo agent: ${triggerPct}% (vol=${brain.avgVolatility}%)`);
          }
          if (brain.drawdownMode === 'DEFENSIVE' && triggerPct > 2) {
            triggerPct = 2;
            this.logger.debug(`[${ctx.coin}] Hedge trigger giảm xuống 2% do DEFENSIVE mode`);
          }
        }
      } catch {}

      // ── Entry conditions ──
      // PnL must be bad enough to hedge
      if (pnlPct > -triggerPct) return null;
      this.logger.log(`[${ctx.coin}] Hedge entry check: PnL=${pnlPct.toFixed(2)}% trigger=-${triggerPct}% cycle=${ctx.hedgeCycleCount} price=${currentPrice}`);

      // ── Momentum check (CYCLE 2+ ONLY) — cycle 1 enters immediately for protection ──
      // After FLIP: hedgeCycleCount=0 means first cycle for new direction → enter immediately
      const isFirstCycle = !ctx.hedgeHistory?.length || (ctx.hedgeCycleCount || 0) === 0;
      if (!isFirstCycle) {
        try {
          const coin = ctx.coin || ctx.symbol?.replace('USDT', '');
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

            if (ctx.direction === 'LONG' && greenMoves >= 2 && strongBounce) {
              if (pnlPct > -triggerPct * 1.5) return null;
            }
            if (ctx.direction !== 'LONG' && redMoves >= 2 && strongBounce) {
              if (pnlPct > -triggerPct * 1.5) return null;
            }
          }
        } catch (err) { /* proceed without check */ }
      }

      // Cycle 2+: stricter conditions — prevent blind re-entry
      // Skip when isFirstCycle (after FLIP: hedgeCycleCount=0 → enter immediately for protection)
      // Skip FLIP_TP entries — they record main TP close, not real hedge exits
      const realHedges = (ctx.hedgeHistory || []).filter((h: any) => h.reason !== 'FLIP_TP');
      if (!isFirstCycle && realHedges.length > 0) {
        const lastHedge = realHedges[realHedges.length - 1];

        // 1. Price should be near or worse than last hedge exit
        // Allow small bounce (< 1%) if PnL still deeply negative (> 2x trigger)
        const lastExitPrice = lastHedge?.exitPrice || 0;
        if (lastExitPrice > 0) {
          const priceWorse = ctx.direction === 'LONG'
            ? currentPrice < lastExitPrice
            : currentPrice > lastExitPrice;
          if (!priceWorse && pnlPct > -triggerPct * 2) {
            return null;
          }
        }

        // 2. PnL must be worse than trigger * 1.2
        if (pnlPct > -cfg.hedgePartialTriggerPct * 1.2) {
          this.logger.log(`[${ctx.coin}] Hedge blocked: PnL ${pnlPct.toFixed(2)}% > -${(cfg.hedgePartialTriggerPct * 1.2).toFixed(2)}%`);
          return null;
        }

        // 3. Last hedge was breakeven close → price bounced → need deeper trigger
        if (lastHedge?.reason?.includes('breakeven')) {
          if (pnlPct > -cfg.hedgePartialTriggerPct * 1.5) {
            this.logger.debug(`[${ctx.coin}] Hedge re-entry after breakeven: need PnL < -${(cfg.hedgePartialTriggerPct * 1.5).toFixed(1)}%`);
            return null;
          }
        }

        // 4. RSI momentum confirmation — 15m + 1h HTF
        // Main LONG → hedge SHORT: need RSI < 40 (bearish momentum continues)
        // Main SHORT → hedge LONG: need RSI > 60 (bullish momentum continues)
        try {
          const coin = ctx.coin || ctx.symbol?.replace('USDT', '');
          // 15m RSI
          const closes15m = await this.marketDataService.getClosePrices(coin, '15m');
          if (closes15m.length >= 14) {
            const rsiVals = RSI.calculate({ period: 14, values: closes15m });
            const rsi15m = rsiVals[rsiVals.length - 1];
            // Relax RSI when PnL deeply negative (> 1.5x trigger)
            const rsiThresh = pnlPct < -triggerPct * 1.5 ? 45 : 40;
            const rsiOk = ctx.direction === 'LONG' ? rsi15m < rsiThresh : rsi15m > (100 - rsiThresh);
            if (!rsiOk) {
              this.logger.log(`[${ctx.coin}] Hedge blocked: RSI15m=${rsi15m.toFixed(1)} (need <${rsiThresh} for ${ctx.direction}) PnL=${pnlPct.toFixed(1)}%`);
              return null;
            }

            // 1h RSI confirmation — skip entirely when PnL > 1.5x trigger (urgent protection needed)
            if (pnlPct > -triggerPct * 1.5) {
              const closes1h = await this.marketDataService.getClosePrices(coin, '1h');
              if (closes1h.length >= 14) {
                const rsiVals1h = RSI.calculate({ period: 14, values: closes1h });
                const rsi1h = rsiVals1h[rsiVals1h.length - 1];
                const htfThresh = pnlPct < -triggerPct * 1.5 ? 50 : 45;
                const htfOk = ctx.direction === 'LONG' ? rsi1h < htfThresh : rsi1h > (100 - htfThresh);
                if (!htfOk) {
                  this.logger.log(`[${ctx.coin}] Hedge blocked: RSI1h=${rsi1h.toFixed(1)} (need <${htfThresh}) PnL=${pnlPct.toFixed(1)}%`);
                  return null;
                }
              }
            }

            (ctx as any)._lastRsi15m = rsi15m;
            this.logger.log(`[${coin}] Hedge re-entry RSI confirmed: 15m=${rsi15m.toFixed(1)} 1h OK`);
          }
        } catch (err) {
          this.logger.log(`[${ctx.coin}] RSI check FAILED — proceeding without RSI gate: ${err?.message}`);
        }
      }

      // Double-check: DB might already have an OPEN hedge (concurrent tick race)
      const existingHedge = await this.orderModel.findOne({
        signalId: ctxId, type: 'HEDGE', status: 'OPEN',
      }).lean();
      if (existingHedge) {
        this.logger.debug(`[${ctx.coin}] Hedge already OPEN in DB — skip duplicate open`);
        return null;
      }

      // Acquire Redis lock (TTL=1h, deleted on hedge close)
      const lockKey = `${HEDGE_LOCK_PREFIX}${ctxId}`;
      const acquired = await this.redisService.setNX(lockKey, 1, LOCK_TTL_SECONDS);
      if (!acquired) return null;

      const hedgeDirection = ctx.direction === 'LONG' ? 'SHORT' : 'LONG';
      // positionNotional pre-calculated by caller from Order/Trade records
      const positionNotional = ctx.positionNotional;
      if (positionNotional <= 0) return null;

      // Fixed 75% notional — consistent hedge size across all cycles
      const cycle = (ctx.hedgeCycleCount || 0) + 1;
      const maxCycles = cfg.hedgeMaxCycles ?? 999;
      if (cycle > maxCycles) {
        this.logger.log(`[${ctx.coin}] Hedge max cycles (${maxCycles}) reached — no more hedging`);
        return null;
      }
      const hedgeNotional = positionNotional * 0.75;
      const hedgeTpPrice = this.getHedgeTpPrice(currentPrice, hedgeDirection, regime);

      // Build entry note with conditions
      const rsiNote = (ctx as any)._lastRsi15m ? ` RSI15m=${(ctx as any)._lastRsi15m.toFixed(1)}` : '';
      const entryNote = isFirstCycle ? 'Cycle 1 (immediate)' : `Cycle ${cycle} (RSI+price confirmed${rsiNote})`;
      const reasonDetail = `PnL ${pnlPct.toFixed(2)}% | ${entryNote} | regime: ${regime} | banked: $${banked.toFixed(2)}`;

      this.logger.log(
        `[${ctx.coin}] HEDGE #${cycle} (75%) | PnL: ${pnlPct.toFixed(2)}% | ` +
        `${hedgeDirection} $${hedgeNotional.toFixed(0)} | TP: ${hedgeTpPrice} | ${entryNote} | Banked: $${banked.toFixed(2)}`,
      );

      return {
        action: 'OPEN_FULL',
        hedgeDirection,
        hedgeNotional,
        hedgeTpPrice,
        bankedProfit: banked,
        hedgePhase: 'FULL',
        reason: reasonDetail,
      };
    } catch (err) {
      this.logger.error(`[${ctx?.coin || '?'}] checkHedge error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Calculate hedge TP price based on regime.
   */
  getHedgeTpPrice(entryPrice: number, direction: string, regime: string): number {
    const cfg = this.tradingConfig.get();

    // Hedge TP = 65% of main TP from regime config (scale together)
    const regimeSlTp = cfg.regimeSlTp?.[regime];
    if (regimeSlTp) {
      const mainTpPct = (regimeSlTp.tpMin + regimeSlTp.tpMax) / 2;
      const tpPct = mainTpPct * 0.65;
      this.logger.debug(`[HedgeManager] Hedge TP from regime ${regime}: main avg ${mainTpPct.toFixed(1)}% × 0.65 = ${tpPct.toFixed(1)}%`);
      return direction === 'LONG'
        ? +(entryPrice * (1 + tpPct / 100)).toFixed(6)
        : +(entryPrice * (1 - tpPct / 100)).toFixed(6);
    }

    // Fallback: use fixed config values
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
  checkHedgeExit(ctx: HedgePositionContext, currentPrice: number, mainPnlPct?: number): HedgeAction | null {
    try {
      const cfg = this.tradingConfig.get();
      const ctxId = ctx.id;
      if (!ctxId) return null;

      // Minimum hedge age: don't evaluate exit until hedge is at least 30s old
      // Prevents instant-close from stale flags, cache race conditions, or tick spam
      if (ctx.hedgeOpenedAt) {
        const ageMs = Date.now() - new Date(ctx.hedgeOpenedAt).getTime();
        if (ageMs < 30_000) return null;
      }

      const hedgeEntry = ctx.hedgeEntryPrice;
      const hedgeDir = ctx.hedgeDirection;
      const hedgeNotional = ctx.hedgeNotional ?? 0;
      if (!hedgeEntry || !hedgeDir) return null;

      // Calculate hedge PnL
      const hedgePnlPct = hedgeDir === 'LONG'
        ? ((currentPrice - hedgeEntry) / hedgeEntry) * 100
        : ((hedgeEntry - currentPrice) / hedgeEntry) * 100;
      const hedgePnlUsdt = (hedgePnlPct / 100) * hedgeNotional;

      // NOTE: Net Positive Exit is handled in PositionMonitor.handlePriceTick (closes both hedge + main)
      // Do NOT duplicate here — PositionMonitor has full context to resolve the main signal.

      // ── 1. Recovery Close: soft recovery only ──
      // Main > 1.0% AND hedge >= 1.5% (both sides clearly profitable)
      // NOTE: No bankedTotal check here — total profit closing is handled by
      // NET_POSITIVE in position-monitor (net PnL > 3% of filledVol → close ALL)
      const softClose = mainPnlPct !== undefined && mainPnlPct > 1.0 && hedgePnlPct >= 1.5;
      if (softClose) {
        const reason = `Recovery soft: main +${mainPnlPct?.toFixed(2)}%`;
        this.logger.log(
          `[${ctx.coin}] Hedge RECOVERY CLOSE | ${reason} | ` +
          `Hedge PnL: +${hedgePnlPct.toFixed(2)}% (+$${hedgePnlUsdt.toFixed(2)})`,
        );
        return this.closeHedgeWithProfit(ctx, ctxId, hedgePnlPct, hedgePnlUsdt, cfg, reason);
      }
      if (mainPnlPct !== undefined && mainPnlPct > 0) {
        this.logger.debug(`[${ctx.coin}] Recovery skip: main +${mainPnlPct.toFixed(2)}% hedge +${hedgePnlPct.toFixed(2)}% — need main>1% + hedge≥1.5%`);
      }
      // Hedge losing or not covered enough → HOLD. Exits: HEDGE_TP+trail, NET_POSITIVE, FLIP

      // ── 2. Trailing TP — ride the trend ──
      // When hedge reaches TP level, don't close immediately — activate trail
      // Track peak PnL, close when pullback > 1% from peak
      const hedgeTpPrice = ctx.hedgeTpPrice;
      if (hedgeTpPrice) {
        const tpHit = hedgeDir === 'LONG'
          ? currentPrice >= hedgeTpPrice
          : currentPrice <= hedgeTpPrice;

        // Track peak PnL for trailing — persist to signal so it survives restart
        const currentPeak = this.hedgePeakMap.get(ctxId) || ctx.hedgePeakPnlPct || 0;
        if (hedgePnlPct > currentPeak) {
          this.hedgePeakMap.set(ctxId, hedgePnlPct);
        }
        const peak = this.hedgePeakMap.get(ctxId) || 0;

        if (tpHit && !ctx.hedgeTrailActivated) {
          // TP reached — activate trailing mode (one-time)
          this.logger.log(
            `[${ctx.coin}] Hedge TRAIL activated | PnL: +${hedgePnlPct.toFixed(2)}% | Peak: ${peak.toFixed(2)}% | Riding trend...`,
          );
          return {
            action: 'NONE' as const,
            reason: `Hedge trail activated at +${hedgePnlPct.toFixed(2)}%`,
            hedgeSlAtEntry: true,
            hedgeTrailActivated: true,
            hedgePeakPnlPct: this.hedgePeakMap.get(ctxId) || hedgePnlPct,
          };
        }

        // Trail close: pullback > 1% from peak (only after trail activated or peak > TP%)
        if (peak >= (cfg.hedgeTpPctDefault || 3.0) && hedgePnlPct < peak - 1.0) {
          this.logger.log(
            `[${ctx.coin}] Hedge TRAIL close | Peak: ${peak.toFixed(2)}% → Current: ${hedgePnlPct.toFixed(2)}% (pullback ${(peak - hedgePnlPct).toFixed(2)}%)`,
          );
          return this.closeHedgeWithProfit(ctx, ctxId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Hedge trail: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`);
        }
      }

      // ── Early trail: similar to main trail — activate at +2%, keep 70% of peak ──
      if (hedgePnlPct >= 2.0 && !ctx.hedgeTrailActivated) {
        const earlyPeak = this.hedgePeakMap.get(ctxId) || 0;
        if (hedgePnlPct > earlyPeak) {
          this.hedgePeakMap.set(ctxId, hedgePnlPct);
        }
        const peak = this.hedgePeakMap.get(ctxId) || hedgePnlPct;
        const keepRatio = cfg.hedgeTrailKeepRatio || 0.70;
        const trailSl = peak * keepRatio;

        if (peak >= 2.5 && hedgePnlPct <= trailSl && hedgePnlPct >= 1.0) {
          this.logger.log(
            `[${ctx.coin}] Hedge EARLY TRAIL close | Peak: ${peak.toFixed(2)}% → Current: ${hedgePnlPct.toFixed(2)}% (trail SL: ${trailSl.toFixed(2)}%)`,
          );
          return this.closeHedgeWithProfit(ctx, ctxId, hedgePnlPct, hedgePnlUsdt, cfg,
            `Early trail: peak ${peak.toFixed(2)}% → ${hedgePnlPct.toFixed(2)}%`);
        }
      }

      // ── Hedge breakeven SL: when hedge profitable > 1.5%, move SL to +0.5% ──
      // Buffer: don't close at exact entry, keep 0.5% profit minimum
      if (hedgePnlPct >= 1.5 && !ctx.hedgeSlAtEntry) {
        this.logger.log(
          `[${ctx.coin}] Hedge SL → +0.5% (protected) | PnL: +${hedgePnlPct.toFixed(2)}%`,
        );
        return {
          action: 'NONE' as const,
          reason: `Hedge SL moved to +0.5% at +${hedgePnlPct.toFixed(2)}%`,
          hedgeSlAtEntry: true,
        };
      }

      // ── Hedge protected SL hit: price came back to +0.5% → close only if still profitable ──
      if (ctx.hedgeSlAtEntry && hedgePnlPct <= 0.5 && hedgePnlUsdt >= 0) {
        this.logger.log(
          `[${ctx.coin}] Hedge protected SL hit | PnL: +${hedgePnlPct.toFixed(2)}% → close with min profit`,
        );
        return this.closeHedgeWithProfit(ctx, ctxId, hedgePnlPct, hedgePnlUsdt, cfg,
          `Hedge protected SL: +${hedgePnlPct.toFixed(2)}%`);
      }
      // If protected SL hit but hedge is losing → reset protection, let it ride
      if (ctx.hedgeSlAtEntry && hedgePnlPct < 0) {
        this.logger.log(
          `[${ctx.coin}] Hedge protected SL skip — PnL ${hedgePnlPct.toFixed(2)}% losing → hold for TP/FLIP`,
        );
        return {
          action: 'NONE' as const,
          reason: `Hedge SL reset — PnL ${hedgePnlPct.toFixed(2)}% losing, hold`,
          hedgeSlAtEntry: false, // reset so it can re-activate later
        };
      }

      // Return updated peak if changed (so caller can persist to DB)
      const finalPeak = this.hedgePeakMap.get(ctxId) || 0;
      if (finalPeak > (ctx.hedgePeakPnlPct || 0)) {
        return {
          action: 'NONE' as const,
          reason: `Peak updated: ${finalPeak.toFixed(2)}%`,
          hedgePeakPnlPct: finalPeak,
        };
      }

      return null;
    } catch (err) {
      this.logger.error(`[${ctx?.coin || '?'}] checkHedgeExit error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Close hedge with profit → bank profit → improve SL → potentially widen safety SL.
   */
  private closeHedgeWithProfit(
    ctx: HedgePositionContext, ctxId: string,
    hedgePnlPct: number, hedgePnlUsdt: number,
    cfg: any, reason: string,
  ): HedgeAction {
    // Peak tracking cleaned up (no trail stop)

    // Reset consecutive losses on win
    this.consecutiveLossMap.set(ctxId, 0);
    this.redisService.set(`cache:hedge:losses:${ctxId}`, 0, 86400).catch(() => {});

    // Release hedge lock so next cycle can acquire it
    const lockKey = `${HEDGE_LOCK_PREFIX}${ctxId}`;
    this.redisService.delete(lockKey).catch(() => {});

    // Set in-memory cooldown + reset peak tracking
    const isBreakeven = reason.toLowerCase().includes('breakeven') || reason.toLowerCase().includes('protected');
    const cooldownMin = isBreakeven ? 15 : (cfg.hedgeReEntryCooldownMin || 5);
    this.hedgeCooldownUntil.set(ctxId, Date.now() + cooldownMin * 60 * 1000);
    this.hedgePeakMap.delete(ctxId);

    const hedgeNotional = ctx.hedgeNotional || 0;
    const feePct = (this.tradingConfig.get().simTakerFeePct || 0.04) / 100;
    const estimatedFees = hedgeNotional * feePct * 2;
    const netPnlUsdt = hedgePnlUsdt - estimatedFees;
    const prevBanked = (ctx.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);
    const newBanked = prevBanked + Math.max(0, netPnlUsdt);
    this.bankedProfitMap.set(ctxId, newBanked);

    const originalNotional = ctx.positionNotional;
    const avgEntry = ctx.entryPrice;
    const currentSl = ctx.hedgeSafetySlPrice || ctx.stopLossPrice || 0;
    // Calculate SL improvement from hedge profit
    // During hedge, currentSl=0 so we can't use it as base.
    // Return improvement as newSafetySlPrice — position-monitor will use it
    // only if tighter than its own progressive SL calculation.
    const progressiveSlBase = ctx.direction === 'LONG'
      ? avgEntry * (1 - 40 / 100) // 40% SL as base (worst case progressive)
      : avgEntry * (1 + 40 / 100);
    const newSlPrice = this.calculateSlImprovement(
      hedgePnlUsdt, originalNotional, avgEntry, progressiveSlBase, ctx.direction,
    );

    this.logger.log(
      `[${ctx.coin}] Hedge CLOSED PROFIT | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Banked total: $${newBanked.toFixed(2)} | SL improvement: ${newSlPrice ? newSlPrice.toFixed(2) : 'none'}`,
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSlPrice: 0, // Progressive SL handled by position-monitor
      newSafetySlPrice: newSlPrice, // SL improvement override (used if tighter than progressive)
      bankedProfit: newBanked,
      consecutiveLosses: 0,
      hedgePhase: ctx.hedgePhase,
      reason,
    };
  }

  /**
   * Close hedge with loss → increment consecutive losses → tighten safety SL.
   */
  private closeHedgeWithLoss(
    ctx: HedgePositionContext, ctxId: string,
    hedgePnlPct: number, hedgePnlUsdt: number,
    cfg: any, reason: string,
  ): HedgeAction {
    // Release hedge lock so next cycle can acquire it
    const lockKey = `${HEDGE_LOCK_PREFIX}${ctxId}`;
    this.redisService.delete(lockKey).catch(() => {});

    this.hedgeCooldownUntil.set(ctxId, Date.now() + 15 * 60 * 1000);
    this.hedgePeakMap.delete(ctxId);

    // Increment consecutive losses (persisted to Redis for restart survival)
    const prevLosses = this.consecutiveLossMap.get(ctxId) || 0;
    const newLosses = prevLosses + 1;
    this.consecutiveLossMap.set(ctxId, newLosses);
    this.redisService.set(`cache:hedge:losses:${ctxId}`, newLosses, 86400).catch(() => {});

    const banked = (ctx.hedgeHistory || []).reduce((sum: number, h: any) => sum + (h.pnlUsdt || 0), 0);

    this.logger.warn(
      `[${ctx.coin}] Hedge CLOSED LOSS | ${reason} | PnL: ${hedgePnlPct.toFixed(2)}% ($${hedgePnlUsdt.toFixed(2)}) | ` +
      `Consecutive losses: ${newLosses} | Banked: $${banked.toFixed(2)} | SL stays 0`,
    );

    return {
      action: 'CLOSE_HEDGE',
      hedgePnlPct,
      hedgePnlUsdt,
      newSlPrice: 0, // SL stays disabled
      bankedProfit: banked,
      consecutiveLosses: newLosses,
      hedgePhase: ctx.hedgePhase,
      reason,
    };
  }

  /**
   * Widen safety SL after profitable cycle (more room for next cycle).
   * Only widens if effective max loss stays within bounds.
   */
  private adjustSafetySlOnWin(ctx: HedgePositionContext, cfg: any, totalBanked: number): number | undefined {
    const entry = ctx.entryPrice;
    if (!entry || !ctx.hedgeSafetySlPrice) return undefined;

    const currentSafetyPct = Math.abs((ctx.hedgeSafetySlPrice - entry) / entry * 100);
    const newSafetyPct = Math.min(currentSafetyPct + cfg.hedgeSlWidenPerWin, cfg.hedgeSlMaxPct);
    if (newSafetyPct <= currentSafetyPct) return undefined;

    const effectiveLoss = (newSafetyPct / 100) * ctx.positionNotional - totalBanked;
    if (effectiveLoss > cfg.hedgeMaxEffectiveLoss) return undefined;

    return ctx.direction === 'LONG'
      ? +(entry * (1 - newSafetyPct / 100)).toFixed(6)
      : +(entry * (1 + newSafetyPct / 100)).toFixed(6);
  }

  private adjustSafetySlOnLoss(ctx: HedgePositionContext, cfg: any): number | undefined {
    const entry = ctx.entryPrice;
    if (!entry || !ctx.hedgeSafetySlPrice) return undefined;

    const currentSafetyPct = Math.abs((ctx.hedgeSafetySlPrice - entry) / entry * 100);
    const newSafetyPct = Math.max(currentSafetyPct - cfg.hedgeSlTightenPerLoss, cfg.hedgeSlMinPct);
    if (newSafetyPct >= currentSafetyPct) return undefined;

    return ctx.direction === 'LONG'
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

  /** Get banked profit for a signal */
  getBankedProfit(signalId: string): number {
    return this.bankedProfitMap.get(signalId) || 0;
  }

  /** Get consecutive losses for a signal (in-memory + Redis fallback) */
  async getConsecutiveLosses(signalId: string): Promise<number> {
    const mem = this.consecutiveLossMap.get(signalId);
    if (mem !== undefined) return mem;
    // Fallback to Redis (survives restarts)
    try {
      const val = await this.redisService.get<number>(`cache:hedge:losses:${signalId}`);
      if (val !== null && val !== undefined) {
        this.consecutiveLossMap.set(signalId, val);
        return val;
      }
    } catch {}
    return 0;
  }

  async cleanupSignal(signalId: string): Promise<void> {
    this.consecutiveLossMap.delete(signalId);
    this.bankedProfitMap.delete(signalId);
    this.hedgeCooldownUntil.delete(signalId);
    this.hedgePeakMap.delete(signalId);
    const lockKey = `${HEDGE_LOCK_PREFIX}${signalId}`;
    try {
      await this.redisService.delete(lockKey);
      await this.redisService.delete(`cache:hedge:losses:${signalId}`);
    } catch {}
  }
}
