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
    // peakPnlPct is already restored from DB via signal object

    // When hedge enabled: ensure SL > hedge trigger so hedge has room to open
    const hedgeCfg = this.tradingConfig?.get();
    if (hedgeCfg?.hedgeEnabled && (signal as any).stopLossPrice > 0) {
      if (!(signal as any).originalSlPrice) {
        (signal as any).originalSlPrice = (signal as any).stopLossPrice;
      }

      // SL must be at least hedgeTrigger + 1% buffer (e.g. trigger=3% → SL min=4%)
      const minSlPct = (hedgeCfg.hedgePartialTriggerPct || 3) + 1.0;
      const avgEntry = (signal as any).gridAvgEntry || signal.entryPrice;
      const currentSlPct = Math.abs(((signal as any).stopLossPrice - avgEntry) / avgEntry * 100);

      if (currentSlPct < minSlPct) {
        const newSlPrice = signal.direction === 'LONG'
          ? +(avgEntry * (1 - minSlPct / 100)).toFixed(6)
          : +(avgEntry * (1 + minSlPct / 100)).toFixed(6);
        (signal as any).stopLossPrice = newSlPrice;
        (signal as any).stopLossPercent = minSlPct;
        this.aiSignalModel.findByIdAndUpdate((signal as any)._id, {
          originalSlPrice: (signal as any).originalSlPrice,
          stopLossPrice: newSlPrice,
          stopLossPercent: minSlPct,
        }).exec().catch(() => {});
        this.logger.log(
          `[PositionMonitor] ${sigKey} SL widened to ${minSlPct}% (${newSlPrice}) — min for hedge trigger at ${hedgeCfg.hedgePartialTriggerPct}%`,
        );
      } else {
        this.aiSignalModel.findByIdAndUpdate((signal as any)._id, {
          originalSlPrice: (signal as any).originalSlPrice,
        }).exec().catch(() => {});
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
      // Use original SL for grid spacing (not widened safety SL)
      const originalSlForGrid = (signal as any).originalSlPrice || (signal as any).stopLossPrice;
      const signalSlPct = Math.abs((originalSlForGrid - origEntry) / origEntry) * 100;
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
        `[PositionMonitor] Grid DCA init ${sigKey}: ${GRID_LEVEL_COUNT} levels, step=${gridStep.toFixed(2)}%, SL=${effectiveSl.toFixed(4)} (orig=${originalSlForGrid.toFixed(4)}), TP=${takeProfitPrice?.toFixed(4)}`,
      );

      // Create MAIN order for L0 (taker fee — market order)
      const gridNotionalL0 = simNotional * (DCA_WEIGHTS[0] / 100);
      const l0EntryFee = this.calcTakerFee(gridNotionalL0);
      await this.orderModel.create({
        signalId: (signal as any)._id,
        symbol: signal.symbol,
        direction: signal.direction,
        type: 'MAIN',
        status: 'OPEN',
        entryPrice: origEntry,
        notional: gridNotionalL0,
        quantity: gridNotionalL0 / origEntry,
        stopLossPrice: effectiveSl,
        takeProfitPrice: takeProfitPrice || 0,
        entryFeeUsdt: l0EntryFee,
        openedAt: new Date(),
        cycleNumber: 0,
      });
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
          // Guard against concurrent tick processing (async RSI check window)
          grid.status = "FILLING";

          // Cooldown: skip if last grid filled < 5 min ago
          const lastFill = grids
            .filter((g) => g.status === "FILLED" && g.filledAt)
            .map((g) => new Date(g.filledAt).getTime())
            .sort((a, b) => b - a)[0];
          if (lastFill && Date.now() - lastFill < 5 * 60 * 1000) { grid.status = "PENDING"; continue; }

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
          if (grid.level >= 1 && rsiOk === false) { grid.status = "PENDING"; continue; }
          const simTotalNotional = (signal as any).simNotional || 1000;
          const gridNotional = simTotalNotional * (grid.volumePct / 100);
          grid.status = "FILLED";
          grid.fillPrice = price;
          grid.filledAt = new Date();
          grid.simNotional = gridNotional;
          grid.simQuantity = gridNotional / price;

          // DCA fills update the MAIN order (add notional, recalculate avg price)
          const dcaEntryFee = this.calcMakerFee(gridNotional);
          const mainOrder = await this.orderModel.findOne({
            signalId: (signal as any)._id, type: 'MAIN', status: 'OPEN',
          });
          if (mainOrder) {
            const newNotional = mainOrder.notional + gridNotional;
            const newQty = mainOrder.quantity + gridNotional / price;
            const newAvgEntry = (mainOrder.entryPrice * mainOrder.notional + price * gridNotional) / newNotional;
            await this.orderModel.findByIdAndUpdate(mainOrder._id, {
              entryPrice: newAvgEntry,
              notional: newNotional,
              quantity: newQty,
              entryFeeUsdt: (mainOrder.entryFeeUsdt || 0) + dcaEntryFee,
            });
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
          if ((signal as any).hedgeActive) {
            (signal as any).stopLossPrice = 0;
          } else {
            const minSlPctDca = hedgeCfgNow?.hedgeEnabled
              ? (hedgeCfgNow.hedgePartialTriggerPct || 3) + 1.0  // min 4% for hedge room
              : 2.5;
            const rawSlPct = origEntry > 0
              ? Math.abs(((signal as any).originalSlPrice || (signal as any).stopLossPrice) - origEntry) / origEntry * 100
              : 2.5;
            const slPctForRecalc = Math.max(rawSlPct, minSlPctDca);
            const newSl = direction === "LONG"
              ? avgEntry * (1 - slPctForRecalc / 100)
              : avgEntry * (1 + slPctForRecalc / 100);
            (signal as any).stopLossPrice = newSl;
          }

          // DCA TP: 3% from new avgEntry
          const DCA_TP_PCT = 3.0;
          const newTp = direction === "LONG"
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
      // Skip trail SL when hedge is active — hedge manages risk
      const skipTrailSl = !!(signal as any).hedgeActive;
      const filledGrids = grids.filter((g) => g.status === "FILLED");
      if (filledGrids.length > 0) {
        const TRAIL_TRIGGER = 2.0;
        const TRAIL_KEEP_RATIO = 0.75; // keep 75% of peak profit
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
              const tpBoostCap = this.tradingConfig.get().tpBoostCap || 6;
              const boostedTpPct = Math.min(tpBoostCap, Math.max(currentTpPct, pnlFromAvg + 2.0));
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
    // Use gridAvgEntry for DCA signals (reflects actual cost basis after averaging down)
    const currentEntry = (signal as any).gridAvgEntry || entryPrice;
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
      const TRAIL_KEEP_RATIO = 0.75; // keep 75% of peak (was fixed 1.2% distance → avg win only $11)

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
        let closeReason: string | null = null;
        let exitPrice: number | null = null;
        const exitAction = this.hedgeManager.checkHedgeExit(signal, price, pnlPct);
        if (exitAction && exitAction.action === "CLOSE_HEDGE") {
          await this.handleHedgeClose(signal, exitAction, price);
        } else if (exitAction && (exitAction as any).hedgeSlAtEntry) {
          // Hedge profitable > 1% — move SL to entry (breakeven lock)
          (signal as any).hedgeSlAtEntry = true;
          this.aiSignalModel.findByIdAndUpdate((signal as any)._id, { hedgeSlAtEntry: true }).exec().catch(() => {});
        }

        // When hedge is active: NO SL — hedge IS the risk management
        // Only catastrophic stop at -25% (exchange issues, depeg, extreme events)
        const currentEntry = (signal as any).gridAvgEntry || entryPrice;
        const catastrophicPct = direction === "LONG"
          ? ((price - currentEntry) / currentEntry) * 100
          : ((currentEntry - price) / currentEntry) * 100;

        // ── Net Positive Exit: banked hedge profit + main unrealized > 0 → close all ──
        // Use closed HEDGE orders for accurate banked profit (fees already deducted)
        const closedHedgeOrders = await this.orderModel.find({
          signalId: (signal as any)._id, type: 'HEDGE', status: 'CLOSED',
        });
        const bankedProfit = closedHedgeOrders.reduce((sum, o) => sum + (o.pnlUsdt || 0), 0);
        const npGrids: any[] = (signal as any).gridLevels || [];
        const filledVol = npGrids.length > 0
          ? npGrids.filter((g: any) => g.status === "FILLED" || g.status === "TP_CLOSED" || g.status === "SL_CLOSED").reduce((s: number, g: any) => s + (g.simNotional || 0), 0) || ((signal as any).simNotional || 1000) * 0.4
          : ((signal as any).simNotional || 1000) * 0.4;
        const mainUnrealizedUsdt = (pnlPct / 100) * filledVol;
        // Include current open hedge PnL
        let currentHedgePnlUsdt = 0;
        if ((signal as any).hedgeEntryPrice && (signal as any).hedgeDirection) {
          const hDir = (signal as any).hedgeDirection;
          const hEntry = (signal as any).hedgeEntryPrice;
          const hNotional = (signal as any).hedgeSimNotional || 0;
          const hPnlPct = hDir === "LONG"
            ? ((price - hEntry) / hEntry) * 100
            : ((hEntry - price) / hEntry) * 100;
          currentHedgePnlUsdt = (hPnlPct / 100) * hNotional;
        }
        const netPnlUsdt = mainUnrealizedUsdt + bankedProfit + currentHedgePnlUsdt;

        let forceCloseReason: "NET_POSITIVE" | "CATASTROPHIC_STOP" | null = null;

        if (netPnlUsdt > 0) {
          this.logger.log(
            `[PositionMonitor] ${sigKey} NET POSITIVE EXIT | main=$${mainUnrealizedUsdt.toFixed(2)} banked=$${bankedProfit.toFixed(2)} hedge=$${currentHedgePnlUsdt.toFixed(2)} → net=$${netPnlUsdt.toFixed(2)}`,
          );
          forceCloseReason = "NET_POSITIVE";
        } else if (catastrophicPct <= -25) {
          this.logger.warn(
            `[PositionMonitor] ${sigKey} CATASTROPHIC STOP at ${price} (${catastrophicPct.toFixed(1)}%) while hedge active — force closing both`,
          );
          forceCloseReason = "CATASTROPHIC_STOP";
        }

        if (!forceCloseReason) return; // Skip all SL/TP — hedge manages, keep rỉa

        // ── Force close: close hedge first, then resolve main signal ──

        // Close open hedge if any
        if ((signal as any).hedgeEntryPrice && (signal as any).hedgeDirection) {
          const hDir = (signal as any).hedgeDirection;
          const hEntry = (signal as any).hedgeEntryPrice;
          const hNotional = (signal as any).hedgeSimNotional || 0;
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
      }
    }

    // ─── Original TP/SL check (non-grid signals) ──────────────────────────
    // Re-read takeProfitPrice in case it was boosted above
    const effectiveTpPrice = (signal as any).takeProfitPrice ?? takeProfitPrice;
    const stopLossPrice = (signal as any).stopLossPrice;
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

    // ── FLIP LOGIC: Main TP hit while hedge active → promote hedge to new main ──
    if (tpHit && hedgeActive && (signal as any).hedgeEntryPrice && (signal as any).hedgeDirection) {
      if (this.resolvingSymbols.has(sigKey)) return;
      this.logger.log(
        `[PositionMonitor] 🔄 ${sigKey} MAIN TP HIT while hedge active → FLIPPING to ${(signal as any).hedgeDirection}`,
      );

      // 1. Close MAIN order with TP profit
      const mainOrders = await this.orderModel.find({ signalId: (signal as any)._id, type: 'MAIN', status: 'OPEN' });
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

      // 2. Flip signal: hedge becomes new main
      const newDirection = (signal as any).hedgeDirection;
      const newEntry = (signal as any).hedgeEntryPrice;
      const newNotional = (signal as any).hedgeSimNotional || signal.simNotional || 1000;
      const hedgeCfgFlip = this.tradingConfig.get();
      const flipTpPct = 3.5; // TP for flipped position
      const flipSlPct = (hedgeCfgFlip.hedgePartialTriggerPct || 3) + 1.0; // 4%
      const newTp = newDirection === 'LONG'
        ? +(newEntry * (1 + flipTpPct / 100)).toFixed(6)
        : +(newEntry * (1 - flipTpPct / 100)).toFixed(6);
      const newSl = newDirection === 'LONG'
        ? +(newEntry * (1 - flipSlPct / 100)).toFixed(6)
        : +(newEntry * (1 + flipSlPct / 100)).toFixed(6);

      // Update signal in-memory
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
      (signal as any).slMovedToEntry = false;
      (signal as any).tpBoosted = false;
      (signal as any).peakPnlPct = 0;

      // 3. Promote HEDGE order to new MAIN
      const hedgeOrder = await this.orderModel.findOne({
        signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN',
      });
      if (hedgeOrder) {
        await this.orderModel.findByIdAndUpdate(hedgeOrder._id, {
          type: 'MAIN', stopLossPrice: newSl, takeProfitPrice: newTp,
        });
      }

      // 4. Persist to DB
      await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, {
        direction: newDirection,
        entryPrice: newEntry,
        gridAvgEntry: newEntry,
        originalEntryPrice: newEntry,
        stopLossPrice: newSl, stopLossPercent: flipSlPct,
        takeProfitPrice: newTp, takeProfitPercent: flipTpPct,
        originalSlPrice: newSl,
        hedgeActive: false, hedgeCycleCount: 0,
        slMovedToEntry: false, tpBoosted: false, peakPnlPct: 0,
        $unset: { hedgePhase: 1, hedgeDirection: 1, hedgeEntryPrice: 1, hedgeSimNotional: 1, hedgeTpPrice: 1, hedgeOpenedAt: 1, hedgeSafetySlPrice: 1, hedgeSlAtEntry: 1 },
      });

      // 5. Re-init grid for new direction
      const simNotional = newNotional;
      const DCA_WEIGHTS_FLIP = [40, 25, 35];
      const flipGridStep = flipSlPct / 3;
      const newGrids: any[] = [];
      for (let i = 0; i < 3; i++) {
        const dev = i * flipGridStep;
        const volPct = DCA_WEIGHTS_FLIP[i];
        const gridNot = simNotional * (volPct / 100);
        if (i === 0) {
          newGrids.push({ level: 0, deviationPct: 0, fillPrice: newEntry, volumePct: volPct, status: "FILLED", filledAt: new Date(), simNotional: gridNot, simQuantity: gridNot / newEntry });
        } else {
          newGrids.push({ level: i, deviationPct: parseFloat(dev.toFixed(3)), fillPrice: 0, volumePct: volPct, status: "PENDING" });
        }
      }
      (signal as any).gridLevels = newGrids;
      (signal as any).gridFilledCount = 1;
      (signal as any).gridClosedCount = 0;
      (signal as any).simNotional = simNotional;

      await this.signalQueueService.updateSignalGrid((signal as any)._id.toString(), newGrids, 1, 0);
      await this.signalQueueService.initGridSignal((signal as any)._id.toString(), newEntry, newSl, newEntry);

      this.logger.log(
        `[PositionMonitor] 🔄 ${sigKey} FLIPPED to ${newDirection} | Entry: ${newEntry} | SL: ${newSl} (${flipSlPct}%) | TP: ${newTp} (${flipTpPct}%) | Main TP profit: $${mainPnlTotal.toFixed(2)}`,
      );

      // Notify
      if (this.hedgeCallback) {
        await this.hedgeCallback(signal, { action: 'CLOSE_HEDGE', hedgePnlPct: 0, hedgePnlUsdt: 0, reason: `FLIP: main TP → ${newDirection}`, hedgePhase: 'FLIP' }, price).catch(() => {});
      }
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

    // Disable SL when hedge active — hedge IS the risk management
    // Catastrophic stop at -25% remains as absolute safety net in handlePriceTick
    (signal as any).stopLossPrice = 0;
    (signal as any).stopLossPercent = 0;
    (signal as any).hedgeSafetySlPrice = 0;
    this.logger.log(`[PositionMonitor] ${sigKey} SL DISABLED — hedge active, catastrophic stop at -25% remains`);

    // Persist to DB
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
      entryFeeUsdt: hedgeEntryFee,
      openedAt: new Date(),
      cycleNumber: ((signal as any).hedgeCycleCount || 0) + 1,
      metadata: { phase: action.hedgePhase, reason: action.reason },
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

    // Calculate hedge fees first (needed for accurate historyEntry PnL)
    const hedgeNotionalForFees = (signal as any).hedgeSimNotional || 0;
    const hedgeEntryFeeCalc = this.calcTakerFee(hedgeNotionalForFees);
    const hedgeExitFeeCalc = this.calcTakerFee(hedgeNotionalForFees);
    const hedgeHoursHeldCalc = (signal as any).hedgeOpenedAt
      ? (Date.now() - new Date((signal as any).hedgeOpenedAt).getTime()) / 3600000 : 0;
    const hedgeFundingRateCalc = (signal as any).fundingRate || 0;
    const hedgeFundingFeeCalc = this.tradingConfig.get().simFundingEnabled
      ? this.calcFundingFee(hedgeNotionalForFees, Math.abs(hedgeFundingRateCalc), hedgeHoursHeldCalc) : 0;
    const hedgeTotalFees = hedgeEntryFeeCalc + hedgeExitFeeCalc + hedgeFundingFeeCalc;
    const hedgePnlUsdtNet = Math.round(((action.hedgePnlUsdt || 0) - hedgeTotalFees) * 100) / 100;

    // Build hedge history entry (with fee-deducted PnL)
    const historyEntry = {
      phase: (signal as any).hedgePhase,
      direction: (signal as any).hedgeDirection,
      entryPrice: (signal as any).hedgeEntryPrice,
      exitPrice: currentPrice,
      notional: (signal as any).hedgeSimNotional,
      pnlPct: action.hedgePnlPct,
      pnlUsdt: hedgePnlUsdtNet,
      openedAt: (signal as any).hedgeOpenedAt,
      closedAt: new Date(),
      reason: action.reason,
    };

    // Determine new SL: restore to min 4% (not 10% safety) after hedge closes
    // Use improved SL if hedge was profitable, otherwise restore to hedgeTrigger+1%
    const hedgeCfgClose = this.tradingConfig.get();
    const minSlPctClose = (hedgeCfgClose.hedgePartialTriggerPct || 3) + 1.0; // 4%
    const avgEntryClose = (signal as any).gridAvgEntry || signal.entryPrice;
    const minSlPriceClose = signal.direction === 'LONG'
      ? +(avgEntryClose * (1 - minSlPctClose / 100)).toFixed(6)
      : +(avgEntryClose * (1 + minSlPctClose / 100)).toFixed(6);
    const newSlPrice = action.newSlPrice || minSlPriceClose;

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
    (signal as any).hedgeSlAtEntry = false;
    (signal as any).hedgeOpenedAt = undefined;
    (signal as any).hedgeCycleCount = cycleCount;

    // Smart SL restore: don't set SL if price is ALREADY below it (would trigger instant SL)
    // JCT lesson: hedge breakeven close at 0.002156, SL restored to 0.002408 → instant SL hit
    const wouldInstantSl = signal.direction === 'LONG'
      ? currentPrice <= newSlPrice * 1.005  // within 0.5% of SL
      : currentPrice >= newSlPrice * 0.995;
    if (wouldInstantSl && cycleCount > 0) {
      // Price too close to or below SL — keep SL=0, let hedge re-enter
      (signal as any).stopLossPrice = 0;
      (signal as any).stopLossPercent = 0;
      this.logger.log(`[PositionMonitor] ${sigKey} SL stays DISABLED after hedge close — price ${currentPrice} too close to SL ${newSlPrice}`);
    } else {
      (signal as any).stopLossPrice = newSlPrice;
      (signal as any).stopLossPercent = minSlPctClose;
    }
    (signal as any).hedgeSafetySlPrice = undefined;

    // Don't resume trail SL — let next checkHedge cycle decide if re-entry needed
    // Trail resumes naturally when main PnL > 0 (profitable)

    // Persist to DB
    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      hedgeActive: false,
      $unset: { hedgePhase: 1, hedgeDirection: 1, hedgeEntryPrice: 1, hedgeSimNotional: 1, hedgeTpPrice: 1, hedgeOpenedAt: 1, hedgeSafetySlPrice: 1, hedgeSlAtEntry: 1 },
      hedgeCycleCount: cycleCount,
      stopLossPrice: newSlPrice,
      stopLossPercent: minSlPctClose,
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

      await this.orderModel.findOneAndUpdate(
        { signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN', cycleNumber: cycleCount },
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
