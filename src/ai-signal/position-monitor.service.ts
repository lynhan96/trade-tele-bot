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

  /** Callback for SL raised to +2% profit (5% milestone). */
  private sl5PctCallback?: (symbol: string, newSl: number, direction: string) => Promise<void>;

  /** Callback for TP boosted on momentum. */
  private tpBoostedCallback?: (symbol: string, newTp: number, newTpPct: number, direction: string) => Promise<void>;

  setResolveCallback(cb: (info: ResolvedSignalInfo) => Promise<void>): void {
    this.resolveCallback = cb;
  }

  setSlMovedCallback(cb: (symbol: string, entryPrice: number) => Promise<void>): void {
    this.slMovedCallback = cb;
  }

  setSl5PctCallback(cb: (symbol: string, newSl: number, direction: string) => Promise<void>): void {
    this.sl5PctCallback = cb;
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
    if ((signal as any).sl5PctRaised) (signal as any).sl5PctRaised = true;
    if ((signal as any).tpBoosted) (signal as any).tpBoosted = true;

    const cb = (price: number) => this.handlePriceTick(signal, price);
    this.listenerRefs.set(sigKey, cb);
    this.watchedSymbols.add(sigKey);
    this.marketDataService.registerPriceListener(symbol, cb);
    this.logger.debug(
      `[PositionMonitor] Watching ${sigKey} — SL: ${signal.stopLossPrice}, TP: ${signal.takeProfitPrice ?? "N/A"} flags: slMoved=${!!(signal as any).slMovedToEntry} sl5Pct=${!!(signal as any).sl5PctRaised}`,
    );
  }

  private unregisterListener(signal: AiSignalDocument): void;
  private unregisterListener(sigKey: string, symbol?: string): void;
  private unregisterListener(signalOrKey: AiSignalDocument | string, symbol?: string): void {
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

    // ─── Auto risk management ─────────────────────────────────────────────
    const pnlPct =
      direction === "LONG"
        ? ((price - entryPrice) / entryPrice) * 100
        : ((entryPrice - price) / entryPrice) * 100;

    // At >= 5% profit — raise SL to lock in 2% profit (trailing stop milestone, don't auto-close)
    // NOTE: must check 5% BEFORE 4% so the higher milestone wins on the same tick
    if (pnlPct >= 5 && !(signal as any).sl5PctRaised) {
      const newSl = direction === "LONG"
        ? entryPrice * 1.02
        : entryPrice * 0.98;
      (signal as any).stopLossPrice = newSl;
      (signal as any).sl5PctRaised = true;
      (signal as any).slMovedToEntry = true; // prevents the 4% block from overwriting this SL on same tick
      await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), newSl);
      this.logger.log(
        `[PositionMonitor] 🚀 ${sigKey} SL raised to +2% (${newSl.toFixed(4)}) at ${pnlPct.toFixed(2)}% profit — still running`,
      );
      if (this.sl5PctCallback) {
        await this.sl5PctCallback(symbol, newSl, direction).catch((e) =>
          this.logger.warn(`[PositionMonitor] sl5PctCallback error ${sigKey}: ${e?.message}`),
        );
      }
      // Propagate SL move to real Binance orders (with retry)
      this.propagateSlMove(sigKey, symbol, newSl, direction);
    }

    // Move SL to entry (break-even) at >= 3% profit (skipped if 5% milestone already triggered)
    if (pnlPct >= 3 && !(signal as any).slMovedToEntry) {
      (signal as any).stopLossPrice = entryPrice;
      (signal as any).slMovedToEntry = true;
      await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
      this.logger.log(
        `[PositionMonitor] 🛡️ ${sigKey} SL moved to entry ${entryPrice} (PnL: ${pnlPct.toFixed(2)}%)`,
      );
      if (this.slMovedCallback) {
        await this.slMovedCallback(symbol, entryPrice).catch((e) =>
          this.logger.warn(`[PositionMonitor] slMovedCallback error ${sigKey}: ${e?.message}`),
        );
      }
      // Propagate SL move to real Binance orders (with retry)
      this.propagateSlMove(sigKey, symbol, entryPrice, direction);
    }

    // ─── Dynamic TP boost: extend TP to 4-6% on strong momentum ─────────
    // Check once when price reaches 3%+ profit and TP hasn't been boosted yet
    if (pnlPct >= 3 && !(signal as any).tpBoosted && takeProfitPrice) {
      (signal as any).tpBoosted = true; // mark as checked (one-time per signal)
      try {
        const hasMomentum = await this.marketDataService.hasVolumeMomentum(symbol);
        if (hasMomentum) {
          // Extend TP based on current momentum (4-6% range)
          const boostedTpPct = Math.min(6, Math.max(4, pnlPct + 2));
          const newTpPrice = direction === "LONG"
            ? entryPrice * (1 + boostedTpPct / 100)
            : entryPrice * (1 - boostedTpPct / 100);
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

    // ─── Original TP/SL check ─────────────────────────────────────────────
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
    this.logger.log(
      `[PositionMonitor] ${emoji} ${sigKey} price=${price} hit ${reason} (${direction} SL=${stopLossPrice} TP=${takeProfitPrice ?? "none"})`,
    );

    try {
      const resolved = await this.signalQueueService.resolveActiveSignal(
        sigKey,
        price,
        reason,
      );

      if (resolved) {
        const promoted = await this.signalQueueService.activateQueuedSignal(
          sigKey,
        );
        if (promoted) {
          this.registerListener(promoted);
          this.logger.log(
            `[PositionMonitor] ${sigKey} queued signal promoted to ACTIVE`,
          );
        }

        // Notify AiSignalService so it can send Telegram messages
        if (this.resolveCallback) {
          const pnlPercent =
            signal.direction === "LONG"
              ? ((price - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - price) / signal.entryPrice) * 100;

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

          const promoted =
            await this.signalQueueService.activateQueuedSignal(sigKey);
          if (promoted) {
            this.registerListener(promoted);
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
    this.userRealTradingService.moveStopLossForRealUsers(symbol, newSl, direction).catch((err) => {
      this.logger.error(`[PositionMonitor] ${sigKey} moveStopLoss failed, retrying: ${err?.message}`);
      setTimeout(() => {
        this.userRealTradingService.moveStopLossForRealUsers(symbol, newSl, direction).catch((err2) => {
          this.logger.error(`[PositionMonitor] ${sigKey} moveStopLoss retry failed: ${err2?.message}`);
        });
      }, 3000);
    });
  }

  private propagateTpMove(sigKey: string, symbol: string, newTp: number, direction: string): void {
    this.userRealTradingService.moveTpForRealUsers(symbol, newTp, direction).catch((err) => {
      this.logger.error(`[PositionMonitor] ${sigKey} moveTp failed, retrying: ${err?.message}`);
      setTimeout(() => {
        this.userRealTradingService.moveTpForRealUsers(symbol, newTp, direction).catch((err2) => {
          this.logger.error(`[PositionMonitor] ${sigKey} moveTp retry failed: ${err2?.message}`);
        });
      }, 3000);
    });
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
