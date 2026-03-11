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

    // ─── Grid Recovery Simulation (signal level) ───────────────────────────
    // Simulates grid recovery at signal level for test mode stats.
    // 5 grids (base + 4), each 20% volume. Each grid has individual TP (+0.3%).
    // Global SL at -3.5% from original entry. Partial closes per grid.
    const GRID_DEVIATION_STEP = 0.5; // % step between grids
    const GRID_LEVEL_COUNT = 5;      // base + 4 grids
    const GRID_TP_PCT = 0.3;         // each grid's TP: +0.3% from fill
    const GRID_GLOBAL_SL_PCT = 3.5;  // global SL: -3.5% from original entry
    const GRID_VOLUME_PCT = 100 / GRID_LEVEL_COUNT; // 20% each

    const gridLevels: any[] = (signal as any).gridLevels ?? [];
    const isGridSignal = gridLevels.length > 0;

    // Initialize grid on first tick (base grid = level 0)
    if (!isGridSignal) {
      const origEntry = entryPrice;
      const grids: any[] = [];

      // Simulated volume: $1000 balance × 10x leverage = $10,000 notional total
      const SIM_BALANCE = 1000;
      const SIM_LEVERAGE = 10;
      const simNotional = SIM_BALANCE * SIM_LEVERAGE;
      const simGridNotional = simNotional / GRID_LEVEL_COUNT; // per grid
      const simQuantity = simNotional / origEntry;

      for (let i = 0; i < GRID_LEVEL_COUNT; i++) {
        const dev = i * GRID_DEVIATION_STEP;
        if (i === 0) {
          // Base grid: already filled at entry price
          const tp = direction === "LONG"
            ? origEntry * (1 + GRID_TP_PCT / 100)
            : origEntry * (1 - GRID_TP_PCT / 100);
          grids.push({
            level: 0, deviationPct: 0, fillPrice: origEntry,
            tpPrice: tp, volumePct: GRID_VOLUME_PCT,
            status: "FILLED", filledAt: new Date(),
            simNotional: simGridNotional, simQuantity: simGridNotional / origEntry,
          });
        } else {
          grids.push({
            level: i, deviationPct: dev, fillPrice: 0,
            tpPrice: 0, volumePct: GRID_VOLUME_PCT,
            status: "PENDING",
          });
        }
      }
      const globalSl = direction === "LONG"
        ? origEntry * (1 - GRID_GLOBAL_SL_PCT / 100)
        : origEntry * (1 + GRID_GLOBAL_SL_PCT / 100);

      (signal as any).gridLevels = grids;
      (signal as any).originalEntryPrice = origEntry;
      (signal as any).gridGlobalSlPrice = globalSl;
      (signal as any).gridFilledCount = 1;
      (signal as any).gridClosedCount = 0;
      (signal as any).stopLossPrice = globalSl;
      (signal as any).simNotional = simNotional;
      (signal as any).simQuantity = simQuantity;

      await this.signalQueueService.updateSignalGrid(
        (signal as any)._id.toString(), grids, 1, 0,
      );
      await this.signalQueueService.initGridSignal(
        (signal as any)._id.toString(), origEntry, globalSl,
      );
      // Persist simulated volume
      await this.signalQueueService.updateSimVolume(
        (signal as any)._id.toString(), simNotional, simQuantity,
      );
      this.logger.log(
        `[PositionMonitor] Grid init ${sigKey}: ${GRID_LEVEL_COUNT} levels, SL=${globalSl.toFixed(4)}, Vol=$${simNotional.toFixed(0)}, Qty=${simQuantity.toFixed(4)}`,
      );
    }

    // Process grid events
    if ((signal as any).gridLevels?.length > 0) {
      const grids: any[] = (signal as any).gridLevels;
      const origEntry = (signal as any).originalEntryPrice ?? entryPrice;
      const globalSl = (signal as any).gridGlobalSlPrice;
      let gridChanged = false;
      let filledCount = (signal as any).gridFilledCount ?? 1;
      let closedCount = (signal as any).gridClosedCount ?? 0;

      // Check PENDING grids: price dropped enough → simulate fill
      for (const grid of grids) {
        if (grid.status !== "PENDING") continue;
        const triggerPrice = direction === "LONG"
          ? origEntry * (1 - grid.deviationPct / 100)
          : origEntry * (1 + grid.deviationPct / 100);
        const triggered = direction === "LONG" ? price <= triggerPrice : price >= triggerPrice;
        if (triggered) {
          grid.status = "FILLED";
          grid.fillPrice = price;
          grid.filledAt = new Date();
          grid.tpPrice = direction === "LONG"
            ? price * (1 + GRID_TP_PCT / 100)
            : price * (1 - GRID_TP_PCT / 100);
          // Simulated volume for this grid level
          const simTotalNotional = (signal as any).simNotional || 10000;
          const gridNotional = simTotalNotional / GRID_LEVEL_COUNT;
          grid.simNotional = gridNotional;
          grid.simQuantity = gridNotional / price;
          filledCount++;
          gridChanged = true;
          this.logger.log(
            `[PositionMonitor] Grid ${sigKey} L${grid.level} FILLED at ${price.toFixed(4)}, TP=${grid.tpPrice.toFixed(4)}, Qty=${grid.simQuantity.toFixed(4)}`,
          );
        }
      }

      // Check FILLED grids: price hit individual TP → partial close
      for (const grid of grids) {
        if (grid.status !== "FILLED") continue;
        const tpHit = direction === "LONG" ? price >= grid.tpPrice : price <= grid.tpPrice;
        if (tpHit) {
          grid.status = "TP_CLOSED";
          grid.closedAt = new Date();
          grid.pnlPct = direction === "LONG"
            ? ((grid.tpPrice - grid.fillPrice) / grid.fillPrice) * 100
            : ((grid.fillPrice - grid.tpPrice) / grid.fillPrice) * 100;
          grid.pnlUsdt = (grid.pnlPct / 100) * (grid.simNotional || 0);
          closedCount++;
          gridChanged = true;
          this.logger.log(
            `[PositionMonitor] Grid ${sigKey} L${grid.level} TP_CLOSED +${grid.pnlPct.toFixed(2)}% (+${grid.pnlUsdt?.toFixed(2)} USDT)`,
          );
        }
      }

      // Check global SL hit on remaining FILLED grids
      const slHitGlobal = direction === "LONG" ? price <= globalSl : price >= globalSl;
      if (slHitGlobal) {
        for (const grid of grids) {
          if (grid.status === "FILLED") {
            grid.status = "SL_CLOSED";
            grid.closedAt = new Date();
            grid.pnlPct = direction === "LONG"
              ? ((globalSl - grid.fillPrice) / grid.fillPrice) * 100
              : ((grid.fillPrice - globalSl) / grid.fillPrice) * 100;
            grid.pnlUsdt = (grid.pnlPct / 100) * (grid.simNotional || 0);
            closedCount++;
            gridChanged = true;
          }
          if (grid.status === "PENDING") {
            grid.status = "SL_CLOSED"; // never filled, no loss
            grid.pnlPct = 0;
            grid.pnlUsdt = 0;
            closedCount++;
            gridChanged = true;
          }
        }
      }

      // Persist if changed
      if (gridChanged) {
        (signal as any).gridLevels = grids;
        (signal as any).gridFilledCount = filledCount;
        (signal as any).gridClosedCount = closedCount;

        // Calculate blended PnL (weighted by volumePct, only include filled+closed)
        const closedGrids = grids.filter(
          (g) => g.status === "TP_CLOSED" || g.status === "SL_CLOSED",
        );
        const totalVolPct = closedGrids.reduce((s, g) => s + (g.pnlPct != null ? g.volumePct : 0), 0);
        const blendedPnl = totalVolPct > 0
          ? closedGrids.reduce((s, g) => s + (g.pnlPct ?? 0) * g.volumePct, 0) / totalVolPct
          : 0;
        // Calculate total simulated USDT PnL
        const totalPnlUsdt = closedGrids.reduce((s, g) => s + (g.pnlUsdt ?? 0), 0);

        // Check if all grids resolved
        const allResolved = grids.every(
          (g) => g.status === "TP_CLOSED" || g.status === "SL_CLOSED",
        );

        if (allResolved) {
          const closeReason = grids.some((g) => g.status === "SL_CLOSED")
            ? "STOP_LOSS" : "TAKE_PROFIT";
          const exitPrice = slHitGlobal ? globalSl : price;

          // Resolve via signal queue (marks COMPLETED)
          const resolved = await this.signalQueueService.resolveGridSignal(
            (signal as any)._id.toString(), grids, closedCount,
            blendedPnl, exitPrice, closeReason,
          );

          if (resolved) {
            // Persist simulated USDT PnL
            if (totalPnlUsdt !== 0) {
              await this.signalQueueService.updateSimPnlUsdt(
                (signal as any)._id.toString(), totalPnlUsdt,
              );
            }
            this.unregisterListener(signal);
            this.resolvingSymbols.add(sigKey);
            const emoji = closeReason === "TAKE_PROFIT" ? "🎯" : "🛑";
            const usdSign = totalPnlUsdt >= 0 ? "+" : "";
            this.logger.log(
              `[PositionMonitor] ${emoji} Grid ${sigKey} ALL RESOLVED: ${closeReason} PnL=${blendedPnl.toFixed(2)}% (${usdSign}${totalPnlUsdt.toFixed(2)} USDT)`,
            );
            // Fire resolve callback for notifications + queued signal promotion
            if (this.resolveCallback) {
              await this.resolveCallback({
                symbol, signalKey: sigKey, direction,
                entryPrice: (signal as any).originalEntryPrice ?? entryPrice,
                exitPrice, pnlPercent: blendedPnl,
                pnlUsdt: totalPnlUsdt,
                simNotional: (signal as any).simNotional,
                closeReason, queuedSignalActivated: false,
              }).catch((e) =>
                this.logger.warn(`[PositionMonitor] resolveCallback error: ${e?.message}`),
              );
            }
            this.resolvingSymbols.delete(sigKey);
          }
          return; // signal fully resolved
        } else {
          // Partial update — some grids closed but signal stays ACTIVE
          await this.signalQueueService.updateSignalGrid(
            (signal as any)._id.toString(), grids, filledCount, closedCount,
          );
        }
      }

      return; // Grid signals skip trailing stop and legacy TP/SL check
    }

    // ─── Auto risk management (non-grid signals only) ─────────────────────
    const currentEntry = entryPrice;
    const pnlPct =
      direction === "LONG"
        ? ((price - currentEntry) / currentEntry) * 100
        : ((currentEntry - price) / currentEntry) * 100;

    // ── Trailing SL: after 1.5% profit, trail SL at peak - 0.8% (never lower) ──
    const TRAIL_TRIGGER = 1.5;   // activate trailing at 1.5% profit
    const TRAIL_DISTANCE = 0.8;  // SL stays 0.8% below peak — tighter trail keeps more gains

    // Track peak PnL for this signal
    const prevPeak = (signal as any).peakPnlPct || 0;
    if (pnlPct > prevPeak) {
      (signal as any).peakPnlPct = pnlPct;
    }
    const peak = (signal as any).peakPnlPct || 0;

    if (peak >= TRAIL_TRIGGER && !(signal as any).slMovedToEntry) {
      // First time reaching 1.5% → move SL to entry (break-even)
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

    // Continuous trailing: SL = entry + (peak - TRAIL_DISTANCE)%, only raise
    if ((signal as any).slMovedToEntry && peak > TRAIL_TRIGGER) {
      const trailPct = Math.max(0, peak - TRAIL_DISTANCE); // lock-in % (never below 0 = entry)
      const trailSl = direction === "LONG"
        ? currentEntry * (1 + trailPct / 100)
        : currentEntry * (1 - trailPct / 100);

      const currentSl = (signal as any).stopLossPrice || currentEntry;
      // Only raise SL, never lower
      const shouldRaise = direction === "LONG" ? trailSl > currentSl : trailSl < currentSl;

      if (shouldRaise) {
        (signal as any).stopLossPrice = trailSl;
        // Persist to DB
        await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
        this.logger.log(
          `[PositionMonitor] 📈 ${sigKey} trailing SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak: ${peak.toFixed(2)}%`,
        );
        // Propagate to Binance real orders
        this.propagateSlMove(sigKey, symbol, trailSl, direction);
      }
    }

    // ─── Dynamic TP boost: extend TP on strong momentum ─────────────────
    // Triggers at 2.0% profit (was 3.5% — never fired since avg peak is ~2.3%)
    if (pnlPct >= 2.0 && !(signal as any).tpBoosted && takeProfitPrice) {
      (signal as any).tpBoosted = true; // mark as checked (one-time per signal)
      try {
        const hasMomentum = await this.marketDataService.hasVolumeMomentum(symbol);
        if (hasMomentum) {
          // Extend TP by 2% from current position, cap at 6%
          const currentTpPct = Math.abs(takeProfitPrice - currentEntry) / currentEntry * 100;
          const boostedTpPct = Math.min(6, Math.max(currentTpPct, pnlPct + 2.0));
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
          this.userRealTradingService.onSignalActivated(promoted, {} as any).catch((err) =>
            this.logger.error(`[PositionMonitor] Real trading error (queued promoted): ${err?.message}`),
          );
          this.logger.log(
            `[PositionMonitor] ${sigKey} queued signal promoted to ACTIVE`,
          );
        }

        // Notify AiSignalService so it can send Telegram messages
        if (this.resolveCallback) {
          const pnlPercent =
            signal.direction === "LONG"
              ? ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;

          await this.resolveCallback({
            symbol,
            signalKey: sigKey,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            exitPrice: price,
            pnlPercent,
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
            this.userRealTradingService.onSignalActivated(promoted, {} as any).catch((err) =>
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
