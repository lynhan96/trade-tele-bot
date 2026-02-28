import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { MarketDataService } from "../market-data/market-data.service";
import { SignalQueueService } from "./signal-queue.service";
import { AiSignalDocument } from "../schemas/ai-signal.schema";

export interface ResolvedSignalInfo {
  symbol: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  closeReason: string;
  queuedSignalActivated: boolean;
}

const MONITOR_POSITIONS_KEY = "cache:ai:monitor:positions";
const MONITOR_POSITIONS_TTL = 60; // 60s

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

  setResolveCallback(cb: (info: ResolvedSignalInfo) => Promise<void>): void {
    this.resolveCallback = cb;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly binanceService: BinanceService,
    private readonly marketDataService: MarketDataService,
    private readonly signalQueueService: SignalQueueService,
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
    // Register real-time price listeners for any ACTIVE signals that already
    // exist in the DB (e.g. after a bot restart).
    const activeSignals = await this.signalQueueService.getAllActiveSignals();
    for (const signal of activeSignals) {
      this.registerListener(signal);
    }
    if (activeSignals.length > 0) {
      this.logger.log(
        `[PositionMonitor] Registered real-time listeners for ${activeSignals.length} existing ACTIVE signal(s)`,
      );
    }
  }

  // ─── Real-time price listener management ─────────────────────────────────

  /**
   * Register a price tick listener for a signal.
   * Safe to call multiple times — skips if already watching.
   */
  registerListener(signal: AiSignalDocument): void {
    const { symbol } = signal;
    if (this.watchedSymbols.has(symbol)) return;

    const cb = (price: number) => this.handlePriceTick(signal, price);
    this.listenerRefs.set(symbol, cb);
    this.watchedSymbols.add(symbol);
    this.marketDataService.registerPriceListener(symbol, cb);
    this.logger.debug(
      `[PositionMonitor] Watching ${symbol} — SL: ${signal.stopLossPrice}, TP: ${signal.takeProfitPrice ?? "N/A"}`,
    );
  }

  private unregisterListener(symbol: string): void {
    const cb = this.listenerRefs.get(symbol);
    if (cb) {
      this.marketDataService.unregisterPriceListener(symbol, cb);
      this.listenerRefs.delete(symbol);
    }
    this.watchedSymbols.delete(symbol);
  }

  // ─── Real-time TP/SL check ────────────────────────────────────────────────

  private async handlePriceTick(
    signal: AiSignalDocument,
    price: number,
  ): Promise<void> {
    const { symbol, direction, stopLossPrice, takeProfitPrice } = signal;

    const slHit =
      direction === "LONG" ? price <= stopLossPrice : price >= stopLossPrice;
    const tpHit = takeProfitPrice
      ? direction === "LONG"
        ? price >= takeProfitPrice
        : price <= takeProfitPrice
      : false;

    if (!slHit && !tpHit) return;

    // Prevent double-trigger: unregister first, then resolve
    if (this.resolvingSymbols.has(symbol)) return;
    this.resolvingSymbols.add(symbol);
    this.unregisterListener(symbol);

    const reason = tpHit ? "TAKE_PROFIT" : "STOP_LOSS";
    const emoji = tpHit ? "🎯" : "🛑";
    this.logger.log(
      `[PositionMonitor] ${emoji} ${symbol} price=${price} hit ${reason} (${direction} SL=${stopLossPrice} TP=${takeProfitPrice ?? "none"})`,
    );

    try {
      const resolved = await this.signalQueueService.resolveActiveSignal(
        symbol,
        price,
        reason,
      );

      if (resolved) {
        const promoted = await this.signalQueueService.activateQueuedSignal(
          symbol,
        );
        if (promoted) {
          this.registerListener(promoted);
          this.logger.log(
            `[PositionMonitor] ${symbol} queued signal promoted to ACTIVE`,
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
      this.resolvingSymbols.delete(symbol);
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

        // If position for this symbol is still open → no action
        if (openPositions.has(symbol)) continue;

        // Guard: don't double-resolve if real-time listener already caught it
        if (this.resolvingSymbols.has(symbol)) continue;
        if (!this.watchedSymbols.has(symbol) && !(await this.signalQueueService.getActiveSignal(symbol))) {
          // Already resolved
          continue;
        }

        this.resolvingSymbols.add(symbol);
        this.unregisterListener(symbol);

        // Get current price to record exit
        const exitPrice = await this.getCurrentPrice(symbol);
        if (!exitPrice || exitPrice <= 0) {
          this.logger.warn(
            `[PositionMonitor] ${symbol} price fetch returned 0 — skipping resolution`,
          );
          this.resolvingSymbols.delete(symbol);
          continue;
        }

        try {
          const resolvedSignal =
            await this.signalQueueService.resolveActiveSignal(
              symbol,
              exitPrice,
              "POSITION_CLOSED",
            );

          const promoted =
            await this.signalQueueService.activateQueuedSignal(symbol);
          if (promoted) {
            this.registerListener(promoted);
          }

          const pnlPercent =
            signal.direction === "LONG"
              ? ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;

          resolved.push({
            symbol,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            exitPrice,
            pnlPercent,
            closeReason: "POSITION_CLOSED",
            queuedSignalActivated: !!promoted,
          });

          if (promoted) {
            this.logger.log(
              `[PositionMonitor] ${symbol} position closed — queued signal now ACTIVE`,
            );
          }
        } finally {
          this.resolvingSymbols.delete(symbol);
        }
      }
    } catch (err) {
      this.logger.error(
        `[PositionMonitor] checkAndResolve error: ${err?.message}`,
      );
    }

    return resolved;
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
    try {
      const axios = require("axios");
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
        { timeout: 5000 },
      );
      return parseFloat(res.data.price);
    } catch {
      return 0;
    }
  }
}
