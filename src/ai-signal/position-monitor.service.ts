import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { MarketDataService } from "../market-data/market-data.service";
import { SignalQueueService } from "./signal-queue.service";
import { AiSignalDocument } from "../schemas/ai-signal.schema";
import { UserRealTradingService } from "./user-real-trading.service";

export interface ResolvedSignalInfo {
  symbol: string;
  signalKey: string; // profile-aware key (e.g. "BTCUSDT:INTRADAY" for dual coins)
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  pnlUsdt?: number; // simulated USDT PnL (test mode grid)
  simNotional?: number; // simulated notional volume
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

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly binanceService: BinanceService,
    private readonly marketDataService: MarketDataService,
    private readonly signalQueueService: SignalQueueService,
    private readonly userRealTradingService: UserRealTradingService,
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

    const cb = (price: number) => this.handlePriceTick(signal, price);
    this.listenerRefs.set(sigKey, cb);
    this.watchedSymbols.add(sigKey);
    this.marketDataService.registerPriceListener(symbol, cb);
    this.logger.debug(
      `[PositionMonitor] Watching ${sigKey} — SL: ${signal.stopLossPrice}, TP: ${signal.takeProfitPrice ?? "N/A"} slMoved=${!!(signal as any).slMovedToEntry} peak=${(signal as any).peakPnlPct ?? 0}`,
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
    const GRID_LEVEL_COUNT = 5;
    // DCA volume weights: L0=40% base, remaining 60% DCA-weighted for L1-L4 (sum=100)
    const DCA_WEIGHTS = [40, 6, 12, 18, 24];

    const gridLevels: any[] = (signal as any).gridLevels ?? [];
    const isGridSignal = gridLevels.length > 0;

    // Initialize grid on first tick (base grid = level 0)
    if (!isGridSignal) {
      const origEntry = entryPrice;
      const stopLossPrice = (signal as any).stopLossPrice;
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

      // Check PENDING grids: price moved against position → simulate fill
      // RSI guard: only DCA when RSI shows exhaustion (likely to bounce)
      let rsiOk: boolean | null = null; // null = not yet computed
      const coin = signal.symbol.replace("USDT", "");

      for (const grid of grids) {
        if (grid.status !== "PENDING") continue;
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

          // RSI + momentum guard for L1+ (extended from L2+ — L1 no longer exempt)
          // Prevents DCA during continuous selling (xả liên tục)
          if (grid.level >= 1 && rsiOk === null) {
            try {
              const closes = await this.marketDataService.getClosePrices(coin, "15m");
              if (closes.length >= 14) {
                const { RSI } = require("technicalindicators");
                const rsiVals = RSI.calculate({ period: 14, values: closes });
                const rsi = rsiVals[rsiVals.length - 1];
                // LONG: only DCA if oversold (RSI<40). SHORT: only DCA if overbought (RSI>60)
                const rsiExhausted = direction === "LONG" ? rsi < 40 : rsi > 60;

                // Sustained momentum check: if last 3 closes are all declining (LONG) or rising (SHORT),
                // selling/buying is still active — wait for at least 1 stabilization candle
                const last4 = closes.slice(-4);
                const sustainedAgainst = last4.length >= 4 && (
                  direction === "LONG"
                    ? last4[3] < last4[2] && last4[2] < last4[1] && last4[1] < last4[0]
                    : last4[3] > last4[2] && last4[2] > last4[1] && last4[1] > last4[0]
                );

                rsiOk = rsiExhausted && !sustainedAgainst;
                if (!rsiOk) {
                  this.logger.log(
                    `[PositionMonitor] Grid ${sigKey} L${grid.level} RSI=${rsi.toFixed(1)} sustained=${sustainedAgainst} — skip DCA (waiting for exhaustion/stabilization)`,
                  );
                }
              } else {
                rsiOk = true; // not enough data, allow fill
              }
            } catch {
              rsiOk = true; // fail-open
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

          // SL stays at original entry's SL — do NOT move SL when DCA fills.
          // Moving SL from avgEntry pushes it further against us, increasing max loss.
          // Only TP recalculates from avgEntry (so profit target reflects average cost).
          // Note: tpBoosted only blocks momentum boost (one-time at 2% peak),
          // NOT avg-entry recalc — grids must always recalc TP from new avgEntry.
          const tpPct = (signal as any).takeProfitPercent;
          if (tpPct > 0) {
            const newTp = direction === "LONG"
              ? avgEntry * (1 + tpPct / 100)
              : avgEntry * (1 - tpPct / 100);
            (signal as any).takeProfitPrice = newTp;
            this.propagateTpMove(sigKey, symbol, newTp, direction);
          }

          this.logger.log(
            `[PositionMonitor] Grid ${sigKey} L${grid.level} FILLED at ${price.toFixed(4)}, avgEntry=${avgEntry.toFixed(4)}, SL=${(signal as any).stopLossPrice?.toFixed(4)}, TP=${(signal as any).takeProfitPrice?.toFixed(4)}, filled=${filledCount}/${GRID_LEVEL_COUNT}`,
          );
        }
      }

      // Trailing stop for grid DCA: uses avg entry
      // TP/SL hit detection handled by normal path below (falls through)
      const filledGrids = grids.filter((g) => g.status === "FILLED");
      if (filledGrids.length > 0) {
        const TRAIL_TRIGGER = 1.5;
        const TRAIL_DISTANCE = 0.8;
        const pnlFromAvg = direction === "LONG"
          ? ((price - avgEntry) / avgEntry) * 100
          : ((avgEntry - price) / avgEntry) * 100;

        const prevPeak = (signal as any).peakPnlPct || 0;
        if (pnlFromAvg > prevPeak) {
          (signal as any).peakPnlPct = pnlFromAvg;
        }
        const peak = (signal as any).peakPnlPct || 0;

        // Move SL to avg entry (break-even) at 1.5% from avg
        if (peak >= TRAIL_TRIGGER && !(signal as any).slMovedToEntry) {
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
          this.propagateSlMove(sigKey, symbol, avgEntry, direction);
        }

        // Continuous trailing: SL = avgEntry + (peak - 0.8%)
        if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER) {
          const trailPct = Math.max(0, peak - TRAIL_DISTANCE);
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
            this.propagateSlMove(sigKey, symbol, trailSl, direction);
          }
        }

        // TP boost at 2% peak from avg entry
        if (pnlFromAvg >= 2.0 && !(signal as any).tpBoosted && signalTp) {
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
    if (!isGridSignal) {
      const TRAIL_TRIGGER = 1.5;
      const TRAIL_DISTANCE = 0.8;

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
        this.propagateSlMove(sigKey, symbol, currentEntry, direction);
      }

      if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER) {
        const trailPct = Math.max(0, peak - TRAIL_DISTANCE);
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
          this.propagateSlMove(sigKey, symbol, trailSl, direction);
        }
      }
    }

    // ─── Dynamic TP boost: extend TP on strong momentum ─────────────────
    if (pnlPct >= 2.0 && !(signal as any).tpBoosted && takeProfitPrice) {
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
            pnlUsdt = (pnlPercent / 100) * ((signal as any).simNotional || 1000);
          }

          await this.resolveCallback({
            symbol,
            signalKey: sigKey,
            direction: signal.direction,
            entryPrice: entryForPnl,
            exitPrice,
            pnlPercent,
            pnlUsdt,
            simNotional: (signal as any).simNotional,
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

          const pnlPercent =
            signal.direction === "LONG"
              ? ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;

          resolved.push({
            symbol,
            signalKey: sigKey,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
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
}
