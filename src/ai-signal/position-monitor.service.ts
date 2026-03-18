import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { MarketDataService } from "../market-data/market-data.service";
import { SignalQueueService } from "./signal-queue.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { UserRealTradingService } from "./user-real-trading.service";
import { TradingConfigService } from "./trading-config";
import { HedgeManagerService, HedgeAction } from "./hedge-manager.service";

export interface ResolvedSignalInfo {
  symbol: string;
  signalKey: string; // profile-aware key (e.g. "BTCUSDT:INTRADAY" for dual coins)
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlUsdt?: number; // simulated USDT PnL (test mode grid)
  simNotional?: number; // simulated notional volume
  filledVol?: number; // actual filled volume (grid L0 only = 40%, all grids = 100%)
  closeReason: string;
  queuedSignalActivated: boolean;
}

const MONITOR_POSITIONS_KEY = "cache:ai:monitor:positions";
const MONITOR_POSITIONS_TTL = 60; // 60s

/** Coins that run BOTH INTRADAY and SWING strategies simultaneously. */
const DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

@Injectable()
export class PositionMonitorService implements OnModuleInit {
  private readonly logger = new Logger(PositionMonitorService.name);

  private monitorApiKey: string;
  private monitorApiSecret: string;
  private isConfigured = false;

  /** Symbols currently being watched by the real-time price listener. */
  private watchedSymbols = new Set<string>();

  /** Per-symbol listener callback reference (needed to unregister). */
  private listenerRefs = new Map<string, (price: number) => void>();

  /** Prevent concurrent resolution of the same symbol. */
  private resolvingSymbols = new Set<string>();

  /**
   * Optional callback registered by AiSignalService to handle notifications
   * and queued-signal promotion after a real-time TP/SL resolution.
   * Avoids a circular dependency between AiSignalService and this service.
   */
  private resolveCallback?: (info: ResolvedSignalInfo) => Promise<void>;

  /** Callback for SL-moved-to-entry notification. */
  private slMovedCallback?: (symbol: string, entryPrice: number) => Promise<void>;

  /** Callback for TP boosted on momentum. */
  private tpBoostedCallback?: (symbol: string, newTp: number, newTpPct: number, direction: string) => Promise<void>;

  /** Callback for hedge events (open/close). */
  private hedgeCallback?: (signal: AiSignalDocument, action: HedgeAction, price: number) => Promise<void>;

  /** Debounce timers for SL/TP propagation — prevents rapid tick spam to Binance */
  private slDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tpDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  setResolveCallback(cb: (info: ResolvedSignalInfo) => Promise<void>): void {
    this.resolveCallback = cb;
  }

  setSlMovedCallback(cb: (symbol: string, entryPrice: number) => Promise<void>): void {
    this.slMovedCallback = cb;
  }

  setTpBoostedCallback(cb: (symbol: string, newTp: number, newTpPct: number, direction: string) => Promise<void>): void {
    this.tpBoostedCallback = cb;
  }

  setHedgeCallback(cb: (signal: AiSignalDocument, action: HedgeAction, price: number) => Promise<void>): void {
    this.hedgeCallback = cb;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly binanceService: BinanceService,
    private readonly marketDataService: MarketDataService,
    private readonly signalQueueService: SignalQueueService,
    private readonly userRealTradingService: UserRealTradingService,
    private readonly tradingConfig: TradingConfigService,
    private readonly hedgeManager: HedgeManagerService,
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
  ) {
    this.monitorApiKey = configService.get<string>(
      "AI_MONITOR_BINANCE_API_KEY",
      "",
    );
    this.monitorApiSecret = configService.get<string>(
      "AI_MONITOR_BINANCE_API_SECRET",
      "",
    );
    this.isConfigured = !!(this.monitorApiKey && this.monitorApiSecret);

    if (!this.isConfigured) {
      this.logger.warn(
        "[PositionMonitor] AI_MONITOR_BINANCE_API_KEY/SECRET not set — position monitoring disabled",
      );
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // Clean up orphaned ACTIVE signals BEFORE registering listeners
    const cleaned = await this.signalQueueService.cleanupOrphanedActives();
    if (cleaned > 0) {
      this.logger.log(
        `[PositionMonitor] Cleaned ${cleaned} orphaned ACTIVE signal(s) on startup`,
      );
    }

    // Register real-time price listeners for remaining valid ACTIVE signals
    const activeSignals = await this.signalQueueService.getAllActiveSignals();
    for (const signal of activeSignals) {
      this.registerListener(signal);
    }
    if (activeSignals.length > 0) {
      this.logger.log(
        `[PositionMonitor] Registered real-time listeners for ${activeSignals.length} ACTIVE signal(s)`,
      );
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Profile-aware signal key for dual-timeframe coins. */
  private getSignalKey(signal: AiSignalDocument): string {
    const coin = signal.coin.toUpperCase();
    const profile = (signal as any).timeframeProfile;
    if (DUAL_TIMEFRAME_COINS.includes(coin) && profile) {
      return `${signal.symbol}:${profile}`;
    }
    return signal.symbol;
  }

  /** Expand a symbol to all possible signal keys (for dual coins, returns both profiles). */
  private expandToSignalKeys(symbol: string): string[] {
    const coin = symbol.replace("USDT", "");
    if (DUAL_TIMEFRAME_COINS.includes(coin)) {
      return [`${symbol}:INTRADAY`, `${symbol}:SWING`];
    }
    return [symbol];
  }

  // ─── Real-time price listener management ─────────────────────────────────

  /**
   * Register a price tick listener for a signal.
   * Uses signal key (profile-aware) for tracking, but real symbol for WS subscription.
   * Safe to call multiple times — skips if already watching.
   */
  registerListener(signal: AiSignalDocument): void {
    const { symbol } = signal;
    const sigKey = this.getSignalKey(signal);
    if (this.watchedSymbols.has(sigKey)) return;

    // Restore persisted flags from DB so they survive bot restarts
    if ((signal as any).slMovedToEntry) (signal as any).slMovedToEntry = true;
    if ((signal as any).tpBoosted) (signal as any).tpBoosted = true;
    if ((signal as any).peakPnlPct) (signal as any).peakPnlPct = (signal as any).peakPnlPct;

    // Eagerly widen SL for hedge on registration (don't wait for first tick)
    if (!(signal as any).hedgeSafetySlPrice) {
      const hedgeCfg = this.tradingConfig?.get();
      if (hedgeCfg?.hedgeEnabled) {
        this.widenSlForHedge(signal, hedgeCfg).catch(() => {});
      }
    }

    const cb = (price: number) => this.handlePriceTick(signal, price);
    this.listenerRefs.set(sigKey, cb);
    this.watchedSymbols.add(sigKey);
    this.marketDataService.registerPriceListener(symbol, cb);
    this.logger.debug(
      `[PositionMonitor] Watching ${sigKey} — SL: ${signal.stopLossPrice}, TP: ${signal.takeProfitPrice ?? "N/A"} slMoved=${!!(signal as any).slMovedToEntry} peak=${(signal as any).peakPnlPct ?? 0}`,
    );
  }

  /**
   * Re-register listener with updated signal (e.g. after refreshEntryPrice).
   * Preserves trail/peak state from the old signal if not present in the new one.
   */
  refreshSignalReference(updatedSignal: AiSignalDocument): void {
    const sigKey = this.getSignalKey(updatedSignal);
    if (!this.watchedSymbols.has(sigKey)) return;
    this.unregisterListener(updatedSignal);
    this.registerListener(updatedSignal);
    this.logger.debug(
      `[PositionMonitor] Refreshed ${sigKey} — entry=${updatedSignal.entryPrice} SL=${updatedSignal.stopLossPrice} TP=${updatedSignal.takeProfitPrice ?? "N/A"}`,
    );
  }

  unregisterListener(signal: AiSignalDocument): void;
  unregisterListener(sigKey: string, symbol?: string): void;
  unregisterListener(signalOrKey: AiSignalDocument | string, symbol?: string): void {
    let sigKey: string;
    let realSymbol: string;
    if (typeof signalOrKey === "string") {
      sigKey = signalOrKey;
      // Extract real symbol from key (e.g. "BTCUSDT:INTRADAY" → "BTCUSDT")
      realSymbol = symbol || sigKey.split(":")[0];
    } else {
      sigKey = this.getSignalKey(signalOrKey);
      realSymbol = signalOrKey.symbol;
    }

    const cb = this.listenerRefs.get(sigKey);
    if (cb) {
      this.marketDataService.unregisterPriceListener(realSymbol, cb);
      this.listenerRefs.delete(sigKey);
    }
    this.watchedSymbols.delete(sigKey);
  }

  // ─── Real-time TP/SL check ────────────────────────────────────────────────

  private async handlePriceTick(
    signal: AiSignalDocument,
    price: number,
  ): Promise<void> {
    const { symbol, direction, entryPrice, takeProfitPrice } = signal;
    const sigKey = this.getSignalKey(signal);

    // ─── Grid DCA Simulation (signal level) ─────────────────────────────────
    // True DCA: grids fit within signal's SL range. TP = signal TP price (Fibo).
    // Trailing stop uses weighted avg entry. Close ALL grids together on TP/SL.
    const GRID_LEVEL_COUNT = 3;
    // DCA volume weights: L0=40% base, L1=25%, L2=35% (sum=100)
    // Reduced from 5 levels: data shows G4-5 full fill = -$335 (averaging into deep loss)
    const DCA_WEIGHTS = [40, 25, 35];

    const gridLevels: any[] = (signal as any).gridLevels ?? [];
    const isGridSignal = gridLevels.length > 0;

    // Initialize grid on first tick (base grid = level 0)
    if (!isGridSignal) {
      const origEntry = entryPrice;
      const stopLossPrice = (signal as any).originalSlPrice || (signal as any).stopLossPrice;
      const signalSlPct = Math.abs((stopLossPrice - origEntry) / origEntry) * 100;
      // Dynamic grid step: L4 at 80% of SL range, 20% buffer before SL
      const gridStep = signalSlPct / GRID_LEVEL_COUNT;

      const simNotional = 1000;
      const simQuantity = simNotional / origEntry;
      const grids: any[] = [];

      for (let i = 0; i < GRID_LEVEL_COUNT; i++) {
        const dev = i * gridStep;
        const volPct = DCA_WEIGHTS[i];
        const gridNotional = simNotional * (volPct / 100);
        if (i === 0) {
          grids.push({
            level: 0, deviationPct: 0, fillPrice: origEntry,
            volumePct: volPct,
            status: "FILLED", filledAt: new Date(),
            simNotional: gridNotional, simQuantity: gridNotional / origEntry,
          });
        } else {
          grids.push({
            level: i, deviationPct: parseFloat(dev.toFixed(3)), fillPrice: 0,
            volumePct: volPct,
            status: "PENDING",
          });
        }
      }

      // Avg entry starts as L0 entry
      const avgEntry = origEntry;

      (signal as any).gridLevels = grids;
      (signal as any).originalEntryPrice = origEntry;
      (signal as any).gridGlobalSlPrice = stopLossPrice; // signal's own SL
      (signal as any).gridFilledCount = 1;
      (signal as any).gridClosedCount = 0;
      (signal as any).gridAvgEntry = avgEntry;
      (signal as any).simNotional = simNotional;
      (signal as any).simQuantity = simQuantity;

      await this.signalQueueService.updateSignalGrid(
        (signal as any)._id.toString(), grids, 1, 0,
      );
      await this.signalQueueService.initGridSignal(
        (signal as any)._id.toString(), origEntry, stopLossPrice, avgEntry,
      );
      await this.signalQueueService.updateSimVolume(
        (signal as any)._id.toString(), simNotional, simQuantity,
      );
      this.logger.log(
        `[PositionMonitor] Grid DCA init ${sigKey}: ${GRID_LEVEL_COUNT} levels, step=${gridStep.toFixed(2)}%, SL=${stopLossPrice.toFixed(4)}, TP=${takeProfitPrice?.toFixed(4)}`,
      );
    }

    // Process grid events
    if ((signal as any).gridLevels?.length > 0) {
      const grids: any[] = (signal as any).gridLevels;
      const origEntry = (signal as any).originalEntryPrice ?? entryPrice;
      const globalSl = (signal as any).gridGlobalSlPrice;
      const signalTp = takeProfitPrice; // Fibo TP price
      let avgEntry: number = (signal as any).gridAvgEntry ?? origEntry;
      let gridChanged = false;
      let filledCount = (signal as any).gridFilledCount ?? 1;
      let closedCount = (signal as any).gridClosedCount ?? 0;

      // Skip grid DCA fills when hedge is active in FULL phase (don't add to losing position)
      const skipGridFills = !!(signal as any).hedgeActive && (signal as any).hedgePhase === "FULL";

      // Check PENDING grids: price moved against position → simulate fill
      // RSI guard: only DCA when RSI shows exhaustion (likely to bounce)
      let rsiOk: boolean | null = null; // null = not yet computed
      const coin = signal.symbol.replace("USDT", "");

      for (const grid of grids) {
        if (grid.status !== "PENDING") continue;
        if (skipGridFills) continue;
        const triggerPrice = direction === "LONG"
          ? origEntry * (1 - grid.deviationPct / 100)
          : origEntry * (1 + grid.deviationPct / 100);
        const triggered = direction === "LONG" ? price <= triggerPrice : price >= triggerPrice;
        if (triggered) {
          // Cooldown: skip if last grid filled < 5 min ago
          const lastFill = grids
            .filter((g) => g.status === "FILLED" && g.filledAt)
            .map((g) => new Date(g.filledAt).getTime())
            .sort((a, b) => b - a)[0];
          if (lastFill && Date.now() - lastFill < 5 * 60 * 1000) continue;

          // RSI guard for L1+ — only DCA when oversold/overbought
          // L1-L2: RSI only (small volume 6-12%, quick avg-down)
          // L3+: RSI + sustained momentum check (large volume 18-24%, need stabilization)
          if (grid.level >= 1 && rsiOk === null) {
            try {
              const closes = await this.marketDataService.getClosePrices(coin, "15m");
              if (closes.length >= 14) {
                const { RSI } = require("technicalindicators");
                const rsiVals = RSI.calculate({ period: 14, values: closes });
                const rsi = rsiVals[rsiVals.length - 1];
                const cfg = this.tradingConfig?.get();
                const rsiLongThresh = cfg?.gridRsiLong ?? 45;
                const rsiShortThresh = cfg?.gridRsiShort ?? 55;
                const rsiExhausted = direction === "LONG" ? rsi < rsiLongThresh : rsi > rsiShortThresh;

                if (grid.level <= 2) {
                  // L1-L2: RSI only — allow DCA more freely to avg down
                  rsiOk = rsiExhausted;
                } else {
                  // L3+: RSI + sustained check (bigger positions need confirmation)
                  const last4 = closes.slice(-4);
                  const sustainedAgainst = last4.length >= 4 && (
                    direction === "LONG"
                      ? last4[3] < last4[2] && last4[2] < last4[1] && last4[1] < last4[0]
                      : last4[3] > last4[2] && last4[2] > last4[1] && last4[1] > last4[0]
                  );
                  rsiOk = rsiExhausted && !sustainedAgainst;
                }

                if (!rsiOk) {
                  this.logger.debug(
                    `[PositionMonitor] Grid ${sigKey} L${grid.level} RSI=${rsi.toFixed(1)} — skip DCA (${grid.level <= 2 ? "RSI not exhausted" : "waiting stabilization"})`,
                  );
                }
              } else {
                rsiOk = true;
              }
            } catch {
              rsiOk = true;
            }
          }
          if (grid.level >= 1 && rsiOk === false) continue;
          const simTotalNotional = (signal as any).simNotional || 1000;
          const gridNotional = simTotalNotional * (grid.volumePct / 100);
          grid.status = "FILLED";
          grid.fillPrice = price;
          grid.filledAt = new Date();
          grid.simNotional = gridNotional;
          grid.simQuantity = gridNotional / price;
          filledCount++;
          gridChanged = true;

          // Recalculate weighted average entry
          const filledGrids = grids.filter((g) => g.status === "FILLED");
          const totalVol = filledGrids.reduce((s, g) => s + (g.simNotional || 0), 0);
          avgEntry = totalVol > 0
            ? filledGrids.reduce((s, g) => s + g.fillPrice * (g.simNotional || 0), 0) / totalVol
            : origEntry;
          (signal as any).gridAvgEntry = avgEntry;

          // Recalculate SL from new avgEntry — keep same % distance as original
          const origSlPct = origEntry > 0
            ? Math.abs(((signal as any).gridGlobalSlPrice ?? (signal as any).stopLossPrice) - origEntry) / origEntry * 100
            : 2.5;
          const newSl = direction === "LONG"
            ? avgEntry * (1 - origSlPct / 100)
            : avgEntry * (1 + origSlPct / 100);
          (signal as any).stopLossPrice = newSl;

          // DCA TP: 3% from new avgEntry
          const DCA_TP_PCT = 3.0;
          const newTp = direction === "LONG"
            ? avgEntry * (1 + DCA_TP_PCT / 100)
            : avgEntry * (1 - DCA_TP_PCT / 100);
          (signal as any).takeProfitPrice = newTp;
          (signal as any).takeProfitPercent = DCA_TP_PCT;

          this.logger.log(
            `[PositionMonitor] Grid ${sigKey} L${grid.level} FILLED at ${price.toFixed(4)}, avgEntry=${avgEntry.toFixed(4)}, SL=${newSl.toFixed(4)} (${origSlPct.toFixed(1)}%), TP=${newTp.toFixed(4)}, filled=${filledCount}/${GRID_LEVEL_COUNT}`,
          );
        }
      }

      // Trailing stop for grid DCA: uses avg entry
      // TP/SL hit detection handled by normal path below (falls through)
      // Skip trail SL when hedge is active — hedge manages risk
      const skipTrailSl = !!(signal as any).hedgeActive;
      const filledGrids = grids.filter((g) => g.status === "FILLED");
      if (filledGrids.length > 0) {
        const TRAIL_TRIGGER = 2.0;
        const TRAIL_KEEP_RATIO = 0.75; // keep 60% of peak profit
        const pnlFromAvg = direction === "LONG"
          ? ((price - avgEntry) / avgEntry) * 100
          : ((avgEntry - price) / avgEntry) * 100;

        const prevPeak = (signal as any).peakPnlPct || 0;
        if (pnlFromAvg > prevPeak) {
          (signal as any).peakPnlPct = pnlFromAvg;
        }
        const peak = (signal as any).peakPnlPct || 0;

        // Move SL to avg entry (break-even) at 2% from avg — skip when hedge active
        if (!skipTrailSl && peak >= TRAIL_TRIGGER && !(signal as any).slMovedToEntry) {
          (signal as any).stopLossPrice = avgEntry;
          (signal as any).slMovedToEntry = true;
          (signal as any).gridGlobalSlPrice = avgEntry;
          await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
          gridChanged = true;
          this.logger.log(
            `[PositionMonitor] 🛡️ Grid ${sigKey} SL → avg entry ${avgEntry.toFixed(4)} (BE, peak=${peak.toFixed(2)}%)`,
          );
          if (this.slMovedCallback) {
            await this.slMovedCallback(symbol, avgEntry).catch(() => {});
          }
          // NOTE: Do NOT propagate trail SL to Binance — backend manages exit via protectOpenTrades
          // Original SL on Binance stays as safety net
        }

        // Continuous trailing: keep 75% of peak profit (DB only — not pushed to Binance)
        // TP proximity lock: if price within 0.5% of TP → freeze trail, let TP execute
        // Skip when hedge active — hedge manages risk
        if (!skipTrailSl) {
          const distanceToTp = signalTp
            ? (direction === "LONG" ? (signalTp - price) / price : (price - signalTp) / price) * 100
            : Infinity;
          const nearTp = distanceToTp < 0.5;

          if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER && !nearTp) {
            const trailPct = peak * TRAIL_KEEP_RATIO;
            const trailSl = direction === "LONG"
              ? avgEntry * (1 + trailPct / 100)
              : avgEntry * (1 - trailPct / 100);
            const currentSl = (signal as any).gridGlobalSlPrice || avgEntry;
            const shouldRaise = direction === "LONG" ? trailSl > currentSl : trailSl < currentSl;
            if (shouldRaise) {
              (signal as any).stopLossPrice = trailSl;
              (signal as any).gridGlobalSlPrice = trailSl;
              await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
              gridChanged = true;
              this.logger.log(
                `[PositionMonitor] 📈 Grid ${sigKey} trail SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak=${peak.toFixed(2)}%`,
              );
              // NOTE: Trail SL stays in DB only — protectOpenTrades handles real mode exit with momentum check
            }
          } else if (nearTp) {
            this.logger.debug(`[PositionMonitor] 🎯 Grid ${sigKey} near TP (${distanceToTp.toFixed(2)}% away) — trail SL frozen`);
          }
        }

        // TP boost at 2% peak from avg entry
        if (pnlFromAvg >= 2.5 && !(signal as any).tpBoosted && signalTp) {
          (signal as any).tpBoosted = true;
          try {
            const hasMomentum = await this.marketDataService.hasVolumeMomentum(symbol);
            if (hasMomentum) {
              const currentTpPct = Math.abs(signalTp - avgEntry) / avgEntry * 100;
              const boostedTpPct = Math.min(6, Math.max(currentTpPct, pnlFromAvg + 2.0));
              const newTpPrice = direction === "LONG"
                ? avgEntry * (1 + boostedTpPct / 100)
                : avgEntry * (1 - boostedTpPct / 100);
              (signal as any).takeProfitPrice = newTpPrice;
              await this.signalQueueService.extendTakeProfit(
                (signal as any)._id.toString(), newTpPrice, boostedTpPct,
              );
              gridChanged = true;
              this.logger.log(
                `[PositionMonitor] 🚀 Grid ${sigKey} TP boosted to ${boostedTpPct.toFixed(1)}% from avgEntry (${newTpPrice.toFixed(4)})`,
              );
              this.propagateTpMove(sigKey, symbol, newTpPrice, direction);
            }
          } catch (err) {
            this.logger.warn(`[PositionMonitor] Grid TP boost error ${sigKey}: ${err?.message}`);
          }
        }

      }

      // Persist grid fills + trailing stop changes
      if (gridChanged) {
        (signal as any).gridLevels = grids;
        (signal as any).gridFilledCount = filledCount;
        (signal as any).gridClosedCount = closedCount;
        await this.signalQueueService.updateSignalGrid(
          (signal as any)._id.toString(), grids, filledCount, closedCount, avgEntry,
          (signal as any).stopLossPrice,
          (signal as any).takeProfitPrice,
        );
      }

      // Fall through to normal TP/SL check below (uses signal.stopLossPrice + takeProfitPrice
      // which are kept in sync by the trailing stop logic above)
    }

    // ─── Auto risk management ──────────────────────────────────────────────
    // For grid signals, use avgEntry (already synced to entryPrice by updateSignalGrid)
    const currentEntry = entryPrice;
    const pnlPct =
      direction === "LONG"
        ? ((price - currentEntry) / currentEntry) * 100
        : ((currentEntry - price) / currentEntry) * 100;

    // Trailing SL + TP boost for non-grid signals only
    // (grid signals handle trailing in the grid block above)
    // Skip trail SL when hedge is active — hedge manages risk
    if (!isGridSignal && !(signal as any).hedgeActive) {
      // Trail trigger: move SL to break-even at 2% profit
      // Trail distance: keep 60% of peak profit (dynamic, not fixed)
      // Example: peak 3% → SL at +1.8%, peak 4% → SL at +2.4%
      const TRAIL_TRIGGER = 2.0;
      const TRAIL_KEEP_RATIO = 0.75; // keep 60% of peak (was fixed 1.2% distance → avg win only $11)

      const prevPeak = (signal as any).peakPnlPct || 0;
      if (pnlPct > prevPeak) {
        (signal as any).peakPnlPct = pnlPct;
      }
      const peak = (signal as any).peakPnlPct || 0;

      if (peak >= TRAIL_TRIGGER && !(signal as any).slMovedToEntry) {
        (signal as any).stopLossPrice = currentEntry;
        (signal as any).slMovedToEntry = true;
        await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
        this.logger.log(
          `[PositionMonitor] 🛡️ ${sigKey} SL moved to entry ${currentEntry} (PnL: ${pnlPct.toFixed(2)}%)`,
        );
        if (this.slMovedCallback) {
          await this.slMovedCallback(symbol, currentEntry).catch((e) =>
            this.logger.warn(`[PositionMonitor] slMovedCallback error ${sigKey}: ${e?.message}`),
          );
        }
        // NOTE: Do NOT propagate trail SL to Binance — backend manages exit via protectOpenTrades
      }

      // TP proximity lock: if price within 0.5% of TP → freeze trail, let TP execute
      const distanceToTp = takeProfitPrice
        ? (direction === "LONG" ? (takeProfitPrice - price) / price : (price - takeProfitPrice) / price) * 100
        : Infinity;
      const nearTp = distanceToTp < 0.5;

      if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER && !nearTp) {
        const trailPct = peak * TRAIL_KEEP_RATIO;
        const trailSl = direction === "LONG"
          ? currentEntry * (1 + trailPct / 100)
          : currentEntry * (1 - trailPct / 100);
        const currentSl = (signal as any).stopLossPrice || currentEntry;
        const shouldRaise = direction === "LONG" ? trailSl > currentSl : trailSl < currentSl;
        if (shouldRaise) {
          (signal as any).stopLossPrice = trailSl;
          await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
          this.logger.log(
            `[PositionMonitor] 📈 ${sigKey} trailing SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak: ${peak.toFixed(2)}%`,
          );
          // NOTE: Trail SL stays in DB only — protectOpenTrades handles real mode exit with momentum check
        }
      } else if (nearTp) {
        this.logger.debug(`[PositionMonitor] 🎯 ${sigKey} near TP (${distanceToTp.toFixed(2)}% away) — trail SL frozen`);
      }
    }

    // ─── Dynamic TP boost: extend TP on strong momentum ─────────────────
    if (pnlPct >= 2.5 && !(signal as any).tpBoosted && takeProfitPrice) {
      (signal as any).tpBoosted = true; // mark as checked (one-time per signal)
      try {
        const hasMomentum = await this.marketDataService.hasVolumeMomentum(symbol);
        if (hasMomentum) {
          // Extend TP by 2% from current position, cap at 4%
          const currentTpPct = Math.abs(takeProfitPrice - currentEntry) / currentEntry * 100;
          const boostedTpPct = Math.min(4, Math.max(currentTpPct, pnlPct + 2.0));
          const newTpPrice = direction === "LONG"
            ? currentEntry * (1 + boostedTpPct / 100)
            : currentEntry * (1 - boostedTpPct / 100);
          (signal as any).takeProfitPrice = newTpPrice;
          await this.signalQueueService.extendTakeProfit(
            (signal as any)._id.toString(), newTpPrice, boostedTpPct,
          );
          this.logger.log(
            `[PositionMonitor] 🚀 ${sigKey} TP boosted to ${boostedTpPct.toFixed(1)}% (${newTpPrice.toFixed(4)}) — volume momentum detected`,
          );
          // Propagate TP change to real Binance orders (with retry)
          this.propagateTpMove(sigKey, symbol, newTpPrice, direction);
          // Notify via callback
          if (this.tpBoostedCallback) {
            await this.tpBoostedCallback(symbol, newTpPrice, boostedTpPct, direction).catch((e) =>
              this.logger.warn(`[PositionMonitor] tpBoostedCallback error ${sigKey}: ${e?.message}`),
            );
          }
        }
      } catch (err) {
        this.logger.warn(`[PositionMonitor] TP boost check error for ${sigKey}: ${err?.message}`);
      }
    }

    // ─── Auto-Hedge Logic ──────────────────────────────────────────────────
    const hedgeCfg = this.tradingConfig.get();
    const hedgeEnabled = hedgeCfg.hedgeEnabled;
    const hedgeActive = !!(signal as any).hedgeActive;

    if (hedgeEnabled) {
      // First tick with hedge enabled: widen SL to safety net
      if (!(signal as any).hedgeSafetySlPrice) {
        await this.widenSlForHedge(signal, hedgeCfg);
      }

      if (!hedgeActive) {
        // Check if PnL crosses hedge trigger
        if (pnlPct <= -hedgeCfg.hedgePartialTriggerPct) {
          const regime = (signal as any).regime || "MIXED";
          const action = await this.hedgeManager.checkHedge(signal, price, pnlPct, regime);
          if (action && action.action !== "NONE") {
            await this.handleHedgeAction(signal, action, price);
          }
        }
      } else {
        // Hedge is active — check for exit
        const exitAction = this.hedgeManager.checkHedgeExit(signal, price, pnlPct);
        if (exitAction && exitAction.action === "CLOSE_HEDGE") {
          await this.handleHedgeClose(signal, exitAction, price);
        }

        // When hedge is active: NO SL — hedge IS the risk management
        // Only catastrophic stop at -25% (exchange issues, depeg, extreme events)
        const currentEntry = (signal as any).gridAvgEntry || entryPrice;
        const catastrophicPct = direction === "LONG"
          ? ((price - currentEntry) / currentEntry) * 100
          : ((currentEntry - price) / currentEntry) * 100;

        if (catastrophicPct > -25) return; // Skip all SL/TP — hedge manages, keep rỉa

        // Catastrophic -25% — force close everything
        this.logger.warn(
          `[PositionMonitor] ${sigKey} CATASTROPHIC STOP at ${price} (${catastrophicPct.toFixed(1)}%) while hedge active — force closing both`,
        );

        // Create completed record for the open hedge before closing
        if ((signal as any).hedgeEntryPrice && (signal as any).hedgeDirection) {
          const hDir = (signal as any).hedgeDirection;
          const hEntry = (signal as any).hedgeEntryPrice;
          const hNotional = (signal as any).hedgeSimNotional || 0;
          const hPnlPct = hDir === "LONG"
            ? ((price - hEntry) / hEntry) * 100
            : ((hEntry - price) / hEntry) * 100;
          const hPnlUsdt = Math.round((hPnlPct / 100) * hNotional * 100) / 100;

          try {
            await this.aiSignalModel.create({
              symbol: signal.symbol, coin: (signal as any).coin, currency: "usdt",
              direction: hDir, entryPrice: hEntry, exitPrice: price,
              stopLossPrice: 0, stopLossPercent: 0, takeProfitPrice: 0, takeProfitPercent: 0,
              strategy: `HEDGE_${(signal as any).strategy || ""}`, regime: (signal as any).regime,
              status: "COMPLETED", closeReason: "HEDGE_SAFETY_SL",
              pnlPercent: Math.round(hPnlPct * 100) / 100, pnlUsdt: hPnlUsdt,
              simNotional: hNotional, isTestMode: (signal as any).isTestMode ?? true,
              source: "hedge", executedAt: (signal as any).hedgeOpenedAt, positionClosedAt: new Date(),
              gridLevels: [], primaryKline: (signal as any).primaryKline, timeframeProfile: (signal as any).timeframeProfile,
              indicatorSnapshot: { reason: `Hedge force-closed: main safety SL hit` },
            });
          } catch {}

          // Add to hedge history for net PnL calculation
          const hedgeHistory = (signal as any).hedgeHistory || [];
          hedgeHistory.push({
            phase: (signal as any).hedgePhase, direction: hDir,
            entryPrice: hEntry, exitPrice: price, notional: hNotional,
            pnlPct: hPnlPct, pnlUsdt: hPnlUsdt,
            openedAt: (signal as any).hedgeOpenedAt, closedAt: new Date(),
            reason: "Main safety SL hit",
          });
          (signal as any).hedgeHistory = hedgeHistory;
        }

        // Clean up hedge state
        await this.hedgeManager.cleanupSignal((signal as any)._id?.toString());
      }
    }

    // ─── Original TP/SL check (non-grid signals) ──────────────────────────
    // Re-read takeProfitPrice in case it was boosted above
    const effectiveTpPrice = (signal as any).takeProfitPrice ?? takeProfitPrice;
    const stopLossPrice = (signal as any).stopLossPrice;
    const slHit =
      direction === "LONG" ? price <= stopLossPrice : price >= stopLossPrice;
    const tpHit = effectiveTpPrice
      ? direction === "LONG"
        ? price >= effectiveTpPrice
        : price <= effectiveTpPrice
      : false;

    if (!slHit && !tpHit) return;

    // Prevent double-trigger: unregister first, then resolve
    if (this.resolvingSymbols.has(sigKey)) return;
    this.resolvingSymbols.add(sigKey);
    this.unregisterListener(signal);
    // Clean up hedge tracking when signal fully closes
    await this.hedgeManager.cleanupSignal((signal as any)._id?.toString()).catch(() => {});

    const reason = tpHit ? "TAKE_PROFIT" : "STOP_LOSS";
    const emoji = tpHit ? "🎯" : "🛑";
    // Use SL/TP price as exit when hit — prevents gap/slippage from inflating PnL
    // (e.g., CHZ gapped from 0.037→0.038 past SL=0.0374, recorded -5.65% instead of -3%)
    const exitPrice = slHit ? stopLossPrice : (tpHit ? (effectiveTpPrice ?? price) : price);
    this.logger.log(
      `[PositionMonitor] ${emoji} ${sigKey} price=${price} exit=${exitPrice} hit ${reason} (${direction} SL=${stopLossPrice} TP=${takeProfitPrice ?? "none"})`,
    );

    try {
      const resolved = await this.signalQueueService.resolveActiveSignal(
        sigKey,
        exitPrice,
        reason,
      );

      if (resolved) {
        let promoted = await this.signalQueueService.activateQueuedSignal(
          sigKey,
        );
        if (promoted) {
          // Refresh entry price — queued signals can be hours old
          const livePrice = this.marketDataService.getLatestPrice(promoted.symbol);
          if (livePrice && livePrice > 0) {
            promoted = await this.signalQueueService.refreshEntryPrice(promoted, livePrice);
          }
          this.registerListener(promoted);
          // Use stored aiParams from signal (contains leverage, SL/TP config) — fallback to empty if missing
          const promotedParams = (promoted as any).aiParams ?? {};
          this.userRealTradingService.onSignalActivated(promoted, promotedParams).catch((err) =>
            this.logger.error(`[PositionMonitor] Real trading error (queued promoted): ${err?.message}`),
          );
          this.logger.log(
            `[PositionMonitor] ${sigKey} queued signal promoted to ACTIVE`,
          );
        }

        // Notify AiSignalService so it can send Telegram messages
        if (this.resolveCallback) {
          // Use gridAvgEntry for grid signals
          const entryForPnl = (signal as any).gridAvgEntry || signal.entryPrice;
          const pnlPercent =
            signal.direction === "LONG"
              ? ((exitPrice - entryForPnl) / entryForPnl) * 100
              : ((entryForPnl - exitPrice) / entryForPnl) * 100;

          // Per-grid USDT PnL (each grid has different fillPrice)
          let pnlUsdt: number | undefined;
          const grids: any[] = (signal as any).gridLevels || [];
          if (grids.length > 0) {
            let totalUsdt = 0;
            for (const g of grids) {
              if (g.status === "FILLED") {
                const vol = g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100);
                const gPnl = signal.direction === "LONG"
                  ? ((exitPrice - g.fillPrice) / g.fillPrice) * 100
                  : ((g.fillPrice - exitPrice) / g.fillPrice) * 100;
                totalUsdt += (gPnl / 100) * vol;
              }
            }
            pnlUsdt = totalUsdt;
          } else {
            pnlUsdt = (pnlPercent / 100) * ((signal as any).simNotional || 1000) * 0.4; // L0 only
          }

          // Calculate filled volume from grids
          const resolveGrids: any[] = (signal as any).gridLevels || [];
          const filledVol = resolveGrids.length > 0
            ? resolveGrids.filter((g: any) => g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED")
                .reduce((s: number, g: any) => s + (g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100)), 0)
            : (signal as any).simNotional || 1000;

          await this.resolveCallback({
            symbol,
            signalKey: sigKey,
            direction: signal.direction,
            entryPrice: entryForPnl,
            exitPrice,
            pnlPercent,
            pnlUsdt,
            simNotional: (signal as any).simNotional,
            filledVol: Math.round(filledVol),
            closeReason: reason,
            queuedSignalActivated: !!promoted,
          }).catch((err) =>
            this.logger.warn(
              `[PositionMonitor] resolveCallback error: ${err?.message}`,
            ),
          );
        }
      }
    } finally {
      this.resolvingSymbols.delete(sigKey);
    }
  }

  // ─── 30s polling fallback ─────────────────────────────────────────────────

  /**
   * Fallback: detect position closes that were NOT caught by the real-time listener
   * (e.g. manual close, liquidation, or signals created before WS was connected).
   * Called every 30 seconds by AiSignalService.
   */
  async checkAndResolve(): Promise<ResolvedSignalInfo[]> {
    if (!this.isConfigured) return [];

    const resolved: ResolvedSignalInfo[] = [];

    try {
      const activeSignals = await this.signalQueueService.getAllActiveSignals();
      if (activeSignals.length === 0) return [];

      // Ensure price listeners are registered for all ACTIVE signals
      for (const signal of activeSignals) {
        this.registerListener(signal);
      }

      // Check monitor account for positions that have already closed
      const openPositions = await this.getOpenPositionSymbols();

      for (const signal of activeSignals) {
        const symbol = signal.symbol;
        const sigKey = this.getSignalKey(signal);

        // Test mode signals have no Binance position — skip position check
        // They are managed by the price listener (handlePriceTick) instead
        if ((signal as any).isTestMode) continue;

        // If position for this symbol is still open → no action
        if (openPositions.has(symbol)) continue;

        // Guard: don't double-resolve if real-time listener already caught it
        if (this.resolvingSymbols.has(sigKey)) continue;
        if (!this.watchedSymbols.has(sigKey) && !(await this.signalQueueService.getActiveSignal(sigKey))) {
          // Already resolved
          continue;
        }

        this.resolvingSymbols.add(sigKey);
        this.unregisterListener(signal);

        // Get current price to record exit
        const exitPrice = await this.getCurrentPrice(symbol);
        if (!exitPrice || exitPrice <= 0) {
          this.logger.warn(
            `[PositionMonitor] ${sigKey} price fetch returned 0 — skipping resolution`,
          );
          this.resolvingSymbols.delete(sigKey);
          continue;
        }

        try {
          const resolvedSignal =
            await this.signalQueueService.resolveActiveSignal(
              sigKey,
              exitPrice,
              "POSITION_CLOSED",
            );

          let promoted =
            await this.signalQueueService.activateQueuedSignal(sigKey);
          if (promoted) {
            const livePrice = this.marketDataService.getLatestPrice(promoted.symbol);
            if (livePrice && livePrice > 0) {
              promoted = await this.signalQueueService.refreshEntryPrice(promoted, livePrice);
            }
            this.registerListener(promoted);
            const promotedParams = (promoted as any).aiParams ?? {};
            this.userRealTradingService.onSignalActivated(promoted, promotedParams).catch((err) =>
              this.logger.error(`[PositionMonitor] Real trading error (queued promoted): ${err?.message}`),
            );
          }

          // Use gridAvgEntry for grid signals (same logic as handlePriceTick)
          const entryForPnl = (signal as any).gridAvgEntry || signal.entryPrice;
          const pnlPercent =
            signal.direction === "LONG"
              ? ((exitPrice - entryForPnl) / entryForPnl) * 100
              : ((entryForPnl - exitPrice) / entryForPnl) * 100;

          resolved.push({
            symbol,
            signalKey: sigKey,
            direction: signal.direction,
            entryPrice: entryForPnl,
            exitPrice,
            pnlPercent,
            closeReason: "POSITION_CLOSED",
            queuedSignalActivated: !!promoted,
          });

          if (promoted) {
            this.logger.log(
              `[PositionMonitor] ${sigKey} position closed — queued signal now ACTIVE`,
            );
          }
        } finally {
          this.resolvingSymbols.delete(sigKey);
        }
      }
    } catch (err) {
      this.logger.error(
        `[PositionMonitor] checkAndResolve error: ${err?.message}`,
      );
    }

    return resolved;
  }

  // ─── Propagate SL/TP moves to real users (with 1 retry) ─────────────────

  private propagateSlMove(sigKey: string, symbol: string, newSl: number, direction: string): void {
    // Debounce: cancel pending timer and wait 5s after last tick before calling Binance
    // Prevents duplicate SL orders when price moves tick-by-tick (rapid fire)
    const existing = this.slDebounceTimers.get(sigKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.slDebounceTimers.delete(sigKey);
      this.userRealTradingService.moveStopLossForRealUsers(symbol, newSl, direction).catch((err) => {
        this.logger.error(`[PositionMonitor] ${sigKey} moveStopLoss failed: ${err?.message}`);
      });
    }, 5000);
    this.slDebounceTimers.set(sigKey, timer);
  }

  private propagateTpMove(sigKey: string, symbol: string, newTp: number, direction: string): void {
    // Debounce: cancel pending timer and wait 5s after last tick before calling Binance
    const existing = this.tpDebounceTimers.get(sigKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.tpDebounceTimers.delete(sigKey);
      this.userRealTradingService.moveTpForRealUsers(symbol, newTp, direction).catch((err) => {
        this.logger.error(`[PositionMonitor] ${sigKey} moveTp failed: ${err?.message}`);
      });
    }, 5000);
    this.tpDebounceTimers.set(sigKey, timer);
  }

  // ─── Private: fetch open positions ───────────────────────────────────────

  private async getOpenPositionSymbols(): Promise<Set<string>> {
    try {
      const positions = await this.binanceService.getOpenPositions(
        this.monitorApiKey,
        this.monitorApiSecret,
      );
      return new Set(positions.map((p) => p.symbol));
    } catch (err) {
      this.logger.warn(
        `[PositionMonitor] Failed to fetch positions: ${err?.message}`,
      );
      // Return all symbols as "open" to avoid false positives
      const activeSignals = await this.signalQueueService.getAllActiveSignals();
      return new Set(activeSignals.map((s) => s.symbol));
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    return (await this.marketDataService.getPrice(symbol)) ?? 0;
  }

  // ─── Auto-Hedge helpers ─────────────────────────────────────────────────

  /**
   * Widen SL to safety net on first tick when hedge is enabled.
   * Saves original SL so it can be restored after hedge closes.
   */
  private async widenSlForHedge(signal: AiSignalDocument, cfg: any): Promise<void> {
    const sigKey = this.getSignalKey(signal);
    const { direction, entryPrice } = signal;
    const currentSl = (signal as any).stopLossPrice;

    // Save original SL for DCA grid spacing (grid uses originalSlPrice, not widened safety SL)
    if (!(signal as any).originalSlPrice) {
      (signal as any).originalSlPrice = currentSl;
    }

    // Hedge active = NO SL — hedge IS the risk management
    // Only catastrophic -25% check in handlePriceTick, no price-based SL
    (signal as any).hedgeSafetySlPrice = 0;
    (signal as any).stopLossPrice = 0;
    (signal as any).stopLossPercent = 0;
    (signal as any).slMovedToEntry = false;

    // Persist to DB (only set originalSlPrice if not already saved from a previous cycle)
    const widenUpdates: Record<string, any> = {
      hedgeSafetySlPrice: 0,
      stopLossPrice: 0,
      stopLossPercent: 0,
      slMovedToEntry: false,
    };
    if ((signal as any).originalSlPrice === currentSl) {
      widenUpdates.originalSlPrice = currentSl;
    }
    await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, widenUpdates);

    this.logger.log(
      `[PositionMonitor] ${sigKey} SL widened for hedge: ${currentSl} → ${safetySlPrice} (safety net -${cfg.hedgeSafetySlPct}%)`,
    );
  }

  /**
   * Handle hedge open/upgrade action (sim mode — updates signal fields directly).
   */
  private async handleHedgeAction(
    signal: AiSignalDocument,
    action: HedgeAction,
    currentPrice: number,
  ): Promise<void> {
    const sigKey = this.getSignalKey(signal);
    const signalId = (signal as any)._id?.toString();
    if (!signalId) return;

    const phase = action.action === "OPEN_PARTIAL" ? "PARTIAL" : "FULL";

    // Update in-memory signal
    (signal as any).hedgeActive = true;
    (signal as any).hedgePhase = phase;
    (signal as any).hedgeDirection = action.hedgeDirection;
    (signal as any).hedgeEntryPrice = currentPrice;
    (signal as any).hedgeSimNotional = action.hedgeNotional;
    (signal as any).hedgeTpPrice = action.hedgeTpPrice;
    (signal as any).hedgeOpenedAt = new Date();

    // Persist to DB
    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      hedgeActive: true,
      hedgePhase: phase,
      hedgeDirection: action.hedgeDirection,
      hedgeEntryPrice: currentPrice,
      hedgeSimNotional: action.hedgeNotional,
      hedgeTpPrice: action.hedgeTpPrice,
      hedgeOpenedAt: new Date(),
    });

    this.logger.log(
      `[PositionMonitor] ${sigKey} HEDGE ${action.action} | ${action.hedgeDirection} | ` +
      `Entry: ${currentPrice} | Notional: $${action.hedgeNotional?.toFixed(2)} | TP: ${action.hedgeTpPrice} | ` +
      `Reason: ${action.reason}`,
    );

    // Notify via callback (AiSignalService sends Telegram message)
    if (this.hedgeCallback) {
      await this.hedgeCallback(signal, action, currentPrice).catch((err) =>
        this.logger.warn(`[PositionMonitor] hedgeCallback error ${sigKey}: ${err?.message}`),
      );
    }
  }

  /**
   * Handle hedge close action (sim mode — updates signal fields, pushes to history).
   */
  private async handleHedgeClose(
    signal: AiSignalDocument,
    action: HedgeAction,
    currentPrice: number,
  ): Promise<void> {
    const sigKey = this.getSignalKey(signal);
    const signalId = (signal as any)._id?.toString();
    if (!signalId) return;

    const cycleCount = ((signal as any).hedgeCycleCount || 0) + 1;

    // Build hedge history entry
    const historyEntry = {
      phase: (signal as any).hedgePhase,
      direction: (signal as any).hedgeDirection,
      entryPrice: (signal as any).hedgeEntryPrice,
      exitPrice: currentPrice,
      notional: (signal as any).hedgeSimNotional,
      pnlPct: action.hedgePnlPct,
      pnlUsdt: action.hedgePnlUsdt,
      openedAt: (signal as any).hedgeOpenedAt,
      closedAt: new Date(),
      reason: action.reason,
    };

    // Determine new SL: use improved SL from hedge profit, or keep current safety SL
    const newSlPrice = action.newSlPrice || (signal as any).hedgeSafetySlPrice || (signal as any).stopLossPrice;

    // If hedge manager provided a tighter safety SL, update it too
    const updates: Record<string, any> = {};
    if (action.newSafetySlPrice) {
      (signal as any).hedgeSafetySlPrice = action.newSafetySlPrice;
      (signal as any).stopLossPrice = action.newSafetySlPrice;
      updates.hedgeSafetySlPrice = action.newSafetySlPrice;
      updates.stopLossPrice = action.newSafetySlPrice;
    }

    // Update in-memory signal
    (signal as any).hedgeActive = false;
    (signal as any).hedgePhase = undefined;
    (signal as any).hedgeDirection = undefined;
    (signal as any).hedgeEntryPrice = undefined;
    (signal as any).hedgeSimNotional = undefined;
    (signal as any).hedgeTpPrice = undefined;
    (signal as any).hedgeOpenedAt = undefined;
    (signal as any).hedgeCycleCount = cycleCount;
    (signal as any).stopLossPrice = newSlPrice;

    // Don't resume trail SL — let next checkHedge cycle decide if re-entry needed
    // Trail resumes naturally when main PnL > 0 (profitable)

    // Persist to DB
    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      hedgeActive: false,
      $unset: { hedgePhase: 1, hedgeDirection: 1, hedgeEntryPrice: 1, hedgeSimNotional: 1, hedgeTpPrice: 1, hedgeOpenedAt: 1 },
      hedgeCycleCount: cycleCount,
      stopLossPrice: newSlPrice,
      $push: { hedgeHistory: historyEntry },
      ...updates,
    });

    // Create separate COMPLETED record for hedge cycle (standalone trade record)
    try {
      // Recalculate PnL to ensure accuracy
      const hedgeEntry = historyEntry.entryPrice;
      const hedgeExit = currentPrice;
      const hedgeNotional = historyEntry.notional || 0;
      const hedgePnlPct = historyEntry.direction === "LONG"
        ? ((hedgeExit - hedgeEntry) / hedgeEntry) * 100
        : ((hedgeEntry - hedgeExit) / hedgeEntry) * 100;
      const hedgePnlUsdt = Math.round((hedgePnlPct / 100) * hedgeNotional * 100) / 100;

      // Determine close reason based on what triggered the close
      let closeReason = "HEDGE_CLOSE";
      if (action.reason?.includes("Recovery")) closeReason = "HEDGE_RECOVERY";
      else if (action.reason?.includes("trail")) closeReason = "HEDGE_TRAIL";
      else if (action.reason?.includes("TP")) closeReason = "HEDGE_TP";
      else if (hedgePnlUsdt >= 0) closeReason = "HEDGE_TP";

      await this.aiSignalModel.create({
        symbol: signal.symbol,
        coin: (signal as any).coin,
        currency: (signal as any).currency || "usdt",
        direction: historyEntry.direction,
        entryPrice: hedgeEntry,
        exitPrice: hedgeExit,
        stopLossPrice: 0,
        stopLossPercent: 0,
        takeProfitPrice: 0,
        takeProfitPercent: 0,
        strategy: `HEDGE_${(signal as any).strategy || ""}`,
        regime: (signal as any).regime,
        status: "COMPLETED",
        closeReason,
        pnlPercent: Math.round(hedgePnlPct * 100) / 100,
        pnlUsdt: hedgePnlUsdt,
        simNotional: hedgeNotional,
        isTestMode: (signal as any).isTestMode ?? true,
        source: "hedge",
        executedAt: historyEntry.openedAt,
        positionClosedAt: new Date(),
        gridLevels: [],
        primaryKline: (signal as any).primaryKline,
        timeframeProfile: (signal as any).timeframeProfile,
        indicatorSnapshot: { reason: `Hedge cycle #${cycleCount} for ${signal.symbol} ${signal.direction}` },
      });

      this.logger.log(
        `[PositionMonitor] Hedge record created: ${signal.symbol} ${historyEntry.direction} | ${hedgePnlPct.toFixed(2)}% $${hedgePnlUsdt} | ${closeReason}`,
      );
    } catch (err) {
      this.logger.warn(`[PositionMonitor] Failed to create hedge trade record: ${err?.message}`);
    }

    this.logger.log(
      `[PositionMonitor] ${sigKey} HEDGE CLOSED | PnL: ${action.hedgePnlPct?.toFixed(2)}% ($${action.hedgePnlUsdt?.toFixed(2)}) | ` +
      `SL: ${newSlPrice} | Cycle: ${cycleCount} | Reason: ${action.reason}`,
    );

    // Notify via callback
    if (this.hedgeCallback) {
      await this.hedgeCallback(signal, action, currentPrice).catch((err) =>
        this.logger.warn(`[PositionMonitor] hedgeCallback error ${sigKey}: ${err?.message}`),
      );
    }
  }
}
