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
import { Order, OrderDocument } from "../schemas/order.schema";
import { RSI } from "technicalindicators";

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

/** Order types that represent the main position (includes promoted hedge after FLIP). */
const MAIN_ORDER_TYPES = { $in: ['MAIN', 'FLIP_MAIN'] };

/** Coins that run BOTH INTRADAY and SWING strategies simultaneously. */
import { DUAL_TIMEFRAME_COINS, GRID_DEVIATIONS, DCA_WEIGHTS } from './constants';

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

  /** Per-signal concurrency guard — prevents multiple ticks processing same signal simultaneously */
  private processingSignals = new Set<string>();

  /** Debounce timers for SL/TP propagation — prevents rapid tick spam to Binance */
  private slDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tpDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** In-memory order cache — avoids 500+ DB queries/s on price ticks */
  private orderCache = new Map<string, { main: any; hedge: any; ts: number }>();
  private readonly ORDER_CACHE_TTL = 5000; // 5s — invalidated on writes

  private getCachedOrders(signalId: string) {
    const c = this.orderCache.get(signalId);
    if (c && Date.now() - c.ts < this.ORDER_CACHE_TTL) return c;
    return null;
  }

  private setCachedOrders(signalId: string, main: any, hedge: any) {
    this.orderCache.set(signalId, { main, hedge, ts: Date.now() });
  }

  /** Invalidate cache after DB writes (hedge open/close, grid fill, SL/TP update) */
  invalidateOrderCache(signalId: string) {
    this.orderCache.delete(signalId);
  }

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

  // realHedgeCallback REMOVED — real hedge follows sim via hedgeCallback → onHedgeEvent

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
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
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

  // ─── Fee Helpers (Binance Futures sim) ────────────────────────────────────

  /** Calculate taker fee in USDT (market order — open/close) */
  /** Build HedgePositionContext from Order records (sim path) */
  private buildSimHedgeContext(
    signal: AiSignalDocument,
    mainOrder: any,
    hedgeOrder: any,
  ): import('./hedge-manager.service').HedgePositionContext {
    const orderMeta = mainOrder?.metadata || {};
    const gridLevels = orderMeta.gridLevels ?? (signal as any).gridLevels ?? [];
    const filledVolume = gridLevels
      .filter((g: any) => g.status === 'FILLED')
      .reduce((s: number, g: any) => s + (g.simNotional || 0), 0);

    return {
      id: (signal as any)._id?.toString(),
      symbol: signal.symbol,
      coin: (signal as any).coin || signal.symbol.replace('USDT', ''),
      direction: signal.direction,
      entryPrice: mainOrder?.entryPrice ?? (signal as any).gridAvgEntry ?? signal.entryPrice,
      positionNotional: filledVolume > 0 ? filledVolume : ((signal as any).simNotional || 1000),
      hedgeActive: !!hedgeOrder,
      hedgeCycleCount: (signal as any).hedgeCycleCount || 0,
      hedgeHistory: (signal as any).hedgeHistory || [],
      hedgeEntryPrice: hedgeOrder?.entryPrice,
      hedgeDirection: hedgeOrder?.direction,
      hedgeNotional: hedgeOrder?.notional,
      hedgeTpPrice: hedgeOrder?.takeProfitPrice,
      hedgeSlAtEntry: (signal as any).hedgeSlAtEntry,
      hedgeTrailActivated: (signal as any).hedgeTrailActivated,
      hedgeSafetySlPrice: (signal as any).hedgeSafetySlPrice,
      hedgeOpenedAt: hedgeOrder?.openedAt,
      hedgePhase: (signal as any).hedgePhase,
      hedgePeakPnlPct: (signal as any).hedgePeakPnlPct,
      hedgePeakUpdatedAt: (signal as any).hedgePeakUpdatedAt,
      stopLossPrice: (signal as any).stopLossPrice,
      fundingRate: (signal as any).fundingRate,
    };
  }

  /** DCA volume weights: L0=35% base, remaining 65% linearly increasing */
  private getDcaWeights(levelCount: number): number[] {
    if (levelCount <= 1) return [100];
    const baseWeight = 35;
    const remaining = 100 - baseWeight;
    const dcaCount = levelCount - 1;
    const raw = Array.from({ length: dcaCount }, (_, i) => i + 1);
    const total = raw.reduce((s, v) => s + v, 0);
    const dcaWeights = raw.map((v) => Math.round((v / total) * remaining * 10) / 10);
    return [baseWeight, ...dcaWeights];
  }

  private calcTakerFee(notional: number): number {
    const cfg = this.tradingConfig.get();
    return +(notional * cfg.simTakerFeePct / 100).toFixed(4);
  }

  /** Calculate maker fee in USDT (limit order — grid DCA fills) */
  private calcMakerFee(notional: number): number {
    const cfg = this.tradingConfig.get();
    return +(notional * cfg.simMakerFeePct / 100).toFixed(4);
  }

  /** Calculate funding fee for a position held N hours */
  private calcFundingFee(notional: number, fundingRate: number, hoursHeld: number): number {
    // Binance charges funding every 8h. fundingRate is per-interval (e.g. 0.0001 = 0.01%)
    const intervals = Math.floor(hoursHeld / 8);
    if (intervals <= 0) return 0;
    return +(notional * fundingRate * intervals).toFixed(4);
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

    // Recover orphan orders: OPEN orders whose signal is missing or not ACTIVE
    // This happens when signal gets deleted/completed but order persists (e.g., after FLIP + protectOpenTrades)
    try {
      const openOrders = await this.orderModel.find({
        status: 'OPEN', type: { $in: ['MAIN', 'FLIP_MAIN'] },
      }).lean();
      this.logger.log(`[PositionMonitor] Orphan check: ${openOrders.length} OPEN main orders found`);
      for (const order of openOrders) {
        if (!order.signalId) continue;
        const existingSignal = await this.aiSignalModel.findById(order.signalId);
        if (existingSignal && existingSignal.status === 'ACTIVE') continue; // Signal OK

        // Signal missing or not ACTIVE — recover it
        const meta = (order as any).metadata || {};
        const gridLevels = meta.gridLevels || [{ level: 0, status: 'FILLED', triggerPct: 0, volumePct: 100, simNotional: order.notional }];
        const signalData = {
          symbol: order.symbol,
          coin: order.symbol.replace('USDT', ''),
          direction: order.direction,
          entryPrice: order.entryPrice,
          gridAvgEntry: order.entryPrice,
          originalEntryPrice: order.entryPrice,
          stopLossPrice: order.stopLossPrice,
          takeProfitPrice: order.takeProfitPrice,
          stopLossPercent: 40,
          takeProfitPercent: this.tradingConfig.get().tpMax || 4,
          status: 'ACTIVE' as const,
          simNotional: meta.simNotional || order.notional || 1000,
          executedAt: order.openedAt || new Date(),
          hedgeCycleCount: 0, hedgeHistory: [],
          slMovedToEntry: meta.slMovedToEntry || false,
          peakPnlPct: meta.peakPnlPct || 0,
          tpBoostLevel: 0,
          gridLevels,
        };
        try {
          if (existingSignal) {
            // Signal exists but not ACTIVE (e.g., COMPLETED) — reactivate
            await this.aiSignalModel.findByIdAndUpdate(order.signalId, { $set: signalData });
            this.logger.warn(`[PositionMonitor] Reactivated signal ${order.symbol} ${order.direction} (was ${existingSignal.status})`);
          } else {
            // Signal completely missing — create new
            await this.aiSignalModel.create({ _id: order.signalId, ...signalData });
            this.logger.warn(`[PositionMonitor] Recovered orphan → created signal ${order.symbol} ${order.direction} (${order.signalId})`);
          }
        } catch (createErr) {
          this.logger.error(`[PositionMonitor] Failed to recover ${order.symbol}: ${(createErr as any)?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[PositionMonitor] Orphan order recovery failed: ${(err as any)?.message}`);
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
    if ((signal as any).tpBoostLevel) (signal as any).tpBoostLevel = (signal as any).tpBoostLevel;
    // peakPnlPct is already restored from DB via signal object

    // When hedge enabled: ensure SL > hedge trigger so hedge has room to open
    // When hedge enabled: SL = 0 (disabled). Hedge manages risk. Catastrophic stop at -25%.
    const hedgeCfg = this.tradingConfig?.get();
    // SL already set to 40% safety net in signal-queue. No override needed.
    // Trail SL will tighten when profitable. Hedge triggers at -3%.
    if (hedgeCfg?.hedgeEnabled) {
      if (!(signal as any).originalSlPrice && (signal as any).stopLossPrice > 0) {
        (signal as any).originalSlPrice = (signal as any).stopLossPrice;
      }
      this.logger.log(
        `[PositionMonitor] ${sigKey} SL: ${(signal as any).stopLossPrice} (40% safety, hedge at -3%)`,
      );
    }

    const cb = (price: number) => {
      this.handlePriceTick(signal, price).catch((err) =>
        this.logger.error(`[PositionMonitor] ${symbol} tick error: ${err?.message}`, err?.stack),
      );
    };
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
    const sigKey = this.getSignalKey(signal);

    // Per-signal concurrency guard — prevents duplicate hedge opens from concurrent ticks
    if (this.processingSignals.has(sigKey)) return;
    this.processingSignals.add(sigKey);
    try {
      await this._handlePriceTickInner(signal, price, sigKey);
    } finally {
      this.processingSignals.delete(sigKey);
    }
  }

  private async _handlePriceTickInner(
    signal: AiSignalDocument,
    price: number,
    sigKey: string,
  ): Promise<void> {
    const { symbol, direction, entryPrice, takeProfitPrice } = signal;

    // ─── Grid DCA Simulation (signal level) ─────────────────────────────────
    // True DCA: grids fit within signal's SL range. TP = signal TP price (Fibo).
    // Trailing stop uses weighted avg entry. Close ALL grids together on TP/SL.
    const cfg = this.tradingConfig.get();

    // ─── Load orders from cache (5s TTL) or DB — reduces 500+ queries/s to ~5/s ─
    const signalId = (signal as any)._id?.toString();
    let cached = this.getCachedOrders(signalId);
    if (!cached) {
      const [hedgeFromDb, mainFromDb] = await Promise.all([
        this.getActiveHedge((signal as any)._id),
        this.orderModel.findOne({ signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN' }),
      ]);
      this.setCachedOrders(signalId, mainFromDb, hedgeFromDb);
      cached = this.getCachedOrders(signalId)!;
    }
    let hedgeOrder: OrderDocument | null = cached.hedge;
    const mainOrder = cached.main;

    // Sync hedge flag — grace period: don't clear if hedge was opened < 10s ago (order may not be cached yet)
    if (hedgeOrder && !(signal as any).hedgeActive) {
      (signal as any).hedgeActive = true;
    } else if (!hedgeOrder && (signal as any).hedgeActive) {
      const hedgeOpenedAt = (signal as any).hedgeOpenedAt;
      const hedgeAge = hedgeOpenedAt ? Date.now() - new Date(hedgeOpenedAt).getTime() : Infinity;
      if (hedgeAge > 10_000) {
        this.logger.warn(`[PositionMonitor] ${sigKey} hedgeActive=true but no OPEN HEDGE order found — clearing stale flag`);
        (signal as any).hedgeActive = false;
        await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, { hedgeActive: false }).exec().catch(() => {});
      }
    }
    const orderMeta = (mainOrder as any)?.metadata || {};

    // Fixed 4 DCA grid levels at 0%, 2%, 4%, 6% deviation — same for sim + real
    const GRID_LEVEL_COUNT = GRID_DEVIATIONS.length;

    const gridLevels: any[] = orderMeta.gridLevels ?? (signal as any).gridLevels ?? [];
    const isGridSignal = gridLevels.length > 0;

    // Initialize grid on first tick (base grid = level 0)
    if (!isGridSignal) {
      const origEntry = entryPrice;
      const originalSlForGrid = (signal as any).originalSlPrice || (signal as any).stopLossPrice;

      const simNotional = cfg.simNotional || 1000;
      const simQuantity = simNotional / origEntry;
      const grids: any[] = [];

      for (let i = 0; i < GRID_LEVEL_COUNT; i++) {
        const dev = GRID_DEVIATIONS[i];
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
            level: i, deviationPct: dev, fillPrice: 0,
            volumePct: volPct,
            status: "PENDING",
          });
        }
      }

      // Avg entry starts as L0 entry
      const avgEntry = origEntry;

      (signal as any).gridLevels = grids;
      (signal as any).originalEntryPrice = origEntry;
      // gridGlobalSlPrice = effective SL (safety SL when hedge enabled, original otherwise)
      const effectiveSl = (signal as any).hedgeSafetySlPrice || originalSlForGrid;
      (signal as any).gridGlobalSlPrice = effectiveSl;
      (signal as any).gridFilledCount = 1;
      (signal as any).gridClosedCount = 0;
      (signal as any).gridAvgEntry = avgEntry;
      (signal as any).simNotional = simNotional;
      (signal as any).simQuantity = simQuantity;

      await this.signalQueueService.updateSignalGrid(
        (signal as any)._id.toString(), grids, 1, 0,
      );
      await this.signalQueueService.initGridSignal(
        (signal as any)._id.toString(), origEntry, effectiveSl, avgEntry,
      );
      await this.signalQueueService.updateSimVolume(
        (signal as any)._id.toString(), simNotional, simQuantity,
      );
      this.logger.log(
        `[PositionMonitor] Grid DCA init ${sigKey}: ${GRID_LEVEL_COUNT} levels (2/4/6%), SL=${effectiveSl.toFixed(4)} (orig=${originalSlForGrid.toFixed(4)}), TP=${takeProfitPrice?.toFixed(4)}`,
      );

      // Update MAIN order with grid data + metadata (order already created in signal-queue)
      const gridNotionalL0 = simNotional * (DCA_WEIGHTS[0] / 100);
      const l0EntryFee = this.calcTakerFee(gridNotionalL0);
      await this.orderModel.findOneAndUpdate(
        { signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN' },
        {
          $set: {
            entryPrice: origEntry,
            notional: gridNotionalL0,
            quantity: gridNotionalL0 / origEntry,
            stopLossPrice: effectiveSl,
            takeProfitPrice: takeProfitPrice || 0,
            entryFeeUsdt: l0EntryFee,
            'metadata.gridLevels': grids,
            'metadata.originalEntryPrice': origEntry,
            'metadata.gridFilledCount': 1,
            'metadata.gridClosedCount': 0,
            'metadata.simNotional': simNotional,
            'metadata.peakPnlPct': 0,
            'metadata.peakUpdatedAt': 0,
            'metadata.slMovedToEntry': false,
            'metadata.tpBoostLevel': 0,
            'metadata.originalSlPrice': (signal as any).originalSlPrice || effectiveSl,
          },
          $setOnInsert: {
            signalId: (signal as any)._id,
            symbol: signal.symbol,
            direction: signal.direction,
            type: 'MAIN',
            status: 'OPEN',
            openedAt: new Date(),
            cycleNumber: 0,
          },
        },
        { upsert: true },
      ).catch((err) => this.logger.warn(`[PositionMonitor] MAIN order upsert error: ${err?.message}`));
    }

    // Process grid events (skip if FLIP/resolve in progress to prevent grid corruption)
    if (gridLevels.length > 0 && !this.resolvingSymbols.has(sigKey)) {
      const grids: any[] = gridLevels;
      const origEntry = orderMeta.originalEntryPrice ?? (signal as any).originalEntryPrice ?? entryPrice;
      const globalSl = mainOrder?.stopLossPrice ?? (signal as any).gridGlobalSlPrice;
      const signalTp = mainOrder?.takeProfitPrice ?? takeProfitPrice; // Fibo TP price
      let avgEntry: number = mainOrder?.entryPrice ?? (signal as any).gridAvgEntry ?? origEntry;
      let gridChanged = false;
      let filledCount = orderMeta.gridFilledCount ?? (signal as any).gridFilledCount ?? 1;
      let closedCount = orderMeta.gridClosedCount ?? (signal as any).gridClosedCount ?? 0;

      // DCA continues even when hedge is active — lowers avgEntry for easier recovery

      // Check PENDING grids: price moved against position → simulate fill
      // RSI guard: only DCA when RSI shows exhaustion (likely to bounce)
      let rsiOk: boolean | null = null; // null = not yet computed
      const coin = signal.symbol.replace("USDT", "");

      for (const grid of grids) {
        if (grid.status !== "PENDING") continue;
        // Rolling avg trigger: each DCA triggers at 2% from current avg entry
        // After each fill, avg entry shifts → next level always 2% away from new avg
        const DCA_STEP_PCT = 2.0; // fixed 2% step from avg
        const triggerPrice = direction === "LONG"
          ? avgEntry * (1 - DCA_STEP_PCT / 100)
          : avgEntry * (1 + DCA_STEP_PCT / 100);
        const triggered = direction === "LONG" ? price <= triggerPrice : price >= triggerPrice;
        if (triggered) {
          // Guard against concurrent tick processing (async RSI check window)
          grid.status = "FILLING";

          // Cooldown: skip if last grid filled < 5 min ago
          const lastFill = grids
            .filter((g) => g.status === "FILLED" && g.filledAt)
            .map((g) => new Date(g.filledAt).getTime())
            .sort((a, b) => b - a)[0];
          if (lastFill && Date.now() - lastFill < (cfg.gridFillCooldownMin || 5) * 60 * 1000) { grid.status = "PENDING"; continue; }

          // RSI guard for L1+ — only DCA when oversold/overbought
          // L1-L2: RSI only (small volume 6-12%, quick avg-down)
          // L3+: RSI + sustained momentum check (large volume 18-24%, need stabilization)
          if (grid.level >= 1 && rsiOk === null) {
            try {
              const closes = await this.marketDataService.getClosePrices(coin, "15m");
              if (closes.length >= 14) {
                // RSI imported at module scope
                const rsiVals = RSI.calculate({ period: 14, values: closes });
                const rsi = rsiVals[rsiVals.length - 1];
                const cfg = this.tradingConfig?.get();
                // Softer RSI per level: L1=48/52, L2=45/55, L3+=42/58
                const baseLong = cfg?.gridRsiLong ?? 45;
                const baseShort = cfg?.gridRsiShort ?? 55;
                const levelOffset = grid.level === 1 ? 3 : grid.level === 2 ? 0 : -3;
                const rsiLongThresh = baseLong + levelOffset;
                const rsiShortThresh = baseShort - levelOffset;
                const rsiExhausted = direction === "LONG" ? rsi < rsiLongThresh : rsi > rsiShortThresh;

                if (grid.level <= 2) {
                  // L1-L2: RSI only — softer thresholds to fill before hedge trigger
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
          if (grid.level >= 1 && rsiOk === false) { grid.status = "PENDING"; continue; }
          const simTotalNotional = orderMeta.simNotional || (signal as any).simNotional || 1000;
          const gridNotional = simTotalNotional * (grid.volumePct / 100);
          grid.status = "FILLED";
          grid.fillPrice = price;
          grid.filledAt = new Date();
          grid.simNotional = gridNotional;
          grid.simQuantity = gridNotional / price;

          // DCA fills update the MAIN order (add notional, recalculate avg price)
          const dcaEntryFee = this.calcMakerFee(gridNotional);
          const dcaMainOrder = await this.orderModel.findOne({
            signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN',
          });
          if (dcaMainOrder) {
            const newNotional = dcaMainOrder.notional + gridNotional;
            const newQty = dcaMainOrder.quantity + gridNotional / price;
            const newAvgEntry = (dcaMainOrder.entryPrice * dcaMainOrder.notional + price * gridNotional) / newNotional;
            await this.orderModel.findByIdAndUpdate(dcaMainOrder._id, {
              entryPrice: newAvgEntry,
              notional: newNotional,
              quantity: newQty,
              entryFeeUsdt: (dcaMainOrder.entryFeeUsdt || 0) + dcaEntryFee,
            });
            this.invalidateOrderCache((signal as any)._id?.toString());
          }

          filledCount++;
          gridChanged = true;

          // Recalculate weighted average entry
          const filledGrids = grids.filter((g) => g.status === "FILLED");
          const totalVol = filledGrids.reduce((s, g) => s + (g.simNotional || 0), 0);
          avgEntry = totalVol > 0
            ? filledGrids.reduce((s, g) => s + g.fillPrice * (g.simNotional || 0), 0) / totalVol
            : origEntry;
          (signal as any).gridAvgEntry = avgEntry;

          // Recalculate SL from new avgEntry
          // If hedge enabled: keep 10% safety SL from new avgEntry
          // If hedge disabled: keep original SL% distance
          const hedgeCfgNow = this.tradingConfig?.get();
          // When hedge active: SL=0 (disabled), skip recalc
          if (hedgeOrder) {
            (signal as any).stopLossPrice = 0;
          } else {
            const minSlPctDca = hedgeCfgNow?.hedgeEnabled
              ? (hedgeCfgNow.hedgePartialTriggerPct || 3) + 1.0  // min 4% for hedge room
              : 2.5;
            const rawSlPct = origEntry > 0
              ? Math.abs((orderMeta.originalSlPrice || (signal as any).originalSlPrice || (signal as any).stopLossPrice) - origEntry) / origEntry * 100
              : 2.5;
            const slPctForRecalc = Math.max(rawSlPct, minSlPctDca);
            const curDir = signal.direction;
            const newSl = curDir === "LONG"
              ? avgEntry * (1 - slPctForRecalc / 100)
              : avgEntry * (1 + slPctForRecalc / 100);
            (signal as any).stopLossPrice = newSl;
          }

          // DCA TP from config (default 3%)
          // Use signal.direction (live) not destructured direction (stale after FLIP)
          const DCA_TP_PCT = cfg.dcaTpPct || 3.0;
          const currentDir = signal.direction;
          const newTp = currentDir === "LONG"
            ? avgEntry * (1 + DCA_TP_PCT / 100)
            : avgEntry * (1 - DCA_TP_PCT / 100);
          (signal as any).takeProfitPrice = newTp;
          (signal as any).takeProfitPercent = DCA_TP_PCT;

          const currentSlForLog = (signal as any).stopLossPrice;
          this.logger.log(
            `[PositionMonitor] Grid ${sigKey} L${grid.level} FILLED at ${price.toFixed(4)}, avgEntry=${avgEntry.toFixed(4)}, SL=${currentSlForLog || 'DISABLED'}, TP=${newTp.toFixed(4)}, filled=${filledCount}/${GRID_LEVEL_COUNT}`,
          );
        }
      }

      // Trailing stop for grid DCA: uses avg entry
      // TP/SL hit detection handled by normal path below (falls through)
      const skipTrailSl = !!hedgeOrder; // hedge manages risk when active, skip trail SL
      const filledGrids = grids.filter((g) => g.status === "FILLED");
      if (filledGrids.length > 0) {
        const signalRegime = (signal as any).regime || 'MIXED';
        const regimeSlTp = cfg.regimeSlTp?.[signalRegime];
        // #3 Fix: trail trigger must be below tpMax to be meaningful
        const baseTrigger = cfg.trailTrigger ?? 2.0;
        const TRAIL_TRIGGER = regimeSlTp?.tpMax ? Math.min(regimeSlTp.tpMax * 0.7, baseTrigger) : baseTrigger;
        // #1: Dynamic trail keep ratio per regime
        const TRAIL_KEEP_RATIO = cfg.regimeTrailKeepRatio?.[signalRegime] ?? cfg.trailKeepRatio ?? 0.75;
        const pnlFromAvg = signal.direction === "LONG"
          ? ((price - avgEntry) / avgEntry) * 100
          : ((avgEntry - price) / avgEntry) * 100;

        const prevPeak = orderMeta.peakPnlPct ?? (signal as any).peakPnlPct ?? 0;
        if (pnlFromAvg > prevPeak) {
          (signal as any).peakPnlPct = pnlFromAvg;
          (signal as any).peakUpdatedAt = Date.now();
          if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.peakPnlPct': pnlFromAvg, 'metadata.peakUpdatedAt': Date.now() }).catch(() => {});
        }
        // #4: Peak decay — if no new peak for N minutes, decay toward current PnL
        let peak = (signal as any).peakPnlPct || 0;
        const peakUpdatedAt = orderMeta.peakUpdatedAt ?? (signal as any).peakUpdatedAt ?? 0;
        if (peak > 0 && peakUpdatedAt > 0) {
          const minutesSincePeak = (Date.now() - peakUpdatedAt) / 60000;
          const decayAfter = cfg.peakDecayAfterMin ?? 120;
          if (minutesSincePeak > decayAfter) {
            const hoursOverdue = (minutesSincePeak - decayAfter) / 60;
            const decayRate = cfg.peakDecayPerHour ?? 0.35;
            const decayFactor = Math.pow(1 - decayRate, hoursOverdue);
            const decayedPeak = pnlFromAvg + (peak - pnlFromAvg) * decayFactor;
            if (decayedPeak < peak) {
              peak = Math.max(decayedPeak, pnlFromAvg); // never below current PnL
              (signal as any).peakPnlPct = peak;
              if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.peakPnlPct': peak }).catch(() => {});
            }
          }
        }

        // Move SL to avg entry (break-even) at 2% from avg — skip when hedge active
        const slAlreadyMoved = orderMeta.slMovedToEntry ?? (signal as any).slMovedToEntry;
        if (!skipTrailSl && peak >= TRAIL_TRIGGER && !slAlreadyMoved) {
          (signal as any).stopLossPrice = avgEntry;
          (signal as any).slMovedToEntry = true;
          (signal as any).gridGlobalSlPrice = avgEntry;
          await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, {
            stopLossPrice: avgEntry, slMovedToEntry: true, peakPnlPct: peak,
          }).exec();
          if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, {
            stopLossPrice: avgEntry, 'metadata.slMovedToEntry': true, 'metadata.peakPnlPct': peak,
          }).catch(() => {});
          gridChanged = true;
          this.logger.log(
            `[PositionMonitor] 🛡️ Grid ${sigKey} SL → avg entry ${avgEntry.toFixed(4)} (BE, peak=${peak.toFixed(2)}%)`,
          );
          if (this.slMovedCallback) {
            await this.slMovedCallback(symbol, avgEntry).catch(() => {});
          }
          // Break-even SL stays in DB — SIM controls exit with RSI+candle confirm
        }

        // Continuous trailing: keep 75% of peak profit (DB only — not pushed to Binance)
        // TP proximity lock: if price within 0.5% of TP → freeze trail, let TP execute
        // Skip when hedge active — hedge manages risk
        if (!skipTrailSl) {
          const distanceToTp = signalTp
            ? (direction === "LONG" ? (signalTp - price) / price : (price - signalTp) / price) * 100
            : Infinity;
          const nearTp = distanceToTp < 0.5;

          const slMovedForTrail = orderMeta.slMovedToEntry ?? (signal as any).slMovedToEntry;
          if (slMovedForTrail && peak > TRAIL_TRIGGER && !nearTp) {
            const trailPct = peak * TRAIL_KEEP_RATIO;
            const trailSl = direction === "LONG"
              ? avgEntry * (1 + trailPct / 100)
              : avgEntry * (1 - trailPct / 100);
            const currentSl = mainOrder?.stopLossPrice ?? (signal as any).gridGlobalSlPrice ?? avgEntry;
            const shouldRaise = direction === "LONG" ? trailSl > currentSl : trailSl < currentSl;
            if (shouldRaise) {
              (signal as any).stopLossPrice = trailSl;
              (signal as any).gridGlobalSlPrice = trailSl;
              await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
              if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, {
                stopLossPrice: trailSl, 'metadata.peakPnlPct': peak,
              }).catch(() => {});
              gridChanged = true;
              this.logger.log(
                `[PositionMonitor] 📈 Grid ${sigKey} trail SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak=${peak.toFixed(2)}%`,
              );
              // Trail SL stays in DB — SIM controls exit with RSI+candle confirm
            }
          } else if (nearTp) {
            this.logger.debug(`[PositionMonitor] 🎯 Grid ${sigKey} near TP (${distanceToTp.toFixed(2)}% away) — trail SL frozen`);
          }
        }

        // Stepped TP boost: peak ≥2.5% → +2% | peak ≥4% → +1.5% | peak ≥5.5% → lock
        const tpBoostLevel = orderMeta.tpBoostLevel ?? (signal as any).tpBoostLevel ?? 0;
        const tpBoostSteps = [
          { peakThreshold: 2.5, extend: 2.0, level: 1 },
          { peakThreshold: 4.0, extend: 1.5, level: 2 },
          { peakThreshold: 5.5, extend: 0,   level: 3 }, // lock — no more extension
        ];
        const nextStep = tpBoostSteps.find(s => s.level === tpBoostLevel + 1);
        if (nextStep && pnlFromAvg >= nextStep.peakThreshold && signalTp) {
          try {
            const hasMomentum = nextStep.level === 1
              ? await this.marketDataService.hasVolumeMomentum(symbol)
              : true; // step 2+ already confirmed momentum
            if (hasMomentum) {
              (signal as any).tpBoostLevel = nextStep.level;
              if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.tpBoostLevel': nextStep.level }).catch(() => {});
              if (nextStep.extend > 0) {
                const currentTpPct = Math.abs(signalTp - avgEntry) / avgEntry * 100;
                const tpBoostCap = cfg.tpBoostCap || 6;
                const boostedTpPct = Math.min(tpBoostCap, currentTpPct + nextStep.extend);
                const newTpPrice = direction === "LONG"
                  ? avgEntry * (1 + boostedTpPct / 100)
                  : avgEntry * (1 - boostedTpPct / 100);
                (signal as any).takeProfitPrice = newTpPrice;
                await this.signalQueueService.extendTakeProfit((signal as any)._id.toString(), newTpPrice, boostedTpPct);
                if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { takeProfitPrice: newTpPrice }).catch(() => {});
                gridChanged = true;
                this.logger.log(`[PositionMonitor] 🚀 Grid ${sigKey} TP boost L${nextStep.level}: +${nextStep.extend}% → ${boostedTpPct.toFixed(1)}% (${newTpPrice.toFixed(4)})`);
                this.propagateTpMove(sigKey, symbol, newTpPrice, direction);
              } else {
                this.logger.log(`[PositionMonitor] 🔒 Grid ${sigKey} TP locked at L${nextStep.level} — peak ${pnlFromAvg.toFixed(1)}%`);
              }
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
        // Dual-write grid state to MAIN order metadata
        if (mainOrder) {
          await this.orderModel.findByIdAndUpdate(mainOrder._id, {
            stopLossPrice: (signal as any).stopLossPrice,
            takeProfitPrice: (signal as any).takeProfitPrice,
            entryPrice: avgEntry,
            'metadata.gridLevels': grids,
            'metadata.gridFilledCount': filledCount,
            'metadata.gridClosedCount': closedCount,
          }).catch(() => {});
        }
      }

      // Fall through to normal TP/SL check below (uses signal.stopLossPrice + takeProfitPrice
      // which are kept in sync by the trailing stop logic above)
    }

    // ─── Auto risk management ──────────────────────────────────────────────
    // Use mainOrder.entryPrice for DCA signals (reflects actual cost basis after averaging down)
    const currentEntry = mainOrder?.entryPrice ?? (signal as any).gridAvgEntry ?? entryPrice;
    const pnlPct =
      direction === "LONG"
        ? ((price - currentEntry) / currentEntry) * 100
        : ((currentEntry - price) / currentEntry) * 100;

    // Hedge loss calculation (used for TP extension + trail lock skip)
    const hedgeBanked = ((signal as any).hedgeHistory || []).reduce((s: number, h: any) => s + (h.pnlUsdt || 0), 0);
    const hedgeLoss = hedgeBanked < 0 ? Math.abs(hedgeBanked) : 0;
    const mainNotional = orderMeta.simNotional || (signal as any).simNotional || 1000;

    // Trailing SL + TP boost for non-grid signals only
    // (grid signals handle trailing in the grid block above)
    // Skip trail SL when hedge is active — hedge manages risk
    if (!isGridSignal && !hedgeOrder) {
      // Trail params: regime-aware
      const signalRegime = (signal as any).regime || 'MIXED';
      const regimeSlTp = cfg.regimeSlTp?.[signalRegime];
      const baseTrigger = cfg.trailTrigger ?? 2.0;
      const TRAIL_TRIGGER = regimeSlTp?.tpMax ? Math.min(regimeSlTp.tpMax * 0.7, baseTrigger) : baseTrigger;
      const TRAIL_KEEP_RATIO = cfg.regimeTrailKeepRatio?.[signalRegime] ?? cfg.trailKeepRatio ?? 0.75;

      const prevPeak = orderMeta.peakPnlPct ?? (signal as any).peakPnlPct ?? 0;
      if (pnlPct > prevPeak) {
        (signal as any).peakPnlPct = pnlPct;
        (signal as any).peakUpdatedAt = Date.now();
        if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.peakPnlPct': pnlPct, 'metadata.peakUpdatedAt': Date.now() }).catch(() => {});
      }
      // #4: Peak decay
      let peak = (signal as any).peakPnlPct || 0;
      const peakUpdatedAt = orderMeta.peakUpdatedAt ?? (signal as any).peakUpdatedAt ?? 0;
      if (peak > 0 && peakUpdatedAt > 0) {
        const minutesSincePeak = (Date.now() - peakUpdatedAt) / 60000;
        const decayAfter = cfg.peakDecayAfterMin ?? 120;
        if (minutesSincePeak > decayAfter) {
          const hoursOverdue = (minutesSincePeak - decayAfter) / 60;
          const decayRate = cfg.peakDecayPerHour ?? 0.35;
          const decayFactor = Math.pow(1 - decayRate, hoursOverdue);
          const decayedPeak = pnlPct + (peak - pnlPct) * decayFactor;
          if (decayedPeak < peak) {
            peak = Math.max(decayedPeak, pnlPct);
            (signal as any).peakPnlPct = peak;
            if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.peakPnlPct': peak }).catch(() => {});
          }
        }
      }

      const slMovedNonGrid = orderMeta.slMovedToEntry ?? (signal as any).slMovedToEntry;
      if (peak >= TRAIL_TRIGGER && !slMovedNonGrid) {
        (signal as any).stopLossPrice = currentEntry;
        (signal as any).slMovedToEntry = true;
        await this.signalQueueService.moveStopLossToEntry((signal as any)._id.toString());
        if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, {
          stopLossPrice: currentEntry, 'metadata.slMovedToEntry': true, 'metadata.peakPnlPct': peak,
        }).catch(() => {});
        this.logger.log(
          `[PositionMonitor] 🛡️ ${sigKey} SL moved to entry ${currentEntry} (PnL: ${pnlPct.toFixed(2)}%)`,
        );
        if (this.slMovedCallback) {
          await this.slMovedCallback(symbol, currentEntry).catch((e) =>
            this.logger.warn(`[PositionMonitor] slMovedCallback error ${sigKey}: ${e?.message}`),
          );
        }
        // Break-even SL stays in DB — SIM controls exit with RSI+candle confirm
      }

      // TP proximity lock: if price within 0.5% of TP → freeze trail, let TP execute
      // Exception: when hedge has big loss, DON'T lock — let trail ride further to cover hedge
      const distanceToTp = takeProfitPrice
        ? (direction === "LONG" ? (takeProfitPrice - price) / price : (price - takeProfitPrice) / price) * 100
        : Infinity;
      const hasHedgeLoss = hedgeLoss > mainNotional * 0.03; // hedge lost > 3% of notional
      const nearTp = distanceToTp < 0.5 && !hasHedgeLoss;

      const slMovedForContinuousTrail = orderMeta.slMovedToEntry ?? (signal as any).slMovedToEntry;
      if (slMovedForContinuousTrail && peak > TRAIL_TRIGGER && !nearTp) {
        const trailPct = peak * TRAIL_KEEP_RATIO;
        const trailSl = direction === "LONG"
          ? currentEntry * (1 + trailPct / 100)
          : currentEntry * (1 - trailPct / 100);
        const currentSl = mainOrder?.stopLossPrice ?? (signal as any).stopLossPrice ?? currentEntry;
        const shouldRaise = direction === "LONG" ? trailSl > currentSl : trailSl < currentSl;
        if (shouldRaise) {
          (signal as any).stopLossPrice = trailSl;
          await this.signalQueueService.raiseStopLoss((signal as any)._id.toString(), trailSl, peak);
          if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, {
            stopLossPrice: trailSl, 'metadata.peakPnlPct': peak,
          }).catch(() => {});
          this.logger.log(
            `[PositionMonitor] 📈 ${sigKey} trailing SL → +${trailPct.toFixed(1)}% (${trailSl.toFixed(4)}) peak: ${peak.toFixed(2)}%`,
          );
          // Trail SL stays in DB — SIM controls exit with RSI+candle confirm
        }
      } else if (nearTp) {
        this.logger.debug(`[PositionMonitor] 🎯 ${sigKey} near TP (${distanceToTp.toFixed(2)}% away) — trail SL frozen`);
      }
    }

    // ─── Stepped TP boost: extend TP on strong momentum (non-grid only) ──
    // Grid signals handle TP boost in the grid block above
    if (!isGridSignal) {
    // Base cap 6% (was 4%), extend up to 10% if hedge loss is significant
    const tpCap = hedgeLoss > mainNotional * 0.05
      ? Math.min(10, 6 + (hedgeLoss / mainNotional) * 100 * 0.3)
      : 6;

    const tpBoostLevel = orderMeta.tpBoostLevel ?? (signal as any).tpBoostLevel ?? 0;
    const tpBoostSteps = [
      { peakThreshold: 2.5, extend: 2.0, level: 1 },
      { peakThreshold: 4.0, extend: 1.5, level: 2 },
      { peakThreshold: 5.5, extend: 0,   level: 3 }, // lock
    ];
    const nextStep = tpBoostSteps.find(s => s.level === tpBoostLevel + 1);
    if (nextStep && pnlPct >= nextStep.peakThreshold && takeProfitPrice) {
      try {
        const hasMomentum = nextStep.level === 1
          ? await this.marketDataService.hasVolumeMomentum(symbol)
          : true;
        if (hasMomentum) {
          (signal as any).tpBoostLevel = nextStep.level;
          if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { 'metadata.tpBoostLevel': nextStep.level }).catch(() => {});
          if (nextStep.extend > 0) {
            const currentTpPct = Math.abs(takeProfitPrice - currentEntry) / currentEntry * 100;
            const boostedTpPct = Math.min(tpCap, currentTpPct + nextStep.extend);
            const newTpPrice = direction === "LONG"
              ? currentEntry * (1 + boostedTpPct / 100)
              : currentEntry * (1 - boostedTpPct / 100);
            (signal as any).takeProfitPrice = newTpPrice;
            await this.signalQueueService.extendTakeProfit((signal as any)._id.toString(), newTpPrice, boostedTpPct);
            if (mainOrder) await this.orderModel.findByIdAndUpdate(mainOrder._id, { takeProfitPrice: newTpPrice }).catch(() => {});
            this.logger.log(`[PositionMonitor] 🚀 ${sigKey} TP boost L${nextStep.level}: +${nextStep.extend}% → ${boostedTpPct.toFixed(1)}% (${newTpPrice.toFixed(4)})`);
            this.propagateTpMove(sigKey, symbol, newTpPrice, direction);
            if (this.tpBoostedCallback) {
              await this.tpBoostedCallback(symbol, newTpPrice, boostedTpPct, direction).catch((e) =>
                this.logger.warn(`[PositionMonitor] tpBoostedCallback error ${sigKey}: ${e?.message}`),
              );
            }
          } else {
            this.logger.log(`[PositionMonitor] 🔒 ${sigKey} TP locked at L${nextStep.level} — peak ${pnlPct.toFixed(1)}%`);
          }
        }
      } catch (err) {
        this.logger.warn(`[PositionMonitor] TP boost check error for ${sigKey}: ${err?.message}`);
      }
    }
    } // end !isGridSignal TP boost

    // ─── Auto-Hedge Logic ──────────────────────────────────────────────────
    const hedgeCfg = this.tradingConfig.get();
    const hedgeEnabled = hedgeCfg.hedgeEnabled;
    const hedgeActive = !!hedgeOrder; // derived from DB order at start of tick

    if (hedgeEnabled) {
      // Real hedge follows sim via hedgeCallback → onHedgeEvent (no independent check)

      if (!hedgeActive) {
        // Force open hedge (triggered by admin API)
        if ((signal as any).hedgeForceOpen) {
          this.logger.log(`[PositionMonitor] ${symbol} FORCE HEDGE OPEN (admin API)`);
          await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, { $unset: { hedgeForceOpen: 1 } }).exec();
          (signal as any).hedgeForceOpen = false;
          const regime = (signal as any).regime || "MIXED";
          const hedgeCtx = this.buildSimHedgeContext(signal, mainOrder, hedgeOrder);
          const action = await this.hedgeManager.checkHedge(hedgeCtx, price, -999, regime);
          if (action && action.action !== "NONE") {
            await this.handleHedgeAction(signal, action, price);
            return; // Hedge just opened — skip SL/TP check this tick (mainOrder is stale)
          }
        }
        // Check if PnL crosses hedge trigger (cycle 1 uses -3%, cycle 2+ uses config)
        else if (pnlPct <= -Math.min(hedgeCfg.hedgePartialTriggerPct, 3.0)) {
          const regime = (signal as any).regime || "MIXED";
          const hedgeCtx = this.buildSimHedgeContext(signal, mainOrder, hedgeOrder);
          const action = await this.hedgeManager.checkHedge(hedgeCtx, price, pnlPct, regime);
          if (action && action.action !== "NONE") {
            await this.handleHedgeAction(signal, action, price);
            return;
          }
        }
      } else {
        // Hedge is active — check for exit
        const hedgeCtx = this.buildSimHedgeContext(signal, mainOrder, hedgeOrder);
        const exitAction = this.hedgeManager.checkHedgeExit(hedgeCtx, price, pnlPct);
        if (exitAction && exitAction.action === "CLOSE_HEDGE") {
          await this.handleHedgeClose(signal, exitAction, price);
          return; // Hedge closed (TP/trail/recovery) — skip NET_POSITIVE, let next tick reassess
        } else if (exitAction && exitAction.action === 'NONE') {
          // Update flags from hedge manager (breakeven lock, trail activated)
          const updates: Record<string, any> = {};
          if ((exitAction as any).hedgeSlAtEntry && !(signal as any).hedgeSlAtEntry) {
            (signal as any).hedgeSlAtEntry = true;
            updates.hedgeSlAtEntry = true;
          }
          if ((exitAction as any).hedgeTrailActivated && !(signal as any).hedgeTrailActivated) {
            (signal as any).hedgeTrailActivated = true;
            updates.hedgeTrailActivated = true;
          }
          // Persist hedge peak PnL + timestamp so it survives restarts
          if ((exitAction as any).hedgePeakPnlPct && (exitAction as any).hedgePeakPnlPct > ((signal as any).hedgePeakPnlPct || 0)) {
            (signal as any).hedgePeakPnlPct = (exitAction as any).hedgePeakPnlPct;
            (signal as any).hedgePeakUpdatedAt = Date.now();
            updates.hedgePeakPnlPct = (exitAction as any).hedgePeakPnlPct;
            updates.hedgePeakUpdatedAt = Date.now();
          }
          // Hedge TP boost: update TP price on signal + hedge order
          if ((exitAction as any).hedgeTpPrice && (exitAction as any).hedgeTpPrice !== (signal as any).hedgeTpPrice) {
            (signal as any).hedgeTpPrice = (exitAction as any).hedgeTpPrice;
            updates.hedgeTpPrice = (exitAction as any).hedgeTpPrice;
            if (hedgeOrder) {
              this.orderModel.findByIdAndUpdate(hedgeOrder._id, { takeProfitPrice: (exitAction as any).hedgeTpPrice }).catch(() => {});
            }
          }
          if (Object.keys(updates).length > 0) {
            this.aiSignalModel.findByIdAndUpdate((signal as any)._id, updates).exec().catch(() => {});
          }
        }

        // When hedge is active: NO SL — hedge cycles until recovery (NET_POSITIVE > 2%)
        if (this.resolvingSymbols.has(sigKey)) return; // Prevent concurrent hedge/FLIP/NET_POSITIVE

        // ── Net Positive/Negative Exit: banked hedge profit + main unrealized → close all ──
        // Use closed HEDGE orders for accurate banked profit (fees already deducted)
        // After FLIP: only count hedges closed AFTER the flip (pre-flip profits already banked in FLIP_TP)
        const lastFlipAt = (signal as any).lastFlipAt;
        const hedgeQuery: any = { signalId: (signal as any)._id, type: 'HEDGE', status: 'CLOSED' };
        if (lastFlipAt) hedgeQuery.closedAt = { $gt: new Date(lastFlipAt) };
        const closedHedgeOrders = await this.orderModel.find(hedgeQuery);
        const bankedProfit = closedHedgeOrders.reduce((sum, o) => sum + (o.pnlUsdt || 0), 0);
        // Read grids from order metadata (source of truth after DCA fills), fallback to signal
        const npMainOrder = await this.orderModel.findOne({
          signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN',
        }).lean().catch(() => null);
        const npGrids: any[] = (npMainOrder as any)?.metadata?.gridLevels || (signal as any).gridLevels || [];
        const filledVol = npGrids.length > 0
          ? npGrids.filter((g: any) => g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED").reduce((s: number, g: any) => s + (g.simNotional || 0), 0) || (npMainOrder?.notional || ((signal as any).simNotional || 1000) * 0.35)
          : (npMainOrder?.notional || ((signal as any).simNotional || 1000) * 0.35);
        const mainUnrealizedUsdt = (pnlPct / 100) * filledVol;
        // Include current open hedge PnL
        let currentHedgePnlUsdt = 0;
        if (hedgeOrder) {
          const hDir = hedgeOrder.direction;
          const hEntry = hedgeOrder.entryPrice;
          const hNotional = hedgeOrder.notional;
          const hPnlPct = hDir === "LONG"
            ? ((price - hEntry) / hEntry) * 100
            : ((hEntry - price) / hEntry) * 100;
          currentHedgePnlUsdt = (hPnlPct / 100) * hNotional;
        }
        const netPnlUsdt = mainUnrealizedUsdt + bankedProfit + currentHedgePnlUsdt;

        let forceCloseReason: "NET_POSITIVE" | null = null;

        // NET_POSITIVE trail: activate at 4%, lock floor at 2.5%
        const netPnlPct = filledVol > 0 ? (netPnlUsdt / filledVol) * 100 : 0;
        const NET_TRAIL_TRIGGER = 4.0; // activate trail when net PnL > 4%
        const NET_TRAIL_FLOOR = 2.5;   // lock profit at 2.5% minimum

        const prevNetPeak = (signal as any).netPeakPnlPct ?? 0;
        const netTrailActivated = (signal as any).netTrailActivated ?? false;

        // Track peak net PnL%
        if (netPnlPct > prevNetPeak) {
          (signal as any).netPeakPnlPct = netPnlPct;
          await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, { netPeakPnlPct: netPnlPct }).exec().catch(() => {});
        }
        const netPeak = (signal as any).netPeakPnlPct ?? 0;

        // Activate trail when net PnL crosses 2%
        if (netPeak >= NET_TRAIL_TRIGGER && !netTrailActivated) {
          (signal as any).netTrailActivated = true;
          await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, { netTrailActivated: true }).exec().catch(() => {});
          this.logger.log(
            `[PositionMonitor] ${sigKey} NET TRAIL ACTIVATED | net=${netPnlPct.toFixed(2)}% peak=${netPeak.toFixed(2)}% — floor locked at ${NET_TRAIL_FLOOR}%`,
          );
        }

        // Close when trail activated AND net drops below floor
        if (netTrailActivated && netPnlPct <= NET_TRAIL_FLOOR) {
          this.logger.log(
            `[PositionMonitor] ${sigKey} NET POSITIVE EXIT (trail) | net=${netPnlPct.toFixed(2)}% < floor=${NET_TRAIL_FLOOR}% | peak=${netPeak.toFixed(2)}% | main=$${mainUnrealizedUsdt.toFixed(2)} banked=$${bankedProfit.toFixed(2)} hedge=$${currentHedgePnlUsdt.toFixed(2)}`,
          );
          forceCloseReason = "NET_POSITIVE";
        }

        // Check main TP hit while hedge active → FLIP takes priority over NET_POSITIVE
        const effectiveTpHedge = mainOrder?.takeProfitPrice || (signal as any).takeProfitPrice;
        let mainTpHitForFlip = false;
        if (effectiveTpHedge) {
          const mainTpHit = direction === "LONG" ? price >= effectiveTpHedge : price <= effectiveTpHedge;
          if (mainTpHit && hedgeOrder) {
            mainTpHitForFlip = true;
            forceCloseReason = null; // FLIP overrides NET_POSITIVE
            this.logger.log(
              `[PositionMonitor] 🔄 ${sigKey} MAIN TP HIT at ${price} while hedge active → FLIP to ${hedgeOrder.direction}`,
            );
          }
        }

        if (!forceCloseReason && !mainTpHitForFlip) return; // No event → skip

        // ── Force close (NET_POSITIVE only) — NOT for FLIP ──
        // FLIP falls through to normal TP/SL check which has full FLIP logic

        if (mainTpHitForFlip) {
          // Skip force close — fall through to TP/SL check with FLIP logic
        } else {
        // Close open hedge if any
        if (hedgeOrder) {
          const hDir = hedgeOrder.direction;
          const hEntry = hedgeOrder.entryPrice;
          const hNotional = hedgeOrder.notional;
          const hPnlPct = hDir === "LONG"
            ? ((price - hEntry) / hEntry) * 100
            : ((hEntry - price) / hEntry) * 100;
          const hPnlUsdt = Math.round((hPnlPct / 100) * hNotional * 100) / 100;

          await this.handleHedgeClose(signal, {
            action: "CLOSE_HEDGE", hedgePnlPct: hPnlPct, hedgePnlUsdt: hPnlUsdt,
            bankedProfit: bankedProfit + hPnlUsdt, consecutiveLosses: 0,
            hedgePhase: forceCloseReason,
            reason: `${forceCloseReason}: hedge closed at $${hPnlUsdt.toFixed(2)}`,
          }, price);
        }

        // Clean up hedge state
        await this.hedgeManager.cleanupSignal((signal as any)._id?.toString());

        // ── Now resolve the main signal ──
        if (this.resolvingSymbols.has(sigKey)) return;
        this.resolvingSymbols.add(sigKey);
        this.unregisterListener(signal);

        try {
          const resolved = await this.signalQueueService.resolveActiveSignal(sigKey, price, forceCloseReason);

          // Close all open orders
          // Close all open orders with per-order PnL
          const openOrders = await this.orderModel.find({ signalId: (signal as any)._id, status: 'OPEN' });
          for (const ord of openOrders) {
            const ordPnlPct = ord.direction === 'LONG'
              ? ((price - ord.entryPrice) / ord.entryPrice) * 100
              : ((ord.entryPrice - price) / ord.entryPrice) * 100;
            const ordPnlUsdt = Math.round((ordPnlPct / 100) * ord.notional * 100) / 100;
            const exitFee = this.calcTakerFee(ord.notional);
            const hoursHeld = ord.openedAt ? (Date.now() - new Date(ord.openedAt).getTime()) / 3600000 : 0;
            const fundingRate = (signal as any).fundingRate || 0;
            const fundingFee = this.tradingConfig.get().simFundingEnabled
              ? this.calcFundingFee(ord.notional, Math.abs(fundingRate), hoursHeld) : 0;
            await this.orderModel.findByIdAndUpdate(ord._id, {
              status: 'CLOSED', exitPrice: price, closedAt: new Date(),
              closeReason: forceCloseReason,
              pnlPercent: ordPnlPct,
              pnlUsdt: Math.round((ordPnlUsdt - (ord.entryFeeUsdt || 0) - exitFee - fundingFee) * 100) / 100,
              exitFeeUsdt: exitFee, fundingFeeUsdt: fundingFee,
            });
          }

          if (resolved) {
            const entryForPnl = (signal as any).gridAvgEntry || signal.entryPrice;
            const mainPnlPct = signal.direction === "LONG"
              ? ((price - entryForPnl) / entryForPnl) * 100
              : ((entryForPnl - price) / entryForPnl) * 100;

            // Per-grid USDT PnL
            let pnlUsdt = (mainPnlPct / 100) * filledVol;
            const gridLevels: any[] = (signal as any).gridLevels || [];
            if (gridLevels.length > 0) {
              let totalUsdt = 0;
              for (const g of gridLevels) {
                if (g.status === "FILLED") {
                  const vol = g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100);
                  const gPnl = signal.direction === "LONG"
                    ? ((price - g.fillPrice) / g.fillPrice) * 100
                    : ((g.fillPrice - price) / g.fillPrice) * 100;
                  totalUsdt += (gPnl / 100) * vol;
                }
              }
              if (totalUsdt !== 0) pnlUsdt = totalUsdt;
            }

            // Deduct MAIN/DCA order fees only (hedge fees already in bankedProfit)
            const mainOrders = await this.orderModel.find({ signalId: (signal as any)._id, type: { $ne: 'HEDGE' } });
            const totalFees = mainOrders.reduce((sum, o) =>
              sum + (o.entryFeeUsdt || 0) + (o.exitFeeUsdt || 0) + (o.fundingFeeUsdt || 0), 0);
            pnlUsdt -= totalFees;

            // Include hedge banked profit in final PnL
            pnlUsdt += bankedProfit;

            if (this.resolveCallback) {
              await this.resolveCallback({
                symbol,
                signalKey: sigKey,
                direction: signal.direction,
                entryPrice: entryForPnl,
                exitPrice: price,
                pnlPercent: mainPnlPct,
                pnlUsdt,
                simNotional: (signal as any).simNotional,
                filledVol: Math.round(filledVol),
                closeReason: forceCloseReason,
                queuedSignalActivated: false,
              }).catch((err) =>
                this.logger.warn(`[PositionMonitor] resolveCallback error: ${err?.message}`),
              );
            }

            // Promote queued signal
            let promoted = await this.signalQueueService.activateQueuedSignal(sigKey);
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
          }
        } finally {
          this.resolvingSymbols.delete(sigKey);
        }
        return; // Already resolved — don't fall through to normal SL/TP
        } // end else (not FLIP)
      }
    }

    // ─── Time Stop: 12h + PnL > 0 → close stagnant signal with profit ──
    // If hedge active → FLIP (promote hedge to main) instead of closing both
    // PnL <= 0 → HOLD (hedge system handles loss recovery)
    if ((signal as any).executedAt && !this.resolvingSymbols.has(sigKey)) {
      const ageH = (Date.now() - new Date((signal as any).executedAt).getTime()) / 3600000;
      const cfg = this.tradingConfig.get();
      const timeStopH = cfg.timeStopHours || 12;
      if (ageH >= timeStopH) {
        const currentEntry = (signal as any).gridAvgEntry || entryPrice;
        const timePnlPct = direction === "LONG"
          ? ((price - currentEntry) / currentEntry) * 100
          : ((currentEntry - price) / currentEntry) * 100;
        if (timePnlPct > 1.5) { // only close if profitable > 1.5% (cover fees)
          const hasActiveHedge = !!hedgeOrder;
          if (hasActiveHedge) {
            // Hedge active → FLIP (promote hedge to main)
            this.logger.log(`[PositionMonitor] ${sigKey} TIME STOP + HEDGE → FLIP: ${ageH.toFixed(0)}h held, PnL +${timePnlPct.toFixed(2)}%`);
            (signal as any).takeProfitPrice = price;
          } else {
            // No hedge → close normally
            this.logger.log(`[PositionMonitor] ${sigKey} TIME_STOP: ${ageH.toFixed(0)}h held, PnL +${timePnlPct.toFixed(2)}% → closing`);
            this.resolvingSymbols.add(sigKey);
            this.unregisterListener(signal);
            try {
              await this.signalQueueService.resolveActiveSignal(sigKey, price, "TIME_STOP" as any);
              this.userRealTradingService.closeRealPositionBySymbol(symbol, "TIME_STOP").catch(() => {});
            } finally {
              this.resolvingSymbols.delete(sigKey);
            }
            return;
          }
        }
      }
    }

    // ─── Original TP/SL check (non-grid signals) ──────────────────────────
    // Re-read SL/TP from FRESH DB order (mainOrder loaded at tick start may be stale after grid init / hedge)
    const freshMainOrder = await this.orderModel.findOne({
      signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN',
    }).lean().catch(() => null);
    const effectiveTpPrice = (freshMainOrder as any)?.takeProfitPrice || ((signal as any).takeProfitPrice ?? takeProfitPrice);
    const stopLossPrice = (freshMainOrder as any)?.stopLossPrice ?? (signal as any).stopLossPrice;
    // SL=0 means hedge mode (SL disabled) — never trigger SL on price check
    const slHit = stopLossPrice > 0
      ? (direction === "LONG" ? price <= stopLossPrice : price >= stopLossPrice)
      : false;
    const tpHit = effectiveTpPrice
      ? direction === "LONG"
        ? price >= effectiveTpPrice
        : price <= effectiveTpPrice
      : false;

    if (!slHit && !tpHit) return;

    // ── Trail SL confirmation: RSI + candle close (avoid false wick triggers) ──
    // Only for trail SL (SL moved above entry), not original SL or TP
    const entryRefForTrail = (signal as any).gridAvgEntry || signal.entryPrice;
    const isTrailSl = slHit && !tpHit && (
      (direction === "LONG" && stopLossPrice > entryRefForTrail) ||
      (direction === "SHORT" && stopLossPrice < entryRefForTrail)
    );
    if (isTrailSl) {
      try {
        const coin = symbol.replace('USDT', '');
        const closes1m = await this.marketDataService.getClosePrices(coin, '1m');
        if (closes1m.length < 14) {
          // Not enough data — HOLD, don't close without confirmation
          this.logger.log(`[PositionMonitor] ⏸️ ${sigKey} trail SL touched but insufficient 1m data (${closes1m.length} candles) — holding`);
          return;
        }

        // 1. Candle close confirm: last closed 1m candle must be below SL (LONG) or above SL (SHORT)
        const lastClose = closes1m[closes1m.length - 2]; // -2 = last CLOSED candle (-1 is current/open)
        const candleConfirm = direction === "LONG"
          ? lastClose <= stopLossPrice
          : lastClose >= stopLossPrice;

        // 2. RSI confirm: momentum continuing against position (1m RSI)
        const rsiVals = RSI.calculate({ period: 14, values: closes1m });
        const rsi1m = rsiVals[rsiVals.length - 1];
        // LONG trail SL: confirm if RSI < 45 (bearish momentum)
        // SHORT trail SL: confirm if RSI > 55 (bullish momentum)
        const rsiConfirm = direction === "LONG" ? rsi1m < 45 : rsi1m > 55;

        if (!candleConfirm && !rsiConfirm) {
          // Neither confirmed — likely a wick, skip this tick
          this.logger.log(
            `[PositionMonitor] ⏸️ ${sigKey} trail SL touched but NOT confirmed | candle1m=${lastClose?.toFixed(4)} SL=${stopLossPrice} RSI1m=${rsi1m?.toFixed(1)} — waiting`,
          );
          return;
        }
        // At least one confirmed — proceed with close
        this.logger.log(
          `[PositionMonitor] ✅ ${sigKey} trail SL CONFIRMED | candle=${candleConfirm ? 'YES' : 'no'} RSI=${rsiConfirm ? 'YES' : 'no'} (RSI1m=${rsi1m?.toFixed(1)})`,
        );
      } catch (err) {
        // Data unavailable — HOLD, don't close without confirmation
        this.logger.warn(`[PositionMonitor] ${sigKey} trail SL confirm check failed — holding: ${err?.message}`);
        return;
      }
    }

    // ── FLIP LOGIC: Main TP hit while hedge active → promote hedge to new main ──
    // Safety: if hedgeActive=false but TP hit, do one final DB check for orphan hedge order
    if (tpHit && !hedgeOrder) {
      const orphanHedge = await this.orderModel.findOne({
        signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN',
      }).lean();
      if (orphanHedge) {
        this.logger.warn(
          `[PositionMonitor] ${sigKey} hedgeActive=false but OPEN HEDGE order found (cycle ${(orphanHedge as any).cycleNumber}) — forcing FLIP`,
        );
        hedgeOrder = orphanHedge as any;
      }
    }
    const hasActiveHedge = !!hedgeOrder;
    if (tpHit && hasActiveHedge) {
      const hedgeDir = hedgeOrder!.direction;
      const hedgeEntry = hedgeOrder!.entryPrice;
      const hedgeNotional = hedgeOrder!.notional || signal.simNotional || 1000;
      if (this.resolvingSymbols.has(sigKey)) return;
      this.resolvingSymbols.add(sigKey); // Prevent duplicate FLIP from concurrent price events
      this.logger.log(
        `[PositionMonitor] 🔄 ${sigKey} MAIN TP HIT while hedge active → FLIPPING to ${hedgeDir}`,
      );

      // 1. Close MAIN order with TP profit
      const mainOrders = await this.orderModel.find({ signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN' });
      const mainFundingRate = (signal as any).fundingRate || 0;
      let mainPnlTotal = 0;
      for (const ord of mainOrders) {
        const ordPnlPct = ord.direction === 'LONG'
          ? ((effectiveTpPrice - ord.entryPrice) / ord.entryPrice) * 100
          : ((ord.entryPrice - effectiveTpPrice) / ord.entryPrice) * 100;
        const ordPnlUsdt = (ordPnlPct / 100) * ord.notional;
        const exitFee = this.calcTakerFee(ord.notional);
        const hoursHeld = ord.openedAt ? (Date.now() - new Date(ord.openedAt).getTime()) / 3600000 : 0;
        const fundFee = this.tradingConfig.get().simFundingEnabled
          ? this.calcFundingFee(ord.notional, Math.abs(mainFundingRate), hoursHeld) : 0;
        const netPnl = Math.round((ordPnlUsdt - (ord.entryFeeUsdt || 0) - exitFee - fundFee) * 100) / 100;
        mainPnlTotal += netPnl;
        await this.orderModel.findByIdAndUpdate(ord._id, {
          status: 'CLOSED', exitPrice: effectiveTpPrice, closedAt: new Date(),
          closeReason: 'TAKE_PROFIT', pnlPercent: ordPnlPct, pnlUsdt: netPnl,
          exitFeeUsdt: exitFee, fundingFeeUsdt: fundFee,
        });
      }

      // Calculate main PnL% for history tracking
      const avgEntry = (signal as any).gridAvgEntry || signal.entryPrice;
      const mainPnlPct = direction === 'LONG'
        ? ((effectiveTpPrice - avgEntry) / avgEntry) * 100
        : ((avgEntry - effectiveTpPrice) / avgEntry) * 100;

      // 2. Flip signal: hedge becomes new main (use resolved vars from top of block)
      const newDirection = hedgeDir;
      const newEntry = hedgeEntry;
      const newNotional = hedgeNotional;
      const hedgeCfgFlip = this.tradingConfig.get();
      const flipTpPct = hedgeCfgFlip.tpMax || 4.0; // TP from config
      const flipSlPct = 40; // Safety net — hedge manages risk, not SL
      const newTp = newDirection === 'LONG'
        ? +(newEntry * (1 + flipTpPct / 100)).toFixed(6)
        : +(newEntry * (1 - flipTpPct / 100)).toFixed(6);
      const newSl = newDirection === 'LONG'
        ? +(newEntry * (1 - flipSlPct / 100)).toFixed(6)
        : +(newEntry * (1 + flipSlPct / 100)).toFixed(6);

      // 3. Promote HEDGE order to new MAIN (hedgeOrder already resolved above — reuse it)
      const flipHedgeOrderDoc = hedgeOrder ?? await this.orderModel.findOne({
        signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN',
      });
      if (flipHedgeOrderDoc) {
        await this.orderModel.findByIdAndUpdate(flipHedgeOrderDoc._id, {
          type: 'FLIP_MAIN', stopLossPrice: newSl, takeProfitPrice: newTp, cycleNumber: 0,
          'metadata.peakPnlPct': 0,
          'metadata.peakUpdatedAt': 0,
          'metadata.slMovedToEntry': false,
          'metadata.tpBoostLevel': 0,
          'metadata.originalSlPrice': newSl,
          'metadata.originalEntryPrice': newEntry,
          'metadata.simNotional': signal.simNotional || 1000,
        });
      }

      // 3b. Bank main TP profit into hedgeHistory — tracks cumulative profit across FLIPs
      const existingHistory = (signal as any).hedgeHistory || [];
      const flipHistory = [
        ...existingHistory,
        {
          cycle: existingHistory.length + 1,
          direction: direction, // original main direction that TP'd
          entryPrice: avgEntry,
          exitPrice: effectiveTpPrice,
          notional: signal.simNotional || 1000, // main signal's volume
          pnlPct: mainPnlPct,
          pnlUsdt: mainPnlTotal,
          openedAt: (signal as any).executedAt || new Date(),
          closedAt: new Date(),
          reason: 'FLIP_TP',
        },
      ];

      // Update signal in-memory
      const flipTime = new Date();
      (signal as any).direction = newDirection;
      (signal as any).entryPrice = newEntry;
      (signal as any).gridAvgEntry = newEntry;
      (signal as any).originalEntryPrice = newEntry;
      (signal as any).stopLossPrice = newSl;
      (signal as any).stopLossPercent = flipSlPct;
      (signal as any).takeProfitPrice = newTp;
      (signal as any).takeProfitPercent = flipTpPct;
      (signal as any).originalSlPrice = newSl;
      (signal as any).hedgeActive = false;
      (signal as any).hedgePhase = undefined;
      (signal as any).hedgeDirection = undefined;
      (signal as any).hedgeEntryPrice = undefined;
      (signal as any).hedgeSimNotional = undefined;
      (signal as any).hedgeTpPrice = undefined;
      (signal as any).hedgeOpenedAt = undefined;
      (signal as any).hedgeCycleCount = 0;
      (signal as any).hedgeHistory = flipHistory;
      (signal as any).slMovedToEntry = false;
      (signal as any).tpBoostLevel = 0;
      (signal as any).peakPnlPct = 0;
      (signal as any).peakUpdatedAt = 0;
      (signal as any).executedAt = flipTime; // Reset for correct funding fee calc
      (signal as any).lastFlipAt = flipTime; // NET_POSITIVE only counts post-flip hedges
      (signal as any).hedgeTrailActivated = false; // Reset so new hedge trail works correctly
      (signal as any).hedgeSlAtEntry = false; // Reset so new hedge SL logic works correctly
      (signal as any).netPeakPnlPct = 0; // Reset net trail state — prevent stale NET_POSITIVE on next cycle
      (signal as any).netTrailActivated = false;

      // 4. Persist to DB — use upsert to guarantee signal survives even if deleted mid-flight
      const flipData = {
        symbol, coin: symbol.replace('USDT', ''),
        direction: newDirection,
        entryPrice: newEntry,
        gridAvgEntry: newEntry,
        originalEntryPrice: newEntry,
        stopLossPrice: newSl, stopLossPercent: flipSlPct,
        takeProfitPrice: newTp, takeProfitPercent: flipTpPct,
        originalSlPrice: newSl, status: 'ACTIVE' as const,
        hedgeActive: false, hedgeCycleCount: 0,
        hedgeHistory: flipHistory,
        slMovedToEntry: false, tpBoostLevel: 0, peakPnlPct: 0, peakUpdatedAt: 0,
        netPeakPnlPct: 0, netTrailActivated: false,
        executedAt: flipTime,
        lastFlipAt: flipTime,
        simNotional: newNotional,
      };
      const flipResult = await this.aiSignalModel.findByIdAndUpdate(
        (signal as any)._id,
        { $set: flipData, $unset: { hedgePhase: 1, hedgeDirection: 1, hedgeEntryPrice: 1, hedgeSimNotional: 1, hedgeTpPrice: 1, hedgeOpenedAt: 1, hedgeSafetySlPrice: 1, hedgeSlAtEntry: 1, hedgeTrailActivated: 1, hedgePeakPnlPct: 1 } },
        { upsert: true, new: true },
      );
      if (!flipResult) {
        this.logger.error(`[PositionMonitor] ${sigKey} FLIP failed: signal update returned null — signal may be orphaned`);
      }

      // Clean up hedge manager in-memory maps (cooldown, peak, banked profit)
      // so flipped signal starts fresh — prevents stale cooldown blocking new hedges
      await this.hedgeManager.cleanupSignal((signal as any)._id?.toString()).catch(() => {});

      // 5. Re-init grid for new direction — NO DCA after FLIP to reduce vol exposure
      const hedgeVol = newNotional; // actual hedge volume (e.g. 750)
      const newGrids: any[] = [
        // L0 = full hedge volume, already filled. No DCA levels — FLIP trades run at hedge vol only
        { level: 0, deviationPct: 0, fillPrice: newEntry, volumePct: 100, status: "FILLED", filledAt: new Date(), simNotional: hedgeVol, simQuantity: hedgeVol / newEntry },
      ];
      (signal as any).gridLevels = newGrids;
      (signal as any).gridFilledCount = 1;
      (signal as any).gridClosedCount = 0;
      (signal as any).simNotional = hedgeVol;
      (signal as any).simQuantity = hedgeVol / newEntry;

      await this.signalQueueService.updateSignalGrid((signal as any)._id.toString(), newGrids, 1, 0);
      await this.signalQueueService.initGridSignal((signal as any)._id.toString(), newEntry, newSl, newEntry);
      await this.signalQueueService.updateSimVolume((signal as any)._id.toString(), hedgeVol, hedgeVol / newEntry);

      // Write grid metadata to promoted FLIP_MAIN order
      if (flipHedgeOrderDoc) {
        await this.orderModel.findByIdAndUpdate(flipHedgeOrderDoc._id, {
          'metadata.gridLevels': newGrids,
          'metadata.gridFilledCount': 1,
          'metadata.gridClosedCount': 0,
        }).catch(() => {});
      }

      // Invalidate order cache — FLIP modified order types/metadata, stale cache causes wrong reads
      this.invalidateOrderCache((signal as any)._id?.toString());

      this.logger.log(
        `[PositionMonitor] 🔄 ${sigKey} FLIPPED to ${newDirection} | Entry: ${newEntry} | SL: ${newSl} (${flipSlPct}%) | TP: ${newTp} (${flipTpPct}%) | Main TP profit: $${mainPnlTotal.toFixed(2)}`,
      );

      // Notify
      if (this.hedgeCallback) {
        await this.hedgeCallback(signal, { action: 'CLOSE_HEDGE', hedgePnlPct: 0, hedgePnlUsdt: 0, reason: `FLIP: main TP → ${newDirection}`, hedgePhase: 'FLIP' }, price).catch(() => {});
      }
      this.resolvingSymbols.delete(sigKey);
      return;
    }

    // Prevent double-trigger: unregister first, then resolve
    if (this.resolvingSymbols.has(sigKey)) return;
    this.resolvingSymbols.add(sigKey);
    this.unregisterListener(signal);
    // Clean up hedge tracking when signal fully closes
    await this.hedgeManager.cleanupSignal((signal as any)._id?.toString()).catch(() => {});

    // Trail stop: SL hit but price is still above entry (LONG) or below entry (SHORT)
    // This means the trailing SL locked in profit — label as TRAIL_STOP, not STOP_LOSS
    const entryRef = (signal as any).gridAvgEntry || signal.entryPrice;
    const isTrailStop = slHit && !tpHit && (
      (direction === "LONG" && stopLossPrice > entryRef) ||
      (direction === "SHORT" && stopLossPrice < entryRef)
    );
    const reason = tpHit ? "TAKE_PROFIT" : isTrailStop ? "TRAIL_STOP" : "STOP_LOSS";
    const emoji = tpHit ? "🎯" : isTrailStop ? "🔒" : "🛑";
    // Use current market price for exit — sim mode has no real orders on Binance
    // SL/TP prices are triggers, actual exit is at market price (more realistic)
    const exitPrice = price;
    this.logger.log(
      `[PositionMonitor] ${emoji} ${sigKey} price=${price} exit=${exitPrice} hit ${reason} (${direction} SL=${stopLossPrice} TP=${takeProfitPrice ?? "none"})`,
    );

    try {
      const resolved = await this.signalQueueService.resolveActiveSignal(
        sigKey,
        exitPrice,
        reason,
      );

      // Close all open orders for this signal — apply exit fees + funding
      const openOrders = await this.orderModel.find({ signalId: (signal as any)._id, status: 'OPEN' });
      const fundingRate = (signal as any).fundingRate || 0;

      // Safety net: if no orders exist (signal created before order system), create MAIN order
      if (openOrders.length === 0) {
        const allOrders = await this.orderModel.countDocuments({ signalId: (signal as any)._id });
        if (allOrders === 0) {
          const entryForOrder = (signal as any).gridAvgEntry || signal.entryPrice;
          const vol = (signal as any).simNotional ? (signal as any).simNotional * 0.4 : 400;
          const entryFee = this.calcTakerFee(vol);
          const exitFee = this.calcTakerFee(vol);
          const hoursHeld = signal.executedAt ? (Date.now() - new Date(signal.executedAt).getTime()) / 3600000 : 0;
          const fundFee = this.tradingConfig.get().simFundingEnabled
            ? this.calcFundingFee(vol, Math.abs(fundingRate), hoursHeld) : 0;
          const ordPnlPct = signal.direction === 'LONG'
            ? ((exitPrice - entryForOrder) / entryForOrder) * 100
            : ((entryForOrder - exitPrice) / entryForOrder) * 100;
          const ordPnlUsdt = Math.round(((ordPnlPct / 100) * vol - entryFee - exitFee - fundFee) * 100) / 100;
          await new this.orderModel({
            signalId: (signal as any)._id, symbol: signal.symbol, direction: signal.direction,
            type: 'MAIN', status: 'CLOSED',
            entryPrice: entryForOrder, exitPrice, notional: vol, quantity: vol / entryForOrder,
            pnlPercent: ordPnlPct, pnlUsdt: ordPnlUsdt, closeReason: reason,
            openedAt: signal.executedAt, closedAt: new Date(), cycleNumber: 0,
            entryFeeUsdt: entryFee, exitFeeUsdt: exitFee, fundingFeeUsdt: fundFee,
            metadata: { fallbackCreated: true },
          }).save();
          this.logger.warn(`[PositionMonitor] Safety net: created MAIN order for ${signal.symbol} (no orders existed)`);
        }
      }

      for (const order of openOrders) {
        const ordPnlPct = order.direction === 'LONG'
          ? ((exitPrice - order.entryPrice) / order.entryPrice) * 100
          : ((order.entryPrice - exitPrice) / order.entryPrice) * 100;
        const ordPnlUsdtRaw = (ordPnlPct / 100) * order.notional;
        const exitFee = this.calcTakerFee(order.notional);
        const hoursHeld = order.openedAt ? (Date.now() - new Date(order.openedAt).getTime()) / 3600000 : 0;
        const fundingFee = this.tradingConfig.get().simFundingEnabled
          ? this.calcFundingFee(order.notional, Math.abs(fundingRate), hoursHeld)
          : 0;
        const ordPnlUsdt = Math.round((ordPnlUsdtRaw - (order.entryFeeUsdt || 0) - exitFee - fundingFee) * 100) / 100;
        await this.orderModel.findByIdAndUpdate(order._id, {
          status: 'CLOSED', exitPrice, closedAt: new Date(), closeReason: reason,
          pnlPercent: ordPnlPct, pnlUsdt: ordPnlUsdt,
          exitFeeUsdt: exitFee, fundingFeeUsdt: fundingFee,
        });
      }

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

          // Per-grid USDT PnL (each grid has different fillPrice) — deduct fees
          const cfg = this.tradingConfig.get();
          const takerFeePct = cfg.simTakerFeePct / 100;
          const makerFeePct = cfg.simMakerFeePct / 100;
          const fundingRate = Math.abs((signal as any).fundingRate || 0);
          const hoursHeld = (signal as any).executedAt
            ? (Date.now() - new Date((signal as any).executedAt).getTime()) / 3600000 : 0;
          const fundingIntervals = Math.floor(hoursHeld / 8);

          let pnlUsdt: number | undefined;
          const grids: any[] = (signal as any).gridLevels || [];
          if (grids.length > 0) {
            let totalUsdt = 0;
            let totalFees = 0;
            for (const g of grids) {
              if (g.status === "FILLED") {
                const vol = g.simNotional || ((signal as any).simNotional || 1000) * (g.volumePct / 100);
                const gPnl = signal.direction === "LONG"
                  ? ((exitPrice - g.fillPrice) / g.fillPrice) * 100
                  : ((g.fillPrice - exitPrice) / g.fillPrice) * 100;
                totalUsdt += (gPnl / 100) * vol;
                const entryFee = g.level === 0 ? vol * takerFeePct : vol * makerFeePct;
                const exitFee = vol * takerFeePct;
                const fundFee = cfg.simFundingEnabled ? vol * fundingRate * fundingIntervals : 0;
                totalFees += entryFee + exitFee + fundFee;
              }
            }
            pnlUsdt = Math.round((totalUsdt - totalFees) * 100) / 100;
          } else {
            const filledVol = ((signal as any).simNotional || 1000) * 0.4;
            const rawPnl = (pnlPercent / 100) * filledVol;
            const fees = filledVol * takerFeePct * 2 + (cfg.simFundingEnabled ? filledVol * fundingRate * fundingIntervals : 0);
            pnlUsdt = Math.round((rawPnl - fees) * 100) / 100;
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

        // Safety: ensure MAIN order exists for every active signal
        const hasMain = await this.orderModel.countDocuments({ signalId: (signal as any)._id, type: MAIN_ORDER_TYPES });
        if (hasMain === 0) {
          const entry = (signal as any).gridAvgEntry || signal.entryPrice;
          const vol = ((signal as any).simNotional || 1000) * 0.4;
          const fee = this.calcTakerFee(vol);
          await this.orderModel.create({
            signalId: (signal as any)._id, symbol: signal.symbol, direction: signal.direction,
            type: 'MAIN', status: 'OPEN', entryPrice: entry, notional: vol, quantity: vol / entry,
            entryFeeUsdt: fee, openedAt: signal.executedAt || new Date(), cycleNumber: 0,
          }).catch(() => {});
          this.logger.warn(`[PositionMonitor] Safety: created missing MAIN order for ${signal.symbol}`);
        }
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

  /** Get the currently open HEDGE order from DB (source of truth for hedge state). */
  private async getActiveHedge(signalId: any): Promise<OrderDocument | null> {
    return this.orderModel.findOne({ signalId, type: 'HEDGE', status: 'OPEN' });
  }

  // ─── Auto-Hedge helpers ─────────────────────────────────────────────────

  /**
   * Widen SL to safety net on first tick when hedge is enabled.
   * Saves original SL so it can be restored after hedge closes.
   */
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

    const phase = action.hedgePhase || "FULL";

    // Update in-memory signal
    (signal as any).hedgeActive = true;
    (signal as any).hedgePhase = phase;
    (signal as any).hedgeDirection = action.hedgeDirection;
    (signal as any).hedgeEntryPrice = currentPrice;
    (signal as any).hedgeSimNotional = action.hedgeNotional;
    (signal as any).hedgeTpPrice = action.hedgeTpPrice;
    (signal as any).hedgeOpenedAt = new Date();
    // Reset exit flags — fresh hedge must NOT inherit stale breakeven/trail state
    (signal as any).hedgeSlAtEntry = false;
    (signal as any).hedgeTrailActivated = false;
    (signal as any).hedgePeakPnlPct = 0;

    // Disable SL when hedge active — hedge IS the risk management
    // SL disabled — hedge cycles until recovery (NET_POSITIVE > 2% net).
    (signal as any).stopLossPrice = 0;
    (signal as any).stopLossPercent = 0;
    (signal as any).hedgeSafetySlPrice = 0;
    this.logger.log(`[PositionMonitor] ${sigKey} SL DISABLED — hedge active, cycles until NET_POSITIVE > 2%`);

    // Update MAIN order SL to 0 (hedge manages risk)
    await this.orderModel.findOneAndUpdate(
      { signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN' },
      { stopLossPrice: 0 },
    ).catch(() => {});

    // Persist to DB — $unset stale exit flags from previous hedge cycle
    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      hedgeActive: true,
      hedgePhase: phase,
      hedgeDirection: action.hedgeDirection,
      hedgeEntryPrice: currentPrice,
      hedgeSimNotional: action.hedgeNotional,
      hedgeTpPrice: action.hedgeTpPrice,
      hedgeOpenedAt: new Date(),
      stopLossPrice: 0,
      stopLossPercent: 0,
      hedgeSafetySlPrice: 0,
      $unset: { hedgeSlAtEntry: 1, hedgeTrailActivated: 1, hedgePeakPnlPct: 1 },
    });

    // Create HEDGE order record (taker fee — market order)
    const hedgeEntryFee = this.calcTakerFee(action.hedgeNotional);
    await this.orderModel.create({
      signalId: (signal as any)._id,
      symbol: signal.symbol,
      direction: action.hedgeDirection,
      type: 'HEDGE',
      status: 'OPEN',
      entryPrice: currentPrice,
      notional: action.hedgeNotional,
      quantity: action.hedgeNotional / currentPrice,
      takeProfitPrice: action.hedgeTpPrice, // stored for order-based reads
      entryFeeUsdt: hedgeEntryFee,
      openedAt: new Date(),
      cycleNumber: ((signal as any).hedgeCycleCount || 0) + 1,
      metadata: { phase: action.hedgePhase, reason: action.reason },
    });
    this.invalidateOrderCache((signal as any)._id?.toString());

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
  private closingHedge = new Set<string>();

  private async handleHedgeClose(
    signal: AiSignalDocument,
    action: HedgeAction,
    currentPrice: number,
  ): Promise<void> {
    const sigKey = this.getSignalKey(signal);
    const signalId = (signal as any)._id?.toString();
    if (!signalId) return;

    // Guard: prevent concurrent hedge close for same signal
    if (this.closingHedge.has(sigKey)) return;
    this.closingHedge.add(sigKey);
    try { await this._handleHedgeCloseInner(signal, action, currentPrice, sigKey, signalId); }
    finally { this.closingHedge.delete(sigKey); }
  }

  private async _handleHedgeCloseInner(
    signal: AiSignalDocument,
    action: HedgeAction,
    currentPrice: number,
    sigKey: string,
    signalId: string,
  ): Promise<void> {
    // Double-check hedge is still active (may have been closed by concurrent tick)
    if (!(signal as any).hedgeActive) return;

    const cycleCount = ((signal as any).hedgeCycleCount || 0) + 1;

    // Query HEDGE order from DB (source of truth for hedge state)
    const hedgeOrderForClose = await this.orderModel.findOne({
      signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN',
    }).lean().catch(() => null);
    if (!hedgeOrderForClose) {
      this.logger.warn(`[PositionMonitor] ${sigKey} handleHedgeClose: NO HEDGE order found — using signal fallback (pre-migration signal)`);
    }

    // Use HEDGE order as source of truth for close data
    // If no order exists (pre-migration signal), validate signal.hedgeEntryPrice
    const hedgeNotionalForFees = (hedgeOrderForClose as any)?.notional ?? (signal as any).hedgeSimNotional ?? 0;
    const hedgeOpenedAtForFees = (hedgeOrderForClose as any)?.openedAt ?? (signal as any).hedgeOpenedAt;
    const hedgeDirForHistory = (hedgeOrderForClose as any)?.direction ?? (signal as any).hedgeDirection;
    let hedgeEntryForHistory: number;
    if (hedgeOrderForClose?.entryPrice) {
      // Order exists — use it (trusted source)
      hedgeEntryForHistory = hedgeOrderForClose.entryPrice;
    } else {
      // No order — validate signal.hedgeEntryPrice
      const signalEntry = (signal as any).hedgeEntryPrice;
      const avgEntry = (signal as any).gridAvgEntry || signal.entryPrice;
      if (signalEntry && avgEntry && Math.abs(signalEntry - avgEntry) / avgEntry >= 0.005) {
        // Entry differs from gridAvgEntry → likely real
        hedgeEntryForHistory = signalEntry;
      } else {
        // Entry missing or matches gridAvgEntry → stale/corrupted → use currentPrice (PnL≈0)
        this.logger.warn(`[PositionMonitor] ${sigKey} No HEDGE order + stale entry (${signalEntry}) ≈ gridAvgEntry (${avgEntry}) — using currentPrice ${currentPrice}`);
        hedgeEntryForHistory = currentPrice;
      }
    }
    const hedgePhaseForHistory = (hedgeOrderForClose as any)?.metadata?.phase ?? (signal as any).hedgePhase;
    const entryReason = (hedgeOrderForClose as any)?.metadata?.reason || '';

    // Calculate hedge fees
    const hedgeEntryFeeCalc = this.calcTakerFee(hedgeNotionalForFees);
    const hedgeExitFeeCalc = this.calcTakerFee(hedgeNotionalForFees);
    const hedgeHoursHeldCalc = hedgeOpenedAtForFees
      ? (Date.now() - new Date(hedgeOpenedAtForFees).getTime()) / 3600000 : 0;
    const hedgeFundingRateCalc = (signal as any).fundingRate || 0;
    const hedgeFundingFeeCalc = this.tradingConfig.get().simFundingEnabled
      ? this.calcFundingFee(hedgeNotionalForFees, Math.abs(hedgeFundingRateCalc), hedgeHoursHeldCalc) : 0;
    const hedgeTotalFees = hedgeEntryFeeCalc + hedgeExitFeeCalc + hedgeFundingFeeCalc;
    const hedgePnlUsdtNet = Math.round(((action.hedgePnlUsdt || 0) - hedgeTotalFees) * 100) / 100;

    // Build hedge history entry (with fee-deducted PnL)
    const historyEntry = {
      phase: hedgePhaseForHistory,
      direction: hedgeDirForHistory,
      entryPrice: hedgeEntryForHistory,
      exitPrice: currentPrice,
      notional: hedgeNotionalForFees,
      pnlPct: action.hedgePnlPct,
      pnlUsdt: hedgePnlUsdtNet,
      openedAt: hedgeOpenedAtForFees || (signal as any).hedgeOpenedAt,
      closedAt: new Date(),
      reason: action.reason,
      entryReason, // e.g. "PnL -19.52% | Cycle 1 (immediate) | regime: MIXED | banked: $147.36"
    };

    // After hedge close: restore wide SL (40%) — let hedge continue cycling.
    // No safety net cut-loss — hedge cycles until NET_POSITIVE > 2%. Vol decay limits downside.
    const avgEntryForSl = (signal as any).gridAvgEntry || signal.entryPrice;
    const allHistory: any[] = [...((signal as any).hedgeHistory || []), historyEntry];
    const totalBanked = allHistory.reduce((s: number, h: any) => s + (h.pnlUsdt || 0), 0);
    const updates: Record<string, any> = {};
    const slPct = 40;
    let finalSlPrice = signal.direction === 'LONG'
      ? +(avgEntryForSl * (1 - slPct / 100)).toFixed(6)
      : +(avgEntryForSl * (1 + slPct / 100)).toFixed(6);
    let finalSlPercent = slPct;
    this.logger.log(
      `[PositionMonitor] ${sigKey} SL restored to ${finalSlPrice} (${finalSlPercent.toFixed(1)}%) after hedge close | cycle=${cycleCount} banked=$${totalBanked.toFixed(2)}`,
    );

    // Restore SL on MAIN order
    await this.orderModel.findOneAndUpdate(
      { signalId: (signal as any)._id, type: MAIN_ORDER_TYPES, status: 'OPEN' },
      { stopLossPrice: finalSlPrice },
    ).catch(() => {});

    // Update in-memory signal (hedgeHistory MUST be updated so next cycle's progressive SL sees all history)
    (signal as any).hedgeHistory = allHistory;
    (signal as any).hedgeActive = false;
    (signal as any).hedgePhase = undefined;
    (signal as any).hedgeDirection = undefined;
    (signal as any).hedgeEntryPrice = undefined;
    (signal as any).hedgeSimNotional = undefined;
    (signal as any).hedgeTpPrice = undefined;
    (signal as any).hedgeSlAtEntry = false;
    (signal as any).hedgeOpenedAt = undefined;
    (signal as any).hedgeCycleCount = cycleCount;
    (signal as any).stopLossPrice = finalSlPrice;
    (signal as any).stopLossPercent = finalSlPercent;
    (signal as any).hedgeSafetySlPrice = finalSlPrice || undefined;
    (signal as any).netPeakPnlPct = 0; // Reset net trail state — prevent stale NET_POSITIVE on next cycle
    (signal as any).netTrailActivated = false;

    // Persist to DB
    const unsetFields: Record<string, number> = {
      hedgePhase: 1, hedgeDirection: 1, hedgeEntryPrice: 1,
      hedgeSimNotional: 1, hedgeTpPrice: 1, hedgeOpenedAt: 1, hedgeSlAtEntry: 1,
    };
    if (!finalSlPrice) unsetFields.hedgeSafetySlPrice = 1;

    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      hedgeActive: false,
      $unset: unsetFields,
      hedgeCycleCount: cycleCount,
      stopLossPrice: finalSlPrice,
      stopLossPercent: finalSlPercent,
      netPeakPnlPct: 0,
      netTrailActivated: false,
      $push: { hedgeHistory: historyEntry },
      ...updates,
    });

    // Close the HEDGE order — apply exit fee + funding
    {
      const hedgeEntry = historyEntry.entryPrice;
      const hedgeExit = currentPrice;
      const hedgeNotional = historyEntry.notional || 0;
      const hedgePnlPctCalc = historyEntry.direction === "LONG"
        ? ((hedgeExit - hedgeEntry) / hedgeEntry) * 100
        : ((hedgeEntry - hedgeExit) / hedgeEntry) * 100;
      const hedgePnlUsdtRaw = (hedgePnlPctCalc / 100) * hedgeNotional;
      const hedgeEntryFee = this.calcTakerFee(hedgeNotional); // entry fee (was missing)
      const hedgeExitFee = this.calcTakerFee(hedgeNotional);
      const hedgeHoursHeld = historyEntry.openedAt
        ? (Date.now() - new Date(historyEntry.openedAt).getTime()) / 3600000 : 0;
      const fundingRate = (signal as any).fundingRate || 0;
      const hedgeFundingFee = this.tradingConfig.get().simFundingEnabled
        ? this.calcFundingFee(hedgeNotional, Math.abs(fundingRate), hedgeHoursHeld) : 0;
      const hedgePnlUsdtCalc = Math.round((hedgePnlUsdtRaw - hedgeEntryFee - hedgeExitFee - hedgeFundingFee) * 100) / 100;

      let closeReasonOrder = "HEDGE_CLOSE";
      if (action.reason?.includes("Recovery")) closeReasonOrder = "HEDGE_RECOVERY";
      else if (action.reason?.includes("trail")) closeReasonOrder = "HEDGE_TRAIL";
      else if (action.reason?.includes("TP")) closeReasonOrder = "HEDGE_TP";
      else if (hedgePnlUsdtCalc >= 0) closeReasonOrder = "HEDGE_TP";

      // Use loose query (no cycleNumber) to avoid desync — sort by openedAt desc to get latest
      await this.orderModel.findOneAndUpdate(
        { signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN' },
        {
          status: 'CLOSED',
          exitPrice: currentPrice,
          pnlPercent: hedgePnlPctCalc,
          pnlUsdt: hedgePnlUsdtCalc,
          exitFeeUsdt: hedgeExitFee,
          fundingFeeUsdt: hedgeFundingFee,
          closedAt: new Date(),
          closeReason: closeReasonOrder,
        },
      );
    }

    // NOTE: No separate COMPLETED signal for hedge — order records are the source of truth
    this.invalidateOrderCache((signal as any)._id?.toString());

    this.logger.log(
      `[PositionMonitor] ${sigKey} HEDGE CLOSED | PnL: ${action.hedgePnlPct?.toFixed(2)}% ($${action.hedgePnlUsdt?.toFixed(2)}) | ` +
      `SL: ${finalSlPrice} (${finalSlPercent.toFixed(1)}%) | Cycle: ${cycleCount} | Reason: ${action.reason}`,
    );

    // Notify via callback
    if (this.hedgeCallback) {
      await this.hedgeCallback(signal, action, currentPrice).catch((err) =>
        this.logger.warn(`[PositionMonitor] hedgeCallback error ${sigKey}: ${err?.message}`),
      );
    }

  }
}
