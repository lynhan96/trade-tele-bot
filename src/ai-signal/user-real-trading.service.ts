import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { TelegramBotService } from "../telegram/telegram.service";
import { UserSettingsService } from "../user/user-settings.service";
import { MarketDataService } from "../market-data/market-data.service";
import { SubscriberInfo, UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { SignalQueueService } from "./signal-queue.service";
import { UserTrade, UserTradeDocument } from "../schemas/user-trade.schema";
import { DailyLimitHistory, DailyLimitHistoryDocument } from "../schemas/daily-limit-history.schema";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";
import { HedgeManagerService, HedgePositionContext } from "./hedge-manager.service";
import { TradingConfigService } from "./trading-config";
import { getProxyAgent } from "../utils/proxy";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios");

/** Max tolerance — skip order if price moved beyond this from signal entry. */
const ENTRY_PRICE_TOLERANCE = 0.02; // 2%

/** TradFi-Perps symbols that require separate Binance agreement — skip for real orders. */
const TRADFI_BLACKLIST = new Set(["XAUUSDT", "XAGUSDT", "MSTRUSDT"]);

/** Redis key for caching symbol quantity precision. */
const QTY_PRECISION_KEY = (symbol: string) => `cache:binance:qty-precision:${symbol}`;
/** Redis key for caching symbol price precision (tick size decimals). */
const PRICE_PRECISION_KEY = (symbol: string) => `cache:binance:price-precision:${symbol}`;
/** Redis lock to prevent duplicate order placement (30s TTL). Keyed by direction to allow LONG+SHORT on same symbol. */
const ORDER_LOCK_KEY = (telegramId: number, symbol: string, direction: string) => `cache:order-lock:${telegramId}:${symbol}:${direction}`;
/** Redis counter for atomic position slot reservation. */
const POS_SLOT_KEY = (telegramId: number) => `cache:pos-slots:${telegramId}`;
/** Redis key for temporarily blacklisting closed/errored symbols (1h TTL). */
const CLOSED_SYMBOL_KEY = (symbol: string) => `cache:closed-symbol:${symbol}`;
/** Redis key for 1h cooldown after all positions close via TP (prevent over-trading on new cycle). */
const TP_CYCLE_COOLDOWN_KEY = (telegramId: number) => `cache:tp-cycle-cooldown:${telegramId}`;

/** Binance Futures taker fee: 0.04% per side × 2 (open + close) = 0.08% total. */
const BINANCE_FEE_PCT = 0.08;

@Injectable()
export class UserRealTradingService implements OnModuleInit {
  private readonly logger = new Logger(UserRealTradingService.name);

  /** Injected lazily to break circular dep with UserDataStreamService. */
  private userDataStreamService: any;

  constructor(
    private readonly subscriptionService: UserSignalSubscriptionService,
    private readonly userSettingsService: UserSettingsService,
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramBotService,
    private readonly redisService: RedisService,
    private readonly marketDataService: MarketDataService,
    private readonly signalQueueService: SignalQueueService,
    @InjectModel(UserTrade.name)
    private readonly userTradeModel: Model<UserTradeDocument>,
    @InjectModel(DailyLimitHistory.name)
    private readonly dailyLimitHistoryModel: Model<DailyLimitHistoryDocument>,
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    private readonly tradingConfig: TradingConfigService,
    private readonly hedgeManager: HedgeManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Close orphan trade records (positions not opened by our bot — no aiSignalId)
    const orphanResult = await this.userTradeModel.updateMany(
      { status: "OPEN", $or: [{ aiSignalId: { $exists: false } }, { aiSignalId: null }] },
      { $set: { status: "CLOSED", closeReason: "ORPHAN_CLEANUP", closedAt: new Date() } },
    );
    if (orphanResult.modifiedCount > 0) {
      this.logger.log(`[Startup] Closed ${orphanResult.modifiedCount} orphan trade record(s) without aiSignalId`);
    }

    // Migration: set cycleResetAt for users with open positions who have cycle limits but no cycleResetAt
    await this.migrateToCycleSystem();

    // Re-open data streams for any users with OPEN trades (bot restart recovery)
    // Delayed to allow UserDataStreamService to initialize first
    setTimeout(() => this.reRegisterOpenTradeStreams().catch(() => {}), 5_000);

    // TP sync for open trades is handled by protectOpenTrades (every 1 min)
    // — no need for separate startup sync.
  }

  /** One-time migration: set cycleResetAt for users with open trades + cycle limits configured. */
  private async migrateToCycleSystem(): Promise<void> {
    try {
      const openTrades = await this.userTradeModel.find({ status: "OPEN" }).lean();
      const userIds = [...new Set(openTrades.map((t) => t.telegramId))];

      for (const telegramId of userIds) {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) continue;
        if (sub.cycleResetAt) continue; // already migrated
        if (!sub.realModeDailyTargetPct && !sub.realModeDailyStopLossPct) continue; // no limits set

        // Find earliest open trade as cycle start
        const earliestTrade = openTrades
          .filter((t) => t.telegramId === telegramId)
          .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime())[0];

        if (earliestTrade) {
          await this.subscriptionService.setCycleResetAt(telegramId, new Date(earliestTrade.openedAt));
          this.logger.log(`[Migration] Set cycleResetAt for user ${telegramId} to ${earliestTrade.openedAt}`);
        }
      }
    } catch (err) {
      this.logger.error(`[Migration] migrateToCycleSystem error: ${err?.message}`);
    }
  }

  /**
   * One-time startup: sync TP orders on Binance for open trades where DB TP differs from signal TP.
   * With dynamic ATR-based TP, each trade keeps its own TP — no forced global override.
   */
  private async syncTpForOpenTrades(): Promise<void> {
    // Dynamic TP: each trade has its own ATR-based TP set at creation.
    // No forced sync needed — protectOpenTrades handles missing TP/SL orders.
    this.logger.debug(`[Startup] syncTpForOpenTrades: skipped (dynamic TP mode)`);
  }

  /** Set the UserDataStreamService (called by UserDataStreamService.onModuleInit to avoid circular dep). */
  setDataStreamService(svc: any): void {
    this.userDataStreamService = svc;
  }

  // ─── Signal activated: place real orders ─────────────────────────────────

  /**
   * Called when a new signal becomes ACTIVE.
   * Places MARKET orders on Binance for all users with realModeEnabled = true.
   */
  async onSignalActivated(signal: AiSignalDocument, params: AiTunedParams): Promise<void> {
    const subscribers = await this.subscriptionService.findRealModeSubscribers();
    if (subscribers.length === 0) return;

    const { symbol, direction, entryPrice, stopLossPrice, takeProfitPrice } = signal;

    // Skip TradFi-Perps symbols (require separate Binance agreement)
    if (TRADFI_BLACKLIST.has(symbol)) {
      this.logger.log(`[RealTrading] ${symbol}: TradFi symbol — skipping real orders`);
      return;
    }

    // Skip symbols temporarily marked as closed (e.g. maintenance)
    const closedFlag = await this.redisService.get<boolean>(CLOSED_SYMBOL_KEY(symbol));
    if (closedFlag) {
      this.logger.log(`[RealTrading] ${symbol}: symbol temporarily closed — skipping`);
      return;
    }

    const currentPrice = await this.marketDataService.getPrice(symbol);
    if (!currentPrice) {
      this.logger.warn(`[RealTrading] ${symbol}: cannot fetch current price, skipping real orders`);
      return;
    }

    const priceDeviation = Math.abs(currentPrice - entryPrice) / entryPrice;
    if (priceDeviation > ENTRY_PRICE_TOLERANCE) {
      this.logger.log(
        `[RealTrading] ${symbol} price deviation ${(priceDeviation * 100).toFixed(2)}% > ${(ENTRY_PRICE_TOLERANCE * 100).toFixed(1)}% — skipping real orders`,
      );
      // Notify all real-mode subscribers about the skip
      for (const sub of subscribers) {
        const msg =
          `⚠️ *Real Mode: Bo qua lenh*\n\n` +
          `${symbol} ${direction}\n` +
          `Gia tin hieu: $${entryPrice.toFixed(4)}\n` +
          `Gia hien tai: $${currentPrice.toFixed(4)}\n` +
          `Lech: ${(priceDeviation * 100).toFixed(2)}% > ${(ENTRY_PRICE_TOLERANCE * 100).toFixed(1)}%\n\n` +
          `_Lenh khong duoc dat do gia di qua xa diem vao._`;
        await this.telegramService.sendTelegramMessage(sub.chatId, msg).catch(() => {});
      }
      return;
    }

    // Filter out subscribers who already have an open trade on this symbol + direction
    const eligibleSubs: typeof subscribers = [];
    for (const sub of subscribers) {
      // cyclePaused check removed — user manages their own targets

      // TP cycle cooldown removed — user manages their own targets

      // Block same symbol + same direction (Binance one-way mode: can't have 2 independent positions same side)
      const existing = await this.userTradeModel.findOne({ telegramId: sub.telegramId, symbol, direction, status: "OPEN" }).lean();
      if (existing) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${sub.telegramId} already has OPEN ${direction} position, skipping`);
        continue;
      }

      // Atomic position slot reservation via Redis Lua script (prevents race condition)
      // Cap maxOpenPositions to maxActiveSignals (sim controls signal count, real follows)
      const cfgMaxSignals = this.tradingConfig.get().maxActiveSignals || 10;
      const maxPos = Math.min(sub.maxOpenPositions ?? 10, cfgMaxSignals);
      const slotKey = POS_SLOT_KEY(sub.telegramId);
      const dbCount = await this.userTradeModel.countDocuments({ telegramId: sub.telegramId, status: "OPEN" });
      const reserved = await this.redisService.initAndIncr(slotKey, dbCount, 300);
      if (reserved > maxPos) {
        await this.redisService.decr(slotKey);
        this.logger.log(
          `[RealTrading] ${symbol}: user ${sub.telegramId} at max positions (${reserved - 1}/${maxPos}), skipping`,
        );
        continue;
      }

      eligibleSubs.push(sub);
    }
    if (eligibleSubs.length === 0) return;

    const [precision, pricePrecision] = await Promise.all([
      this.getQuantityPrecision(symbol),
      this.getPricePrecision(symbol),
    ]);

    await Promise.allSettled(
      eligibleSubs.map((sub) =>
        this.placeOrderForUser(sub, signal, params, currentPrice, precision, pricePrecision),
      ),
    );
  }

  private async placeOrderForUser(
    sub: SubscriberInfo,
    signal: AiSignalDocument,
    params: AiTunedParams,
    currentPrice: number,
    quantityPrecision: number,
    pricePrecision: number = 4,
  ): Promise<void> {
    const { telegramId, chatId } = sub;
    const { symbol, direction, entryPrice, stopLossPrice, takeProfitPrice } = signal;
    const slotKey = POS_SLOT_KEY(telegramId);

    const lockKey = ORDER_LOCK_KEY(telegramId, symbol, direction);
    try {
      // Redis lock to prevent duplicate orders — 120s TTL (was 30s, too short for queued promotion gaps)
      const acquired = await this.redisService.setNX(lockKey, "1", 120);
      if (!acquired) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} order lock active (${direction}), skipping duplicate`);
        await this.redisService.decr(slotKey); // release reserved slot
        return;
      }

      const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
      if (!keys?.apiKey) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} has no Binance API keys`);
        await this.redisService.decr(slotKey);
        return;
      }

      // Final DB-level dedup: ensure no existing OPEN trade for same symbol+direction before placing
      const existingTrade = await this.userTradeModel.findOne({ telegramId, symbol, direction, status: "OPEN" });
      if (existingTrade) {
        this.logger.warn(`[RealTrading] ${symbol}: user ${telegramId} already has OPEN ${direction} trade in DB, skipping`);
        await this.redisService.decr(slotKey);
        return;
      }

      const leverage = await this.resolveLeverage(sub, params, keys.apiKey, keys.apiSecret, symbol);
      const fullVol = this.getVolForUser(signal.symbol, sub);
      // Grid: base order = 1/gridLevelCount of full volume (rest reserved for grid levels)
      const isGrid = sub.gridEnabled === true;
      // DCA: L0 gets 30% of volume, L1=30%, L2=40% (fixed 3 levels at 2/4/6%)
      const vol = isGrid ? fullVol * (UserRealTradingService.GRID_DCA_WEIGHTS[0] / 100) : fullVol;
      const rawQty = vol / currentPrice;
      const quantity = parseFloat(rawQty.toFixed(quantityPrecision));
      if (quantity <= 0) {
        this.logger.warn(`[RealTrading] ${symbol}: computed quantity ${quantity} <= 0 for user ${telegramId}`);
        return;
      }

      // Place market order
      const order = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
        symbol,
        side: direction as "LONG" | "SHORT",
        quantity,
        leverage,
      });

      const fillPrice = parseFloat(order.avgPrice) || currentPrice;
      const binanceOrderId = order.orderId?.toString() ?? "";

      // Wait for Binance to register the position before placing conditional orders
      // GTE_GTC algo orders require an open position to exist
      await new Promise((r) => setTimeout(r, 1500));

      // SL and TP — Grid DCA uses signal's own SL (grids fit within SL range). TP = signal's Fibo TP.
      const roundPrice = (p: number) => parseFloat(p.toFixed(pricePrecision));

      let effectiveSl = stopLossPrice;
      let effectiveTp = takeProfitPrice;
      // Grid: keep signal SL and TP as-is (no wider SL, no individual grid TP)
      let roundedSl = roundPrice(effectiveSl);
      let roundedTp = effectiveTp ? roundPrice(effectiveTp) : undefined;

      // Place SL algo order (with precision retry)
      let binanceSlAlgoId: string | undefined;
      try {
        const slOrder = await this.binanceService.setStopLoss(
          keys.apiKey, keys.apiSecret, symbol, roundedSl, direction as "LONG" | "SHORT", quantity,
        );
        binanceSlAlgoId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
      } catch (err) {
        if (err?.message?.includes("Precision")) {
          // Precision stale — refresh and retry once
          const freshPrec = await this.refreshPricePrecision(symbol);
          const retriedSl = parseFloat(effectiveSl.toFixed(freshPrec));
          this.logger.warn(`[RealTrading] ${symbol} SL precision retry: ${roundedSl} → ${retriedSl}`);
          try {
            const slOrder = await this.binanceService.setStopLoss(
              keys.apiKey, keys.apiSecret, symbol, retriedSl, direction as "LONG" | "SHORT", quantity,
            );
            binanceSlAlgoId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
            roundedSl = retriedSl;
          } catch (err2) {
            this.logger.error(`[RealTrading] ${symbol} SL retry also failed for user ${telegramId}: ${err2?.message}`);
            await this.telegramService.sendTelegramMessage(chatId,
              `⚠️ *Real Mode: SL Order That Bai*\n\n${symbol} — SL tai $${retriedSl} khong duoc dat.\nLoi: ${err2?.message}\n\n_Hay tu dat SL tren Binance._`
            ).catch(() => {});
          }
        } else {
          this.logger.error(`[RealTrading] ${symbol} SL order failed for user ${telegramId}: ${err?.message}`);
          await this.telegramService.sendTelegramMessage(chatId,
            `⚠️ *Real Mode: SL Order That Bai*\n\n${symbol} — SL tai $${roundedSl} khong duoc dat.\nLoi: ${err?.message}\n\n_Hay tu dat SL tren Binance._`
          ).catch(() => {});
        }
      }

      // Place TP algo order (if signal has TP price, with precision retry)
      let binanceTpAlgoId: string | undefined;
      if (roundedTp) {
        try {
          const tpOrder = await this.binanceService.setTakeProfitAtPrice(
            keys.apiKey, keys.apiSecret, symbol, roundedTp, direction as "LONG" | "SHORT", quantity,
          );
          binanceTpAlgoId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
        } catch (err) {
          if (err?.message?.includes("Precision")) {
            const freshPrec = await this.refreshPricePrecision(symbol);
            const retriedTp = parseFloat(effectiveTp!.toFixed(freshPrec));
            this.logger.warn(`[RealTrading] ${symbol} TP precision retry: ${roundedTp} → ${retriedTp}`);
            try {
              const tpOrder = await this.binanceService.setTakeProfitAtPrice(
                keys.apiKey, keys.apiSecret, symbol, retriedTp, direction as "LONG" | "SHORT", quantity,
              );
              binanceTpAlgoId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
              roundedTp = retriedTp;
            } catch (err2) {
              this.logger.warn(`[RealTrading] ${symbol} TP retry also failed for user ${telegramId}: ${err2?.message}`);
              await this.telegramService.sendTelegramMessage(chatId,
                `⚠️ *Real Mode: TP Order That Bai*\n\n${symbol} — TP tai $${retriedTp} khong duoc dat.\nLoi: ${err2?.message}\n\n_Lenh van mo, SL van hoat dong._`
              ).catch(() => {});
            }
          } else {
            this.logger.warn(`[RealTrading] ${symbol} TP order failed for user ${telegramId}: ${err?.message}`);
            await this.telegramService.sendTelegramMessage(chatId,
              `⚠️ *Real Mode: TP Order That Bai*\n\n${symbol} — TP tai $${roundedTp} khong duoc dat.\nLoi: ${err?.message}\n\n_Lenh van mo, SL van hoat dong._`
            ).catch(() => {});
          }
        }
      }

      // Save UserTrade to MongoDB
      const trade = await this.userTradeModel.create({
        telegramId,
        chatId,
        symbol,
        direction,
        entryPrice: fillPrice,
        quantity,
        leverage,
        notionalUsdt: quantity * fillPrice,
        slPrice: effectiveSl,
        tpPrice: effectiveTp ?? undefined,
        binanceOrderId,
        binanceSlAlgoId,
        binanceTpAlgoId,
        status: "OPEN",
        openedAt: new Date(),
        aiSignalId: (signal as any)._id?.toString(),
        // Grid DCA fields
        ...(isGrid ? {
          originalEntryPrice: fillPrice,
          gridGlobalSlPrice: effectiveSl,
          gridAvgEntry: fillPrice,
          gridFilledCount: 1,
          gridClosedCount: 0,
          gridLevels: this.buildGridLevels(fillPrice, direction, sub, effectiveSl),
        } : {}),
      });

      // Grid: set base grid quantity to the placed quantity
      if (isGrid && trade.gridLevels?.length > 0) {
        trade.gridLevels[0].quantity = quantity;
        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
          'gridLevels.0.quantity': quantity,
        });
      }

      this.logger.log(
        `[RealTrading] ${symbol} REAL order placed for user ${telegramId}: ${direction} ×${quantity} @ $${fillPrice} (×${leverage} lev)`,
      );

      // Auto-start cycle if not already started (first trade in new cycle)
      const subDoc = await this.subscriptionService.getSubscription(telegramId);
      if (subDoc && !subDoc.cycleResetAt && (subDoc.realModeDailyTargetPct || subDoc.realModeDailyStopLossPct)) {
        await this.subscriptionService.setCycleResetAt(telegramId, new Date());
        this.logger.log(`[RealTrading] Auto-started cycle for user ${telegramId}`);
      }

      // Send confirmation to user
      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
      const dirEmoji = direction === "LONG" ? "📈" : "📉";
      const actualSlPct = Math.abs(fillPrice - roundedSl) / fillPrice * 100;
      const actualTpPct = roundedTp ? Math.abs(roundedTp - fillPrice) / fillPrice * 100 : 0;
      const msg =
        `${dirEmoji} *Real Mode: Dat Lenh Thanh Cong*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Symbol: *${symbol}* ${direction}\n` +
        `So luong: *×${quantity}* (${leverage}x)\n` +
        `Gia vao: *${fmtP(fillPrice)}*\n` +
        `Stop Loss: *${fmtP(roundedSl)}* (${actualSlPct.toFixed(1)}%)${binanceSlAlgoId ? "" : " ⚠️"}\n` +
        (roundedTp ? `Take Profit: *${fmtP(roundedTp)}* (${actualTpPct.toFixed(1)}%)${binanceTpAlgoId ? "" : " ⚠️"}\n` : "") +
        `Volume: *${vol.toLocaleString()} USDT*` +
        (isGrid ? `\n🔲 Grid DCA: 4 levels (0/2/4/6%) | Signal SL/TP` : ``);
      await this.telegramService.sendTelegramMessage(chatId, msg).catch(() => {});

      // Register data stream to monitor fills/closings
      if (this.userDataStreamService) {
        await this.userDataStreamService.registerUser(telegramId, keys.apiKey, keys.apiSecret).catch(() => {});
      }
    } catch (err) {
      await this.redisService.decr(slotKey); // release reserved slot on failure
      await this.redisService.delete(lockKey); // release order lock so next signal isn't blocked
      this.logger.error(`[RealTrading] ${symbol} order failed for user ${telegramId}: ${err?.message}`);
      // Temporarily blacklist closed symbols so other users don't also fail
      if (err?.message?.includes("Symbol is closed")) {
        await this.redisService.set(CLOSED_SYMBOL_KEY(symbol), true, 3600); // 1h TTL
      }
      const errMsg = `❌ *Real Mode: Dat Lenh That Bai*\n\n${symbol} ${direction}\nLoi: ${err?.message ?? "unknown"}`;
      await this.telegramService.sendTelegramMessage(chatId, errMsg).catch(() => {});
    }
  }

  // ─── Move stop loss for real users ───────────────────────────────────────

  /**
   * Called when the global SL milestone (break-even or trailing stop) fires.
   * Moves the SL on Binance for all users with an OPEN trade for this symbol.
   */
  async moveStopLossForRealUsers(
    symbol: string,
    newSlPrice: number,
    direction: string,
  ): Promise<void> {
    // Only move SL for main trades (not hedge) matching the direction
    const openTrades = await this.userTradeModel.find({ symbol, status: "OPEN", direction, isHedge: { $ne: true } }).lean();
    if (openTrades.length === 0) return;

    // Round price to exchange precision before placing orders
    const pricePrecision = await this.getPricePrecision(symbol);
    const roundedSlPrice = parseFloat(newSlPrice.toFixed(pricePrecision));

    for (const trade of openTrades) {
      try {
        // Grid trades: use total filled quantity for SL order (not just base)
        const tradeQty = trade.gridLevels?.length > 0
          ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
          : trade.quantity;

        const keys = await this.userSettingsService.getApiKeys(trade.telegramId, "binance");
        if (!keys?.apiKey) continue;

        // Cancel existing SL algo order
        if (trade.binanceSlAlgoId) {
          await this.binanceService.cancelAlgoOrder(
            keys.apiKey,
            keys.apiSecret,
            trade.binanceSlAlgoId,
          );
        }

        // Place new SL (rounded to exchange precision, with precision retry)
        let finalSlPrice = roundedSlPrice;
        let slOrder: any;
        try {
          slOrder = await this.binanceService.setStopLoss(
            keys.apiKey, keys.apiSecret, symbol, finalSlPrice, direction as "LONG" | "SHORT", tradeQty,
          );
        } catch (slErr) {
          if (slErr?.message?.includes("Precision")) {
            const freshPrec = await this.refreshPricePrecision(symbol);
            finalSlPrice = parseFloat(newSlPrice.toFixed(freshPrec));
            this.logger.warn(`[RealTrading] ${symbol} SL precision retry: ${roundedSlPrice} → ${finalSlPrice}`);
            slOrder = await this.binanceService.setStopLoss(
              keys.apiKey, keys.apiSecret, symbol, finalSlPrice, direction as "LONG" | "SHORT", tradeQty,
            );
          } else {
            throw slErr;
          }
        }
        const newAlgoId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();

        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
          slPrice: finalSlPrice,
          binanceSlAlgoId: newAlgoId,
        });

        const isBreakEven = Math.abs(roundedSlPrice - trade.entryPrice) / trade.entryPrice < 0.001;
        const trailLockPct = direction === "LONG"
          ? ((roundedSlPrice - trade.entryPrice) / trade.entryPrice) * 100
          : ((trade.entryPrice - roundedSlPrice) / trade.entryPrice) * 100;

        const label = isBreakEven ? "hoa von (break-even)" : `+${trailLockPct.toFixed(1)}% (trailing stop)`;

        // Only notify break-even (first move to entry) — trailing updates are silent to avoid spam
        if (isBreakEven) {
          const fmtP = (p: number) =>
            p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
            p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
          const msg =
            `🔒 *Real Mode: SL Duoc Chuyen*\n\n` +
            `${symbol} ${direction}\n` +
            `SL moi: *${fmtP(roundedSlPrice)}* (hoa von — break-even)`;
          await this.telegramService.sendTelegramMessage(trade.chatId, msg).catch(() => {});
        }

        this.logger.log(
          `[RealTrading] ${symbol} SL moved to ${roundedSlPrice} for user ${trade.telegramId} (${label})`,
        );
      } catch (err) {
        this.logger.error(
          `[RealTrading] moveStopLoss failed for user ${trade.telegramId} ${symbol}: ${err?.message}`,
        );
      }
    }
  }

  /**
   * Move TP for all real users with an OPEN trade for this symbol.
   * Called when dynamic TP boost triggers (momentum detected).
   */
  async moveTpForRealUsers(
    symbol: string,
    newTpPrice: number,
    direction: string,
  ): Promise<void> {
    // Only move TP for main trades (not hedge) matching the direction
    const openTrades = await this.userTradeModel.find({ symbol, status: "OPEN", direction, isHedge: { $ne: true } }).lean();
    if (openTrades.length === 0) return;

    const pricePrecision = await this.getPricePrecision(symbol);
    const roundedTpPrice = parseFloat(newTpPrice.toFixed(pricePrecision));

    for (const trade of openTrades) {
      try {
        // Grid trades: use total filled quantity (not just base)
        const tradeQty = trade.gridLevels?.length > 0
          ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
          : trade.quantity;

        const keys = await this.userSettingsService.getApiKeys(trade.telegramId, "binance");
        if (!keys?.apiKey) continue;

        // Cancel existing TP algo order
        if (trade.binanceTpAlgoId) {
          await this.binanceService.cancelAlgoOrder(
            keys.apiKey,
            keys.apiSecret,
            trade.binanceTpAlgoId,
          );
        }

        // Place new TP (with precision retry)
        let finalTpPrice = roundedTpPrice;
        let tpOrder: any;
        try {
          tpOrder = await this.binanceService.setTakeProfitAtPrice(
            keys.apiKey, keys.apiSecret, symbol, finalTpPrice, direction as "LONG" | "SHORT", tradeQty,
          );
        } catch (tpErr) {
          if (tpErr?.message?.includes("Precision")) {
            const freshPrec = await this.refreshPricePrecision(symbol);
            finalTpPrice = parseFloat(newTpPrice.toFixed(freshPrec));
            this.logger.warn(`[RealTrading] ${symbol} TP precision retry: ${roundedTpPrice} → ${finalTpPrice}`);
            tpOrder = await this.binanceService.setTakeProfitAtPrice(
              keys.apiKey, keys.apiSecret, symbol, finalTpPrice, direction as "LONG" | "SHORT", tradeQty,
            );
          } else {
            throw tpErr;
          }
        }
        const newAlgoId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();

        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
          tpPrice: finalTpPrice,
          binanceTpAlgoId: newAlgoId,
        });

        const fmtP = (p: number) =>
          p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
          p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
        const msg =
          `🚀 *Real Mode: TP Mo Rong*\n\n` +
          `${symbol} ${direction}\n` +
          `TP moi: *${fmtP(roundedTpPrice)}* (momentum boost)`;
        await this.telegramService.sendTelegramMessage(trade.chatId, msg).catch(() => {});

        this.logger.log(
          `[RealTrading] ${symbol} TP extended to ${roundedTpPrice} for user ${trade.telegramId}`,
        );
      } catch (err) {
        this.logger.error(
          `[RealTrading] moveTp failed for user ${trade.telegramId} ${symbol}: ${err?.message}`,
        );
      }
    }
  }

  // ─── Trade close handler ──────────────────────────────────────────────────

  /**
   * Called by UserDataStreamService when a position close is detected.
   */
  async onTradeClose(
    telegramId: number,
    symbol: string,
    exitPrice: number,
    reason: string,
    closedDirection?: string,
  ): Promise<void> {
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      this.logger.warn(`[RealTrading] onTradeClose: invalid exitPrice ${exitPrice} for ${symbol} user ${telegramId}`);
      return;
    }
    // Match by direction to prevent hedge close event from closing main trade (and vice versa)
    const dirFilter = closedDirection ? { direction: closedDirection } : {};
    let trade = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN", ...dirFilter });
    if (!trade) {
      trade = await this.userTradeModel.findOne({
        telegramId, symbol, status: "CLOSED", ...dirFilter,
        pnlUsdt: { $in: [null, undefined, 0] },
        closedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
      });
      if (!trade) return;
    }

    // Use gridAvgEntry for DCA trades; calculate USDT directly from quantity for precision
    const entryRef = (trade as any).gridAvgEntry || trade.entryPrice;
    const rawPnlPct =
      trade.direction === "LONG"
        ? ((exitPrice - entryRef) / entryRef) * 100
        : ((entryRef - exitPrice) / entryRef) * 100;
    const pnlPct = rawPnlPct - BINANCE_FEE_PCT; // deduct trading fees
    const rawPnlUsdt = trade.direction === "LONG"
      ? (exitPrice - entryRef) * trade.quantity
      : (entryRef - exitPrice) * trade.quantity;
    const pnlUsdt = rawPnlUsdt - (BINANCE_FEE_PCT / 100) * entryRef * trade.quantity;

    // Atomic: only update if still OPEN (prevents duplicate notification if protectOpenTrades already closed it)
    const updated = await this.userTradeModel.findOneAndUpdate(
      { _id: (trade as any)._id, status: "OPEN" },
      { $set: { status: "CLOSED", closeReason: reason, exitPrice, pnlPercent: pnlPct, pnlUsdt, closedAt: new Date() } },
      { new: true },
    );
    if (!updated) {
      // Already closed by another handler — just update PnL if missing
      await this.userTradeModel.updateOne(
        { _id: (trade as any)._id, pnlUsdt: { $in: [null, 0] } },
        { $set: { exitPrice, pnlPercent: pnlPct, pnlUsdt, closeReason: reason } },
      );
      return; // Don't send duplicate notification
    }

    // Cancel remaining algo orders (orphan prevention: when SL fires → cancel TP, when TP fires → cancel SL)
    const tradeKeys = await this.userSettingsService.getApiKeys(telegramId, "binance");
    if (tradeKeys?.apiKey) {
      if ((trade as any).binanceSlAlgoId) {
        await this.binanceService.cancelAlgoOrder(tradeKeys.apiKey, tradeKeys.apiSecret, (trade as any).binanceSlAlgoId).catch(() => {});
      }
      if ((trade as any).binanceTpAlgoId) {
        await this.binanceService.cancelAlgoOrder(tradeKeys.apiKey, tradeKeys.apiSecret, (trade as any).binanceTpAlgoId).catch(() => {});
      }
    }

    // Accumulate cumulative PnL on user subscription
    await this.subscriptionService.incrementTradePnl(trade.telegramId, pnlUsdt);

    // Post-TP cooldown: if all positions closed via TP, wait 1h before new cycle
    if (reason === "TAKE_PROFIT") {
      const remaining = await this.userTradeModel.countDocuments({ telegramId, status: "OPEN" });
      if (remaining === 0) {
        const cooldownSecs = 60 * 60; // 1 hour
        await this.redisService.set(TP_CYCLE_COOLDOWN_KEY(telegramId), { startedAt: new Date().toISOString() }, cooldownSecs);
        this.logger.log(`[RealTrading] User ${telegramId} — all positions closed via TP. 1h cooldown started.`);
      }
    }

    const sign = pnlPct >= 0 ? "+" : "";
    const emoji = pnlPct >= 0 ? "✅" : "❌";
    const reasonVi =
      reason === "TAKE_PROFIT" ? "Take Profit" :
      reason === "STOP_LOSS" ? "Stop Loss" : "Dong viet";
    const fmtP = (p: number) =>
      p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
      p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
    const msg =
      `${emoji} *Real Mode: Lenh Da Dong*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${symbol} ${trade.direction}\n` +
      `Gia vao: ${fmtP(trade.entryPrice)}\n` +
      `Gia ra: ${fmtP(exitPrice)}\n` +
      `PnL: *${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsdt.toFixed(2)} USDT)*\n` +
      `Ly do: ${reasonVi}`;
    await this.telegramService.sendTelegramMessage(trade.chatId, msg).catch(() => {});

    this.logger.log(
      `[RealTrading] Trade closed: user ${telegramId} ${symbol} ${trade.direction} @ ${exitPrice} — ${reason} — PnL: ${sign}${pnlPct.toFixed(2)}%`,
    );
  }

  // ─── Query helpers ────────────────────────────────────────────────────────

  /** Get OPEN trades for a user. */
  async getOpenTrades(telegramId: number): Promise<UserTradeDocument[]> {
    return this.userTradeModel.find({ telegramId, status: "OPEN" }).lean() as any;
  }

  /** Delete all user trade records (admin full reset). */
  async deleteAllTrades(): Promise<number> {
    const result = await this.userTradeModel.deleteMany({});
    return result.deletedCount;
  }

  /**
   * Close a single real trade by symbol for a user.
   * Cancels existing SL/TP algo orders and places a market-close order on Binance.
   */
  async closeRealPosition(
    telegramId: number,
    chatId: number,
    symbol: string,
    reason: string,
  ): Promise<{ success: boolean; pnlPct?: number }> {
    // Find main trade (not hedge) — hedge has its own close flow via onHedgeEvent
    const trade = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN", isHedge: { $ne: true } }).lean();
    if (!trade) return { success: false };

    // Grace period for synced trades: prevent sim from immediately closing a position
    // that was manually synced from Binance (sim entry ≠ real entry, stale TP/SL).
    // User-initiated closes (ADMIN_CLOSE, MANUAL, CYCLE_TARGET, DAILY_STOP) are always allowed.
    if ((trade as any).syncedFromBinance) {
      const syncAgeMs = Date.now() - new Date((trade as any).createdAt).getTime();
      const SYNC_GRACE_MS = 60 * 60 * 1000; // 60 minutes
      const userInitiated = ['ADMIN_CLOSE', 'MANUAL', 'CYCLE_TARGET', 'DAILY_STOP', 'ADMIN_RESET'].includes(reason);
      if (!userInitiated && syncAgeMs < SYNC_GRACE_MS) {
        this.logger.warn(
          `[RealTrading] closeRealPosition: SKIPPED ${symbol} for user ${telegramId} — synced trade protected for ${Math.round((SYNC_GRACE_MS - syncAgeMs) / 60000)}m (reason: ${reason})`,
        );
        return { success: false };
      }
    }

    const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
    if (!keys?.apiKey) return { success: false };

    try {
      // Check for open hedge — if main is closing via TP and hedge exists, FLIP instead of closing both
      const openHedge = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN", isHedge: true });
      if (openHedge) {
        const isMainTp = reason === "TAKE_PROFIT" || reason === "TRAIL_STOP";
        if (isMainTp) {
          // FLIP: close main on Binance, promote hedge to new main in DB
          // Hedge position stays open on Binance — it becomes the new main trade
          const exitPrice = await this.marketDataService.getPrice(symbol) || trade.entryPrice;
          const entryRef = (trade as any).gridAvgEntry || trade.entryPrice;
          const mainPnlPct = trade.direction === "LONG"
            ? ((exitPrice - entryRef) / entryRef) * 100
            : ((entryRef - exitPrice) / entryRef) * 100;
          const mainPnlUsdt = (mainPnlPct / 100) * trade.notionalUsdt;

          // Close main position on Binance
          await this.binanceService.closePosition(keys.apiKey, keys.apiSecret, symbol, trade.quantity, trade.direction).catch(() => {});

          // Cancel main SL/TP algo orders
          if (trade.binanceSlAlgoId) await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
          if (trade.binanceTpAlgoId) await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});

          // Mark main as CLOSED with TP profit
          await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
            status: "CLOSED", closeReason: reason, exitPrice,
            pnlPercent: Math.round(mainPnlPct * 100) / 100,
            pnlUsdt: Math.round(mainPnlUsdt * 100) / 100,
            closedAt: new Date(),
          });

          // Promote hedge to new main (FLIP)
          const hedgeSl = openHedge.direction === "LONG"
            ? +(openHedge.entryPrice * 0.60).toFixed(8)
            : +(openHedge.entryPrice * 1.40).toFixed(8);
          const hedgeTp = openHedge.direction === "LONG"
            ? +(openHedge.entryPrice * 1.035).toFixed(8)
            : +(openHedge.entryPrice * 0.965).toFixed(8);
          await this.userTradeModel.findByIdAndUpdate(openHedge._id, {
            isHedge: false, parentTradeId: null,
            slPrice: hedgeSl, tpPrice: hedgeTp,
          });

          // Place SL/TP on Binance for the new main (ex-hedge)
          const pp = await this.getPricePrecision(symbol);
          const slOrder = await this.binanceService.setStopLoss(
            keys.apiKey, keys.apiSecret, symbol,
            parseFloat(hedgeSl.toFixed(pp)), openHedge.direction as 'LONG' | 'SHORT', openHedge.quantity,
          ).catch(() => null);
          const tpOrder = await this.binanceService.setTakeProfitAtPrice(
            keys.apiKey, keys.apiSecret, symbol,
            parseFloat(hedgeTp.toFixed(pp)), openHedge.direction as 'LONG' | 'SHORT', openHedge.quantity,
          ).catch(() => null);
          if (slOrder) {
            const slId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
            await this.userTradeModel.updateOne({ _id: openHedge._id }, { $set: { binanceSlAlgoId: slId } });
          }
          if (tpOrder) {
            const tpId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
            await this.userTradeModel.updateOne({ _id: openHedge._id }, { $set: { binanceTpAlgoId: tpId } });
          }

          this.logger.log(
            `[RealTrading] FLIP ${symbol}: main ${trade.direction} TP +$${mainPnlUsdt.toFixed(2)} → hedge ${openHedge.direction} promoted to main (SL=${hedgeSl} TP=${hedgeTp})`,
          );

          // Notify user
          const sign = mainPnlPct >= 0 ? "+" : "";
          const fmtP = (p: number) => p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
          await this.telegramService.sendTelegramMessage(chatId,
            `🔄 *Real Mode: FLIP*\n━━━━━━━━━━━━━━━━━━\n\n` +
            `${symbol} ${trade.direction} TP → ${sign}${mainPnlPct.toFixed(2)}% (${sign}$${mainPnlUsdt.toFixed(2)})\n` +
            `Chuyen sang: *${openHedge.direction}* @ ${fmtP(openHedge.entryPrice)}\n` +
            `SL: ${fmtP(hedgeSl)} | TP: ${fmtP(hedgeTp)}\n\n` +
            `_Vi the hedge duoc giu lai lam lenh chinh moi._`
          ).catch(() => {});

          return { success: true, pnlPct: mainPnlPct };
        }

        // Non-TP close (SL, MANUAL, etc.) — close hedge first, then main
        await this.binanceService.closePosition(keys.apiKey, keys.apiSecret, symbol, openHedge.quantity, openHedge.direction).catch(() => {});
        const hExit = await this.marketDataService.getPrice(symbol) || 0;
        const hPnl = openHedge.direction === "LONG"
          ? ((hExit - openHedge.entryPrice) / openHedge.entryPrice) * 100
          : ((openHedge.entryPrice - hExit) / openHedge.entryPrice) * 100;
        await this.userTradeModel.findByIdAndUpdate(openHedge._id, {
          status: "CLOSED", exitPrice: hExit, pnlPercent: Math.round(hPnl * 100) / 100,
          pnlUsdt: Math.round((hPnl / 100) * openHedge.notionalUsdt * 100) / 100,
          closeReason: "MAIN_CLOSED", closedAt: new Date(),
        });
        this.logger.log(`[RealTrading] Closed hedge ${symbol} ${openHedge.direction} for user ${telegramId} before main close (${reason})`);
      }

      if (trade.binanceSlAlgoId) {
        await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
      }
      if (trade.binanceTpAlgoId) {
        await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});
      }

      const closeOrder = await this.binanceService.closePosition(
        keys.apiKey, keys.apiSecret, symbol, trade.quantity, trade.direction,
      );
      const exitPrice = parseFloat(closeOrder.avgPrice) || (await this.marketDataService.getPrice(symbol)) || trade.entryPrice;

      const entryRef2 = (trade as any).gridAvgEntry || trade.entryPrice;
      const rawPnlPct = trade.direction === "LONG"
        ? ((exitPrice - entryRef2) / entryRef2) * 100
        : ((entryRef2 - exitPrice) / entryRef2) * 100;
      const pnlPct = rawPnlPct - BINANCE_FEE_PCT;
      const rawPnlUsdt2 = trade.direction === "LONG"
        ? (exitPrice - entryRef2) * trade.quantity
        : (entryRef2 - exitPrice) * trade.quantity;
      const pnlUsdt = rawPnlUsdt2 - (BINANCE_FEE_PCT / 100) * entryRef2 * trade.quantity;

      await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
        status: "CLOSED",
        closeReason: reason,
        exitPrice,
        pnlPercent: pnlPct,
        pnlUsdt,
        closedAt: new Date(),
      });

      await this.subscriptionService.incrementTradePnl(telegramId, pnlUsdt);

      // Notify user about the close
      const sign = pnlPct >= 0 ? "+" : "";
      const emoji = pnlPct >= 0 ? "✅" : "❌";
      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
      const msg =
        `${emoji} *Real Mode: Lenh Da Dong*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${symbol} ${trade.direction}\n` +
        `Entry: *${fmtP(entryRef2)}*\n` +
        `Exit: *${fmtP(exitPrice)}*\n` +
        `PnL: *${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsdt.toFixed(2)} USDT)*\n\n` +
        `_${reason}_`;
      await this.telegramService.sendTelegramMessage(chatId, msg).catch(() => {});

      // Resolve the associated signal so it doesn't stay ACTIVE in app
      const closeR = pnlPct >= 0 ? "TAKE_PROFIT" : "STOP_LOSS";
      await this.signalQueueService.resolveActiveSignal(symbol, exitPrice, closeR as any).catch(e =>
        this.logger.warn(`[RealTrading] ${symbol}: failed to resolve signal on close: ${e?.message}`),
      );

      this.logger.log(
        `[RealTrading] closeRealPosition: ${symbol} ${trade.direction} @ ${exitPrice} for user ${telegramId} (${reason})`,
      );
      return { success: true, pnlPct };
    } catch (err) {
      this.logger.error(`[RealTrading] closeRealPosition error ${symbol} for user ${telegramId}: ${err?.message}`);
      return { success: false };
    }
  }

  // ─── Daily stats + close-all ───────────────────────────────────────────────

  /**
   * Compute today's trading stats for a user.
   * @param sinceDate — if provided, only count closed trades after this date (for TP cycle reset).
   *                     If null, counts all closed trades since start of UTC day.
   * Returns open trades with unrealized PnL and closed trades since start of day (or sinceDate).
   */
  async getDailyStats(telegramId: number, sinceDate?: Date): Promise<{
    openTrades: Array<{
      symbol: string; direction: string; entryPrice: number;
      quantity: number; leverage: number; notionalUsdt: number;
      unrealizedPnlPct: number; unrealizedPnlUsdt: number; openedAt: Date;
    }>;
    closedToday: Array<{
      symbol: string; direction: string; closeReason?: string;
      pnlPercent: number; pnlUsdt: number; closedAt?: Date;
    }>;
    totalPnlUsdt: number;
    totalNotionalUsdt: number;
    dailyPnlPct: number;
    allTime: { wins: number; losses: number; total: number; pnlUsdt: number };
  }> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    // For PnL limit checks: use sinceDate (last TP hit) if it's today, otherwise start of day
    const pnlSince = sinceDate && sinceDate > startOfToday ? sinceDate : startOfToday;

    const [openDocs, closedDocs, allTimeAgg] = await Promise.all([
      this.userTradeModel.find({ telegramId, status: "OPEN" }).lean(),
      this.userTradeModel.find({
        telegramId, status: "CLOSED",
        closedAt: { $gte: pnlSince },
      }).lean(),
      this.userTradeModel.aggregate([
        { $match: { telegramId, status: "CLOSED" } },
        { $group: {
          _id: null,
          pnlUsdt: { $sum: "$pnlUsdt" },
          total: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gte: ["$pnlUsdt", 0] }, 1, 0] } },
        }},
      ]),
    ]);

    // Use in-memory prices (already subscribed via position monitor)
    const openTrades = openDocs.map((t) => {
      const currentPrice = this.marketDataService.getLatestPrice(t.symbol) ?? t.entryPrice;
      const rawPnlPct = t.direction === "LONG"
        ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
        : ((t.entryPrice - currentPrice) / t.entryPrice) * 100;
      const unrealizedPnlPct = rawPnlPct - BINANCE_FEE_PCT; // deduct estimated fees
      const unrealizedPnlUsdt = (unrealizedPnlPct / 100) * t.notionalUsdt;
      return {
        symbol: t.symbol, direction: t.direction,
        entryPrice: t.entryPrice, quantity: t.quantity, leverage: t.leverage,
        notionalUsdt: t.notionalUsdt,
        unrealizedPnlPct, unrealizedPnlUsdt,
        openedAt: t.openedAt,
      };
    });

    const closedToday = closedDocs.map((t) => ({
      symbol: t.symbol, direction: t.direction, closeReason: t.closeReason,
      pnlPercent: t.pnlPercent ?? 0, pnlUsdt: t.pnlUsdt ?? 0,
      closedAt: t.closedAt,
    }));

    const totalPnlUsdt =
      openTrades.reduce((s, t) => s + t.unrealizedPnlUsdt, 0) +
      closedToday.reduce((s, t) => s + t.pnlUsdt, 0);

    const totalNotionalUsdt =
      openTrades.reduce((s, t) => s + t.notionalUsdt, 0) +
      closedDocs.reduce((s, t) => s + t.notionalUsdt, 0);

    const dailyPnlPct = totalNotionalUsdt > 0 ? (totalPnlUsdt / totalNotionalUsdt) * 100 : 0;

    const agg = allTimeAgg[0] || { wins: 0, total: 0, pnlUsdt: 0 };
    const allTime = { wins: agg.wins, losses: agg.total - agg.wins, total: agg.total, pnlUsdt: agg.pnlUsdt ?? 0 };

    return { openTrades, closedToday, totalPnlUsdt, totalNotionalUsdt, dailyPnlPct, allTime };
  }

  /**
   * Reset cycle for a user: clear MongoDB cycle fields + Redis TP cooldown.
   * Called when user re-enables real mode (/ai on).
   */
  async resetCycleForUser(telegramId: number): Promise<void> {
    // Set to now (not null) so frontend shows new cycle start time; peak/paused reset to 0/false
    await this.subscriptionService.setCycleResetAt(telegramId, new Date());
    await this.redisService.delete(TP_CYCLE_COOLDOWN_KEY(telegramId));
    this.logger.log(`[RealTrading] User ${telegramId} — cycle reset on /ai on`);
  }

  /**
   * Compute cycle stats: all trades since cycleResetAt (or all open + today's closed if no cycle set).
   */
  async getCycleStats(telegramId: number, cycleResetAt?: Date): Promise<{
    openTrades: Array<{
      symbol: string; direction: string; entryPrice: number;
      quantity: number; leverage: number; notionalUsdt: number;
      unrealizedPnlPct: number; unrealizedPnlUsdt: number; openedAt: Date;
    }>;
    closedInCycle: Array<{
      symbol: string; direction: string; closeReason?: string;
      pnlPercent: number; pnlUsdt: number; closedAt?: Date;
    }>;
    totalPnlUsdt: number;
    totalNotionalUsdt: number;
  }> {
    // If no cycle start set, use start of today as fallback
    const fallback = new Date();
    fallback.setUTCHours(0, 0, 0, 0);
    const since = cycleResetAt ?? fallback;

    const [openDocs, closedDocs] = await Promise.all([
      this.userTradeModel.find({ telegramId, status: "OPEN" }).lean(),
      this.userTradeModel.find({
        telegramId, status: "CLOSED",
        closedAt: { $gte: since },
      }).lean(),
    ]);

    const openTrades = openDocs.map((t) => {
      const currentPrice = this.marketDataService.getLatestPrice(t.symbol) ?? t.entryPrice;
      const rawPnlPct = t.direction === "LONG"
        ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
        : ((t.entryPrice - currentPrice) / t.entryPrice) * 100;
      const unrealizedPnlPct = rawPnlPct - BINANCE_FEE_PCT; // deduct estimated fees
      const unrealizedPnlUsdt = (unrealizedPnlPct / 100) * t.notionalUsdt;
      return {
        symbol: t.symbol, direction: t.direction,
        entryPrice: t.entryPrice, quantity: t.quantity, leverage: t.leverage,
        notionalUsdt: t.notionalUsdt,
        unrealizedPnlPct, unrealizedPnlUsdt,
        openedAt: t.openedAt,
      };
    });

    const closedInCycle = closedDocs.map((t) => ({
      symbol: t.symbol, direction: t.direction, closeReason: t.closeReason,
      pnlPercent: t.pnlPercent ?? 0, pnlUsdt: t.pnlUsdt ?? 0,
      closedAt: t.closedAt,
    }));

    const totalPnlUsdt =
      openTrades.reduce((s, t) => s + t.unrealizedPnlUsdt, 0) +
      closedInCycle.reduce((s, t) => s + t.pnlUsdt, 0);

    const totalNotionalUsdt =
      openTrades.reduce((s, t) => s + t.notionalUsdt, 0) +
      closedDocs.reduce((s, t) => s + t.notionalUsdt, 0);

    return { openTrades, closedInCycle, totalPnlUsdt, totalNotionalUsdt };
  }

  /** Recent closed trades for a user (for /ai my history). */
  async getRecentTrades(telegramId: number, limit = 10): Promise<Array<{
    symbol: string; direction: string; closeReason?: string;
    pnlUsdt: number; pnlPercent: number; closedAt?: Date;
  }>> {
    const docs = await this.userTradeModel.find({
      telegramId, status: "CLOSED",
    }).sort({ closedAt: -1 }).limit(limit).lean();
    return docs.map((t) => ({
      symbol: t.symbol, direction: t.direction,
      closeReason: t.closeReason,
      pnlUsdt: t.pnlUsdt ?? 0, pnlPercent: t.pnlPercent ?? 0,
      closedAt: t.closedAt,
    }));
  }

  /**
   * Compute PnL ranking across all real-mode users.
   * Today: closed trades since UTC midnight + unrealized from open positions.
   * All-time: cumulative closed trades only.
   */
  async getAllUsersRanking(): Promise<{
    today: Array<{ telegramId: number; username?: string; pnlUsdt: number; wins: number; total: number; }>;
    allTime: Array<{ telegramId: number; username?: string; pnlUsdt: number; wins: number; total: number; }>;
  }> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const realModeUsers = await this.subscriptionService.findRealModeSubscribers();
    const usernameMap = new Map(realModeUsers.map(u => [u.telegramId, u.username]));
    const realModeIds = new Set(realModeUsers.map(u => u.telegramId));

    const [allTimeAgg, todayAgg, openTrades] = await Promise.all([
      this.userTradeModel.aggregate([
        { $match: { status: "CLOSED" } },
        { $group: {
          _id: "$telegramId",
          pnlUsdt: { $sum: "$pnlUsdt" },
          total: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gte: ["$pnlUsdt", 0] }, 1, 0] } },
        }},
        { $sort: { pnlUsdt: -1 } },
      ]),
      this.userTradeModel.aggregate([
        { $match: { status: "CLOSED", closedAt: { $gte: startOfToday } } },
        { $group: {
          _id: "$telegramId",
          pnlUsdt: { $sum: "$pnlUsdt" },
          total: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gte: ["$pnlUsdt", 0] }, 1, 0] } },
        }},
      ]),
      this.userTradeModel.find({ status: "OPEN" }).lean(),
    ]);

    // Build today map starting from closed trades
    const todayMap = new Map<number, { pnlUsdt: number; wins: number; total: number }>();
    for (const row of todayAgg) {
      todayMap.set(row._id, { pnlUsdt: row.pnlUsdt, wins: row.wins, total: row.total });
    }

    // Add unrealized PnL from currently open positions
    for (const trade of openTrades) {
      const currentPrice = this.marketDataService.getLatestPrice(trade.symbol);
      if (!currentPrice) continue;
      const pnlFraction = trade.direction === "LONG"
        ? (currentPrice - trade.entryPrice) / trade.entryPrice
        : (trade.entryPrice - currentPrice) / trade.entryPrice;
      const unrealizedUsdt = pnlFraction * trade.notionalUsdt;
      const existing = todayMap.get(trade.telegramId) ?? { pnlUsdt: 0, wins: 0, total: 0 };
      existing.pnlUsdt += unrealizedUsdt;
      todayMap.set(trade.telegramId, existing);
    }

    const today = Array.from(todayMap.entries())
      .filter(([id]) => realModeIds.has(id))
      .map(([telegramId, data]) => ({ telegramId, username: usernameMap.get(telegramId), ...data }))
      .sort((a, b) => b.pnlUsdt - a.pnlUsdt);

    const allTime = allTimeAgg
      .filter(row => realModeIds.has(row._id))
      .map(row => ({
        telegramId: row._id,
        username: usernameMap.get(row._id),
        pnlUsdt: row.pnlUsdt,
        wins: row.wins,
        total: row.total,
      }));

    return { today, allTime };
  }

  /**
   * Cancel all SL/TP algo orders and market-close all open positions for a user.
   * Used when daily target or daily stop loss is triggered.
   * Returns the number of positions closed.
   */
  async closeAllRealPositions(telegramId: number, chatId: number, reason: string): Promise<number> {
    const openTrades = await this.userTradeModel.find({ telegramId, status: "OPEN" }).lean();
    if (openTrades.length === 0) return 0;

    const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
    if (!keys?.apiKey) return 0;

    let closed = 0;
    for (const trade of openTrades) {
      try {
        closed += await this.closeSinglePosition(keys, trade, reason, telegramId);
      } catch (err) {
        this.logger.error(
          `[RealTrading] closeAllRealPositions error ${trade.symbol} for user ${telegramId}: ${err?.message}`,
        );
      }
    }
    return closed;
  }

  /**
   * Close only losing positions (PnL < threshold).
   * Profitable positions keep running with their SL/TP intact.
   * Returns count of closed positions.
   */
  private async closeSinglePosition(keys: any, trade: any, reason: string, telegramId: number): Promise<number> {
    if (trade.binanceSlAlgoId) {
      await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
    }
    if (trade.binanceTpAlgoId) {
      await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});
    }
    const closeOrder = await this.binanceService.closePosition(
      keys.apiKey, keys.apiSecret, trade.symbol, trade.quantity, trade.direction,
    );
    const exitPrice = parseFloat(closeOrder.avgPrice) || (await this.marketDataService.getPrice(trade.symbol)) || trade.entryPrice;
    const entryRef = (trade as any).gridAvgEntry || trade.entryPrice;
    const rawPnlPct = trade.direction === "LONG"
      ? ((exitPrice - entryRef) / entryRef) * 100
      : ((entryRef - exitPrice) / entryRef) * 100;
    const pnlPct = rawPnlPct - BINANCE_FEE_PCT;
    const pnlUsdt = (trade.direction === "LONG" ? (exitPrice - entryRef) : (entryRef - exitPrice)) * trade.quantity
      - (BINANCE_FEE_PCT / 100) * entryRef * trade.quantity;
    await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
      status: "CLOSED", closeReason: reason, exitPrice, pnlPercent: pnlPct, pnlUsdt, closedAt: new Date(),
    });
    await this.subscriptionService.incrementTradePnl(telegramId, pnlUsdt);
    this.logger.log(`[RealTrading] closeSinglePosition: ${trade.symbol} ${trade.direction} @ ${exitPrice} pnl=${pnlPct.toFixed(2)}% (${reason})`);
    return 1;
  }

  // Cycle PnL management REMOVED — user manages their own targets

  /**
   * Get daily limit history for a user (last N events).
   */
  async getDailyLimitHistory(telegramId: number, limit = 20): Promise<any[]> {
    return this.dailyLimitHistoryModel
      .find({ telegramId })
      .sort({ triggeredAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get daily limit history for all users (admin view, last N events).
   */
  async getAllDailyLimitHistory(limit = 50): Promise<any[]> {
    return this.dailyLimitHistoryModel
      .find()
      .sort({ triggeredAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Every 2 minutes: scan all OPEN trades and ensure each has a live SL and TP on Binance.
   * If SL or TP is missing (failed at placement or silently dropped), place it immediately.
   * This protects clients from unprotected open positions.
   * Note: trailing SL is handled real-time by PositionMonitorService — this is a safety net only.
   */
  @Cron("0 */1 * * * *")
  async protectOpenTrades(): Promise<void> {
    try {
      const openTrades = await this.userTradeModel.find({ status: "OPEN" }).exec();

      // Always check real mode users — even if DB has no OPEN trades,
      // Binance may have orphan positions (e.g., after DB clean) that need TP/SL protection.
      const realModeSubs = await this.subscriptionService.findRealModeSubscribers();

      // Group DB trades by user
      const byUser = new Map<number, typeof openTrades>();
      for (const trade of openTrades) {
        if (!byUser.has(trade.telegramId)) byUser.set(trade.telegramId, []);
        byUser.get(trade.telegramId)!.push(trade);
      }
      // Ensure all real mode users are in the map (even if they have no DB trades)
      for (const sub of realModeSubs) {
        if (!byUser.has(sub.telegramId)) byUser.set(sub.telegramId, []);
      }

      for (const [telegramId, trades] of byUser) {
        try {
          const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
          if (!keys?.apiKey) continue;

          // Fetch user subscription for custom TP/SL settings
          const sub = await this.subscriptionService.getSubscription(telegramId);

          // One call to get all open algo orders for this user
          // Returns null when API fails — MUST skip SL/TP check to prevent spam
          const algoMap = await this.binanceService.getOpenAlgoOrders(keys.apiKey, keys.apiSecret);
          if (algoMap === null) {
            this.logger.warn(`[RealTrading] protectOpenTrades: getOpenAlgoOrders failed for user ${telegramId} — skipping SL/TP check`);
            continue; // Skip this user entirely
          }

          const ppCache = new Map<string, number>();
          const getPP = async (sym: string) => {
            if (!ppCache.has(sym)) ppCache.set(sym, await this.getPricePrecision(sym));
            return ppCache.get(sym)!;
          };

          // Fetch actual open positions on Binance to verify trades are still open
          // IMPORTANT: if API call fails, skip position check entirely (don't assume all closed)
          let binancePositions;
          try {
            binancePositions = await this.binanceService.getOpenPositions(keys.apiKey, keys.apiSecret);
          } catch (err) {
            this.logger.warn(`[RealTrading] protectOpenTrades: getOpenPositions failed for user ${telegramId}, skipping position check: ${err?.message}`);
            continue; // Skip this user entirely — don't falsely close trades
          }
          // Match by symbol+direction (not just symbol) — Hedge mode has separate LONG/SHORT positions
          // A LONG position closing doesn't mean SHORT is also closed
          const openPositionKeys = new Set(binancePositions.map((p) => `${p.symbol}:${p.side}`));

          for (const trade of trades) {
            const { symbol, direction, slPrice, tpPrice, chatId } = trade;

            // Position already closed on Binance — mark trade as closed with PnL
            if (!openPositionKeys.has(`${symbol}:${direction}`)) {
              // Try to get actual fill price from Binance trade history, fallback to WebSocket
              let exitPrice = await this.binanceService.getLastFillPrice(keys.apiKey, keys.apiSecret, symbol)
                || this.marketDataService.getLatestPrice(symbol);
              let pnlPct = 0;
              let pnlUsdt = 0;
              if (exitPrice && trade.entryPrice) {
                const entryRef4 = (trade as any).gridAvgEntry || trade.entryPrice;
                const rawPct = direction === "LONG"
                  ? ((exitPrice - entryRef4) / entryRef4) * 100
                  : ((entryRef4 - exitPrice) / entryRef4) * 100;
                pnlPct = rawPct - BINANCE_FEE_PCT;
                const rawPnlUsdt4 = direction === "LONG"
                  ? (exitPrice - entryRef4) * trade.quantity
                  : (entryRef4 - exitPrice) * trade.quantity;
                pnlUsdt = rawPnlUsdt4 - (BINANCE_FEE_PCT / 100) * entryRef4 * trade.quantity;
              }

              // Atomic: only close if still OPEN (prevents duplicate notification with onTradeClose)
              const updated = await this.userTradeModel.findOneAndUpdate(
                { _id: (trade as any)._id, status: "OPEN" },
                { $set: {
                  status: "CLOSED",
                  closeReason: "BINANCE_CLOSED",
                  closedAt: new Date(),
                  ...(exitPrice ? { exitPrice, pnlPercent: pnlPct, pnlUsdt } : {}),
                } },
                { new: true },
              );
              if (!updated) continue; // Already closed by onTradeClose — skip notification

              // Cancel remaining algo orders (orphan prevention)
              if ((trade as any).binanceSlAlgoId) {
                await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, (trade as any).binanceSlAlgoId).catch(() => {});
              }
              if ((trade as any).binanceTpAlgoId) {
                await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, (trade as any).binanceTpAlgoId).catch(() => {});
              }

              this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: position gone on Binance — marking CLOSED (PnL: ${pnlPct.toFixed(2)}%)`);

              // Resolve the associated signal so it doesn't stay ACTIVE in app
              if (exitPrice) {
                const closeReason = pnlPct >= 0 ? "TAKE_PROFIT" : "STOP_LOSS";
                await this.signalQueueService.resolveActiveSignal(symbol, exitPrice, closeReason as any).catch(err =>
                  this.logger.warn(`[RealTrading] ${symbol}: failed to resolve signal: ${err?.message}`),
                );
              }

              // Notify user
              if (exitPrice) {
                const sign = pnlPct >= 0 ? "+" : "";
                const emoji = pnlPct >= 0 ? "✅" : "❌";
                const entryDisplay = (trade as any).gridAvgEntry || trade.entryPrice;
                const fmtPn = (p: number) =>
                  p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
                  p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
                await this.telegramService.sendTelegramMessage(chatId,
                  `${emoji} *Real Mode: Lenh Da Dong*\n━━━━━━━━━━━━━━━━━━\n\n${symbol} ${direction}\nEntry: *${fmtPn(entryDisplay)}*\nExit: *${fmtPn(exitPrice)}*\nPnL: *${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsdt.toFixed(2)} USDT)*\n_Vi the da dong tren Binance_`
                ).catch(() => {});
              }
              continue;
            }

            const algo = algoMap.get(symbol);
            const fmtP = (p: number) =>
              p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
              p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
            const pp = await getPP(symbol);
            const round = (p: number) => parseFloat(p.toFixed(pp));

            // ── Cleanup duplicate SL/TP orders on Binance ─────────────────
            // If multiple SL or TP orders exist for same symbol, cancel extras (keep DB-tracked one)
            if (algo && (algo.slCount > 1 || algo.tpCount > 1)) {
              const dbSlId = (trade as any).binanceSlAlgoId;
              const dbTpId = (trade as any).binanceTpAlgoId;
              if (algo.slCount > 1) {
                const extraSls = algo.allSlIds.filter(id => id !== dbSlId);
                for (const id of extraSls) {
                  await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, id).catch(() => {});
                }
                this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: cleaned ${extraSls.length} duplicate SL orders (kept ${dbSlId})`);
              }
              if (algo.tpCount > 1) {
                const extraTps = algo.allTpIds.filter(id => id !== dbTpId);
                for (const id of extraTps) {
                  await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, id).catch(() => {});
                }
                this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: cleaned ${extraTps.length} duplicate TP orders (kept ${dbTpId})`);
              }
            }

            // ── Time-based stop for real trades: 24h+ stagnant → close ─────
            // Must match ai-signal.service.ts time-stop. Only close if truly flat (±0.5%).
            const tradeAgeMs = Date.now() - new Date((trade as any).createdAt).getTime();
            const tradeAgeH = tradeAgeMs / 3600000;
            const currentPrice = this.marketDataService.getLatestPrice(symbol);
            if (currentPrice && trade.entryPrice && tradeAgeH >= 24) {
              const currentPnl = direction === "LONG"
                ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
                : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;
              if (currentPnl < 0.5 && currentPnl > -0.5) {
                const reason = `Time-stop ${currentPnl >= 0 ? "+" : ""}${currentPnl.toFixed(2)}% after ${tradeAgeH.toFixed(0)}h`;
                this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: ${reason}`);
                await this.closeRealPosition(telegramId, chatId, symbol, reason).catch(() => {});
                continue;
              }
            }

            // ── Trailing stop for real trades ─────────────────────────────
            // Mirrors position-monitor logic: TRAIL_TRIGGER=2.0%, keep 60% of peak
            // Runs every 2min as safety net + primary trailing for trades whose signal is no longer watched
            if (currentPrice && trade.entryPrice && slPrice) {
              const tcfg = this.tradingConfig.get();
              const TRAIL_TRIGGER = tcfg.trailTrigger ?? 2.0;
              const TRAIL_KEEP_RATIO = tcfg.trailKeepRatio ?? 0.75;
              // Use grid avg entry if available
              const entry = (trade as any).gridAvgEntry || trade.entryPrice;
              const currentPnlPct = direction === "LONG"
                ? ((currentPrice - entry) / entry) * 100
                : ((entry - currentPrice) / entry) * 100;

              // TP proximity lock: if within 0.5% of TP → freeze trail, let TP execute
              const tpPrice = trade.tpPrice;
              const distanceToTp = tpPrice
                ? (direction === "LONG" ? (tpPrice - currentPrice) / currentPrice : (currentPrice - tpPrice) / currentPrice) * 100
                : Infinity;
              const nearTp = distanceToTp < 0.5;

              if (nearTp) {
                // Near TP: check if existing Binance SL order is dangerously tight
                // (trail may have tightened it to within 0.4% of current price)
                // If so, widen it back to break-even to give TP room to execute.
                const slDistanceFromPrice = slPrice
                  ? (direction === "LONG"
                    ? (currentPrice - slPrice) / currentPrice
                    : (slPrice - currentPrice) / currentPrice) * 100
                  : Infinity;

                const SL_TOO_TIGHT_THRESHOLD = 0.4; // SL within 0.4% of price = danger of premature fill
                if (slDistanceFromPrice < SL_TOO_TIGHT_THRESHOLD && trade.binanceSlAlgoId) {
                  // Widen SL back to break-even (entry price) — safe floor while TP is being hunted
                  const safeSlPrice = round(entry);
                  const isSafeSlBetter = direction === "LONG" ? safeSlPrice < slPrice : safeSlPrice > slPrice;
                  if (isSafeSlBetter) {
                    this.logger.log(
                      `[RealTrading] 🎯 ${symbol} user ${telegramId}: nearTP (${distanceToTp.toFixed(2)}% away) + SL too tight (${slDistanceFromPrice.toFixed(2)}% from price) → widen SL to breakeven ${fmtP(safeSlPrice)}`,
                    );
                    try {
                      await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId);
                      const tradeQty = trade.gridLevels?.length > 0
                        ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
                        : trade.quantity;
                      const slOrder = await this.binanceService.setStopLoss(
                        keys.apiKey, keys.apiSecret, symbol, safeSlPrice,
                        direction as "LONG" | "SHORT", tradeQty,
                      );
                      const newId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                      await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { slPrice: safeSlPrice, binanceSlAlgoId: newId } });
                    } catch (err) {
                      this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: nearTP SL widen failed: ${err?.message}`);
                    }
                  }
                } else {
                  this.logger.debug(`[RealTrading] ${symbol} user ${telegramId}: near TP (${distanceToTp.toFixed(2)}% away), SL ok (${slDistanceFromPrice.toFixed(2)}% from price) — trail frozen`);
                }
              } else if (currentPnlPct >= TRAIL_TRIGGER || (trade as any).peakPnlPct >= TRAIL_TRIGGER) {
                // ── Backend-managed trail with momentum hold ──
                // Instead of updating Binance SL: check if price has fallen below trail level
                // and if momentum has faded → close via market order

                // Track peak on trade record (survives signal close)
                const tradePeak = (trade as any).peakPnlPct || 0;
                const peak = Math.max(tradePeak, currentPnlPct);
                if (peak > tradePeak) {
                  await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { peakPnlPct: peak } }).catch(() => {});
                }

                const trailPct = peak * TRAIL_KEEP_RATIO;
                const trailSl = direction === "LONG"
                  ? entry * (1 + trailPct / 100)
                  : entry * (1 - trailPct / 100);

                // Use trade's own trail SL, fallback to signal if still active
                const signal = await this.signalQueueService.findActiveSignalBySymbol(symbol);
                const dbTrailSl = (trade as any).trailSlPrice || signal?.stopLossPrice || trailSl;

                // Check if price crossed below the DB trail SL level
                const trailBreached = direction === "LONG"
                  ? currentPrice <= dbTrailSl
                  : currentPrice >= dbTrailSl;

                if (trailBreached) {
                  // Trail SL level breached — check momentum before closing
                  // If coin is still moving in our favor (strong candle), HOLD
                  let momentumHold = false;
                  try {
                    const closes = await this.marketDataService.getClosePrices(symbol.replace("USDT", ""), "15m");
                    if (closes.length >= 3) {
                      const last = closes[closes.length - 1];
                      const prev = closes[closes.length - 2];
                      const candleGreen = last > prev;
                      // Get RSI to check if still in favorable zone
                      const { RSI } = require("technicalindicators");
                      const rsiVals = RSI.calculate({ period: 14, values: closes });
                      const rsi = rsiVals.length > 0 ? rsiVals[rsiVals.length - 1] : 50;

                      if (direction === "LONG" && candleGreen && rsi < 70) {
                        momentumHold = true; // Coin still pumping, hold
                      } else if (direction === "SHORT" && !candleGreen && rsi > 30) {
                        momentumHold = true; // Coin still dumping, hold
                      }
                    }
                  } catch {
                    // Fail-open: close if can't check momentum
                  }

                  if (momentumHold) {
                    // Coin still moving favorably → skip, let it run
                    this.logger.log(
                      `[RealTrading] ${symbol} user ${telegramId}: trail breached but HOLDING (momentum favorable, PnL: +${currentPnlPct.toFixed(1)}%)`,
                    );
                    // Reset breach counter — momentum is still active
                    await this.redisService.delete(`cache:trail-breach:${telegramId}:${symbol}`);
                  } else {
                    // Momentum faded — increment breach counter, close after 2 consecutive cycles (4min)
                    const breachKey = `cache:trail-breach:${telegramId}:${symbol}`;
                    const breachCount = parseInt(await this.redisService.get(breachKey) || "0", 10) + 1;
                    await this.redisService.set(breachKey, String(breachCount), 300); // 5min TTL

                    if (breachCount >= 2) {
                      // 2 consecutive cycles (4min) below trail + no momentum → close
                      this.logger.log(
                        `[RealTrading] ${symbol} user ${telegramId}: trail breached ${breachCount}x + no momentum → closing (peak=${peak.toFixed(1)}% PnL=${currentPnlPct.toFixed(1)}%)`,
                      );
                      await this.redisService.delete(breachKey);
                      await this.closeRealPosition(telegramId, chatId, symbol, "STOP_LOSS");
                    } else {
                      // First breach without momentum — wait 1 more cycle to confirm
                      this.logger.log(
                        `[RealTrading] ${symbol} user ${telegramId}: trail breached (${breachCount}/2), no momentum — waiting next cycle (PnL: +${currentPnlPct.toFixed(1)}%)`,
                      );
                    }
                  }
                  continue;
                } else {
                  // Trail not breached — place/update real SL on Binance at trail floor
                  const prevTrailSl = (trade as any).trailSlPrice || 0;
                  const trailSlMoved = Math.abs(trailSl - prevTrailSl) / (prevTrailSl || 1) > 0.002; // >0.2% change
                  if (trailSlMoved && trailSl > 0) {
                    // Cancel old SL and place new one at trail floor
                    const trailPP = await getPP(symbol);
                    const roundedTrailSl = parseFloat(trailSl.toFixed(trailPP));
                    try {
                      if ((trade as any).binanceSlAlgoId) {
                        await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, (trade as any).binanceSlAlgoId).catch(() => {});
                      }
                      const slQty = trade.gridLevels?.length > 0
                        ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
                        : trade.quantity;
                      const slOrder = await this.binanceService.setStopLoss(
                        keys.apiKey, keys.apiSecret, symbol, roundedTrailSl,
                        direction as "LONG" | "SHORT", slQty,
                      );
                      const newSlId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                      await this.userTradeModel.updateOne({ _id: trade._id }, {
                        $set: { trailSlPrice: trailSl, peakPnlPct: peak, slPrice: roundedTrailSl, binanceSlAlgoId: newSlId },
                      });
                      const trailLockPct = direction === "LONG"
                        ? ((roundedTrailSl - entry) / entry) * 100
                        : ((entry - roundedTrailSl) / entry) * 100;
                      this.logger.log(
                        `[RealTrading] ${symbol} user ${telegramId}: trail SL placed on Binance @ ${fmtP(roundedTrailSl)} (+${trailLockPct.toFixed(1)}%) peak=${peak.toFixed(1)}%`,
                      );
                    } catch (err) {
                      this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: trail SL place failed: ${err?.message}`);
                      // Still persist to DB for next retry
                      await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { trailSlPrice: trailSl, peakPnlPct: peak } }).catch(() => {});
                    }
                  } else if (trailSl !== prevTrailSl) {
                    await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { trailSlPrice: trailSl, peakPnlPct: peak } }).catch(() => {});
                  }
                }
              }
            }

            // ── SL missing ──────────────────────────────────────────────────
            // Skip if a grid DCA fill is in progress — cancel/replace window causes false-positive
            const gridReplacing = await this.isGridReplacing(telegramId, symbol);
            if (gridReplacing) {
              this.logger.debug(`[RealTrading] ${symbol} user ${telegramId}: protectOpenTrades skipped — grid fill in progress`);
              continue;
            }
            const effectiveSlPrice = slPrice;
            // Cooldown: skip if SL was recently placed (prevents spam when openAlgoOrders API fails)
            const slCooldownKey = `cache:sl-placed:${telegramId}:${symbol}`;
            const slRecentlyPlaced = await this.redisService.get(slCooldownKey);
            if (!algo?.hasSl && effectiveSlPrice && !slRecentlyPlaced) {
              // Use grid total quantity if DCA enabled
              const slQty = trade.gridLevels?.length > 0
                ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
                : trade.quantity;
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: SL missing — placing at $${effectiveSlPrice} qty=${slQty}`);
              try {
                // Cancel existing SL if we have an ID (prevent duplicates on Binance)
                if (trade.binanceSlAlgoId) {
                  await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
                }
                const roundedSl = round(effectiveSlPrice);
                const slOrder = await this.binanceService.setStopLoss(
                  keys.apiKey, keys.apiSecret, symbol, roundedSl,
                  direction as "LONG" | "SHORT", slQty,
                );
                const newId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { binanceSlAlgoId: newId } });
                // Set cooldown to prevent spam (10 minutes)
                await this.redisService.set(slCooldownKey, "1", 600);
                await this.telegramService.sendTelegramMessage(chatId,
                  `🛡️ *Bao Ve Vi The: SL Duoc Dat Lai*\n\n${symbol} ${direction}\nSL: *${fmtP(roundedSl)}*\n_SL bi mat — da tu dong dat lai de bao ve vi the._`
                ).catch(() => {});
              } catch (err) {
                const errMsg = err?.message ?? "";
                // Position is gone or SL already triggered — mark trade as closed
                const isPositionGone = (errMsg.includes("GTE") && errMsg.includes("open positions"))
                  || errMsg.includes("immediately trigger");
                if (isPositionGone) {
                  this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: SL failed (${errMsg}) — position likely closed on Binance`);
                  const exitP = this.marketDataService.getLatestPrice(symbol);
                  let pnlP = 0, pnlU = 0;
                  if (exitP && trade.entryPrice) {
                    pnlP = direction === "LONG"
                      ? ((exitP - trade.entryPrice) / trade.entryPrice) * 100
                      : ((trade.entryPrice - exitP) / trade.entryPrice) * 100;
                    pnlU = (pnlP / 100) * (trade.notionalUsdt || 0);
                  }
                  const updated = await this.userTradeModel.findOneAndUpdate(
                    { _id: (trade as any)._id, status: "OPEN" },
                    { $set: { status: "CLOSED", closeReason: "BINANCE_CLOSED", closedAt: new Date(),
                      ...(exitP ? { exitPrice: exitP, pnlPercent: pnlP, pnlUsdt: pnlU } : {}) } },
                    { new: true },
                  );
                  if (updated) {
                    // Resolve the associated signal so it doesn't stay ACTIVE in app
                    const closeR = pnlP >= 0 ? "TAKE_PROFIT" : "STOP_LOSS";
                    await this.signalQueueService.resolveActiveSignal(symbol, exitP, closeR as any).catch(e =>
                      this.logger.warn(`[RealTrading] ${symbol}: failed to resolve signal: ${e?.message}`),
                    );
                    const s = pnlP >= 0 ? "+" : "";
                    const emoji = pnlP >= 0 ? "✅" : "❌";
                    await this.telegramService.sendTelegramMessage(chatId,
                      `${emoji} *Real Mode: Lenh Da Dong*\n━━━━━━━━━━━━━━━━━━\n\n${symbol} ${direction}\nPnL: *${s}${pnlP.toFixed(2)}% (${s}${pnlU.toFixed(2)} USDT)*\n_Vi the da dong tren Binance_`
                    ).catch(() => {});
                  }
                  continue;
                }
                this.logger.error(`[RealTrading] ${symbol} user ${telegramId}: SL re-place FAILED: ${errMsg}`);
                // Only warn once — set a Redis key to prevent spamming every 5 min
                const warnKey = `cache:sl-warn:${telegramId}:${symbol}`;
                const alreadyWarned = await this.redisService.get(warnKey);
                if (!alreadyWarned) {
                  await this.redisService.set(warnKey, "1", 3600); // 1h cooldown
                  await this.telegramService.sendTelegramMessage(chatId,
                    `🚨 *CANH BAO: ${symbol} Khong Co SL!*\n\nKhong the tu dong dat SL tai ${fmtP(slPrice)}.\n*Hay dong lenh hoac dat SL thu cong tren Binance ngay!*\nLoi: ${errMsg}`
                  ).catch(() => {});
                }
              }
            }

            // ── TP missing ──────────────────────────────────────────────────
            const effectiveTpPrice = tpPrice;
            const tpCooldownKey = `cache:tp-placed:${telegramId}:${symbol}`;
            const tpRecentlyPlaced = await this.redisService.get(tpCooldownKey);
            if (effectiveTpPrice && !algo?.hasTp && !tpRecentlyPlaced) {
              // Use grid total quantity if DCA enabled
              const tpQty = trade.gridLevels?.length > 0
                ? trade.gridLevels.filter((g: any) => g.status === "FILLED").reduce((sum: number, g: any) => sum + (g.quantity || 0), 0) || trade.quantity
                : trade.quantity;
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: TP missing — placing at $${effectiveTpPrice} qty=${tpQty}`);
              try {
                // Cancel existing TP if we have an ID (prevent duplicates on Binance)
                if (trade.binanceTpAlgoId) {
                  await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});
                }
                const roundedTp = round(effectiveTpPrice);
                const tpOrder = await this.binanceService.setTakeProfitAtPrice(
                  keys.apiKey, keys.apiSecret, symbol, roundedTp,
                  direction as "LONG" | "SHORT",
                  tpQty,
                );
                const newId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { binanceTpAlgoId: newId } });
                // Set cooldown to prevent spam (10 minutes)
                await this.redisService.set(tpCooldownKey, "1", 600);
                await this.telegramService.sendTelegramMessage(chatId,
                  `🛡️ *Bao Ve Vi The: TP Duoc Dat Lai*\n\n${symbol} ${direction}\nTP: *${fmtP(roundedTp)}*\n_TP bi mat — da tu dong dat lai._`
                ).catch(() => {});
              } catch (err) {
                const tpErr = err?.message ?? "";
                // Position gone — don't keep retrying
                if ((tpErr.includes("GTE") && tpErr.includes("open positions")) || tpErr.includes("immediately trigger")) {
                  this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: TP failed (${tpErr}) — position likely closed`);
                  // SL handler above will close the trade on next cycle if not already
                } else {
                  this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: TP re-place failed: ${tpErr}`);
                }
              }
            }
          }
        } catch (err) {
          this.logger.error(`[RealTrading] protectOpenTrades error for user ${telegramId}: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[RealTrading] protectOpenTrades outer error: ${err?.message}`);
    }
  }

  // ─── Orphan Real Trade Hedge ───────────────────────────────────────────

  /**
   * Hedge protection for real trades whose signal is no longer ACTIVE.
   * When sim resolves (signal CLOSED), position-monitor stops firing price ticks,
   * so realHedgeCallback never runs. This cron picks up those orphaned trades every minute.
   * Runs at :30s offset from protectOpenTrades (:00s) to avoid resource contention.
   */
  @Cron("30 */1 * * * *")
  async checkOrphanHedges(): Promise<void> {
    const cfg = this.tradingConfig.get();
    if (!cfg.hedgeEnabled) return;

    try {
      // Only non-hedge trades
      const openTrades = await this.userTradeModel.find({ status: 'OPEN', isHedge: { $ne: true } }).lean();
      if (openTrades.length === 0) return;

      for (const trade of openTrades) {
        try {
          // Skip if signal is still ACTIVE — realHedgeCallback on price ticks handles it
          if (trade.aiSignalId) {
            const sig = await this.aiSignalModel.findById(trade.aiSignalId).select('status').lean();
            if (sig?.status === 'ACTIVE') continue;
          }

          // Signal gone/closed — this trade is orphaned. Run hedge check directly.
          const currentPrice = this.marketDataService.getLatestPrice(trade.symbol);
          if (!currentPrice || currentPrice <= 0) continue;

          const sub = await this.subscriptionService.getSubscription(trade.telegramId);
          if (!sub?.realModeEnabled) continue;

          // Find open hedge + closed hedge history
          const [hedgeTrade, closedHedges] = await Promise.all([
            this.userTradeModel.findOne({
              telegramId: trade.telegramId, aiSignalId: trade.aiSignalId,
              status: 'OPEN', isHedge: true,
            }).lean(),
            this.userTradeModel.find({
              telegramId: trade.telegramId, aiSignalId: trade.aiSignalId,
              status: 'CLOSED', isHedge: true,
            }).lean(),
          ]);

          const hedgeHistory = closedHedges.map((h: any) => ({
            direction: h.direction, entryPrice: h.entryPrice, exitPrice: h.exitPrice,
            pnlUsdt: h.pnlUsdt, closedAt: h.closedAt, reason: h.closeReason,
          }));

          const entry = (trade as any).gridAvgEntry || trade.entryPrice;
          const realPnlPct = trade.direction === 'LONG'
            ? ((currentPrice - entry) / entry) * 100
            : ((entry - currentPrice) / entry) * 100;

          const filledGridNotional = (trade as any).gridLevels?.length > 0
            ? (trade as any).gridLevels
                .filter((g: any) => g.status === 'FILLED')
                .reduce((s: number, g: any) => s + ((g.quantity || 0) * entry), 0) || trade.notionalUsdt
            : trade.notionalUsdt;

          const regime = (await this.redisService.get<string>('cache:ai:regime')) || 'MIXED';
          const signalId = trade.aiSignalId?.toString() || (trade as any)._id.toString();

          const ctx: HedgePositionContext = {
            id: `orphan:${trade.telegramId}:${signalId}`,
            symbol: trade.symbol,
            coin: trade.symbol.replace('USDT', ''),
            direction: trade.direction,
            entryPrice: entry,
            positionNotional: filledGridNotional || trade.notionalUsdt || 0,
            hedgeActive: !!hedgeTrade,
            hedgeCycleCount: closedHedges.length,
            hedgeHistory,
            hedgeEntryPrice: (hedgeTrade as any)?.entryPrice,
            hedgeDirection: (hedgeTrade as any)?.direction,
            hedgeNotional: (hedgeTrade as any)?.notionalUsdt,
            hedgeTpPrice: (hedgeTrade as any)?.tpPrice,
            hedgeSlAtEntry: (hedgeTrade as any)?.hedgeSlAtEntry,
            hedgeTrailActivated: (hedgeTrade as any)?.hedgeTrailActivated,
            hedgeSafetySlPrice: (trade as any)?.slPrice,
            stopLossPrice: trade.slPrice,
          };

          const action = await this.hedgeManager.checkHedge(ctx, currentPrice, realPnlPct, regime);
          if (!action || action.action === 'NONE') {
            if (action?.hedgeSlAtEntry && hedgeTrade) {
              await this.userTradeModel.updateOne({ _id: (hedgeTrade as any)._id }, { $set: { hedgeSlAtEntry: true } }).catch(() => {});
            }
            continue;
          }

          const keys = await this.userSettingsService.getApiKeys(trade.telegramId, 'binance');
          if (!keys?.apiKey) continue;

          if (action.action === 'CLOSE_HEDGE' && hedgeTrade) {
            await this.binanceService.closePosition(keys.apiKey, keys.apiSecret, trade.symbol, (hedgeTrade as any).quantity, (hedgeTrade as any).direction).catch(() => {});
            const hPnl = (hedgeTrade as any).direction === 'LONG'
              ? ((currentPrice - (hedgeTrade as any).entryPrice) / (hedgeTrade as any).entryPrice) * 100
              : (((hedgeTrade as any).entryPrice - currentPrice) / (hedgeTrade as any).entryPrice) * 100;
            await this.userTradeModel.findByIdAndUpdate((hedgeTrade as any)._id, {
              status: 'CLOSED', exitPrice: currentPrice,
              pnlPercent: Math.round(hPnl * 100) / 100,
              pnlUsdt: Math.round((hPnl / 100) * (hedgeTrade as any).notionalUsdt * 100) / 100,
              closeReason: hPnl >= 0 ? 'HEDGE_TP' : 'HEDGE_CLOSE',
              closedAt: new Date(),
            });
            // Restore main SL with progressive tightening (matches sim)
            // Uses cycle count + hedge efficiency (recovery ratio)
            const completedCycles = closedHedges.length + 1;
            const allHedgePnl = [...closedHedges, { pnlUsdt: Math.round((hPnl / 100) * (hedgeTrade as any).notionalUsdt * 100) / 100 }];
            const totalBanked = allHedgePnl.reduce((s: number, h: any) => s + (h.pnlUsdt || 0), 0);
            const mainLossUsdt = Math.abs(Math.min(0, (realPnlPct / 100) * (filledGridNotional || trade.notionalUsdt)));
            const recoveryRatio = mainLossUsdt > 0 ? totalBanked / mainLossUsdt : 1;

            // High recovery (≥50%): hedge is working → keep 40% SL
            // Low recovery (<50%) + 3+ cycles: direction wrong → tighten
            let progressiveSlPct: number;
            if (recoveryRatio >= 0.5 || completedCycles <= 2) {
              progressiveSlPct = 40;
            } else if (completedCycles === 3) {
              progressiveSlPct = 15;
            } else {
              progressiveSlPct = 8;
            }

            const restoredSl = trade.direction === 'LONG'
              ? +(entry * (1 - progressiveSlPct / 100)).toFixed(6) : +(entry * (1 + progressiveSlPct / 100)).toFixed(6);
            const pp = await this.getPricePrecision(trade.symbol);
            const slOrder = await this.binanceService.setStopLoss(
              keys.apiKey, keys.apiSecret, trade.symbol,
              parseFloat(restoredSl.toFixed(pp)), trade.direction as 'LONG' | 'SHORT', (trade as any).quantity,
            ).catch(() => null);
            if (slOrder) {
              const newSlId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
              await this.userTradeModel.updateOne({ _id: (trade as any)._id }, { $set: { slPrice: restoredSl, binanceSlAlgoId: newSlId } });
            }
            this.logger.log(`[OrphanHedge] Closed hedge ${trade.telegramId} ${trade.symbol} PnL=${hPnl.toFixed(2)}% SL=${restoredSl} (${progressiveSlPct}%) cycle=${completedCycles} recovery=${(recoveryRatio * 100).toFixed(0)}%`);

            // Circuit breaker: only close if hedge is ineffective AND price beyond SL
            if (completedCycles >= 3 && recoveryRatio < 0.5) {
              const slBreached = trade.direction === 'LONG'
                ? currentPrice <= restoredSl
                : currentPrice >= restoredSl;
              if (slBreached) {
                this.logger.warn(
                  `[OrphanHedge] CIRCUIT BREAKER: ${trade.symbol} price ${currentPrice} beyond SL ${restoredSl} (${progressiveSlPct}%) cycle=${completedCycles} recovery=${(recoveryRatio * 100).toFixed(0)}% → closing main`,
                );
                await this.closeRealPosition(trade.telegramId, (trade as any).chatId, trade.symbol, 'PROGRESSIVE_SL').catch(() => {});
              }
            }

          } else if (action.action === 'OPEN_FULL' || action.action === 'OPEN_PARTIAL') {
            // Orphan trades: do NOT open new hedges independently.
            // Only sim-driven hedgeCallback → onHedgeEvent can open hedges.
            this.logger.log(`[OrphanHedge] Skipping hedge OPEN for orphan ${trade.symbol} — no sim control`);
            continue;
            // Dead code below — kept for reference if re-enabling orphan hedge
            if ((trade as any).binanceSlAlgoId) {
              await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, (trade as any).binanceSlAlgoId).catch(() => {});
              await this.userTradeModel.updateOne({ _id: (trade as any)._id }, { $set: { binanceSlAlgoId: null, slPrice: 0 } }).catch(() => {});
            }
            const hedgeDir = action.hedgeDirection || (trade.direction === 'LONG' ? 'SHORT' : 'LONG');
            const hedgeNotional = action.hedgeNotional || (filledGridNotional || trade.notionalUsdt) * 0.75;
            const qtyPrec = await this.getQuantityPrecision(trade.symbol);
            const hedgeQty = parseFloat((hedgeNotional / currentPrice).toFixed(qtyPrec));
            if (hedgeQty <= 0) continue;

            const order = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
              symbol: trade.symbol, side: hedgeDir as 'LONG' | 'SHORT',
              quantity: hedgeQty, leverage: trade.leverage || 1,
            });
            const fillPrice = parseFloat(order?.avgPrice) || currentPrice;
            const actualTpPrice = this.hedgeManager.getHedgeTpPrice(fillPrice, hedgeDir, regime);
            if (actualTpPrice) {
              const pp = await this.getPricePrecision(trade.symbol);
              await this.binanceService.setTakeProfitAtPrice(
                keys.apiKey, keys.apiSecret, trade.symbol,
                parseFloat(actualTpPrice.toFixed(pp)), hedgeDir as 'LONG' | 'SHORT', hedgeQty,
              ).catch(() => {});
            }
            await this.userTradeModel.create({
              telegramId: trade.telegramId, chatId: trade.chatId,
              symbol: trade.symbol, direction: hedgeDir,
              entryPrice: fillPrice, quantity: hedgeQty,
              leverage: trade.leverage || 1, notionalUsdt: hedgeNotional,
              slPrice: 0, tpPrice: actualTpPrice || 0,
              status: 'OPEN', openedAt: new Date(),
              aiSignalId: trade.aiSignalId, isHedge: true,
              parentTradeId: (trade as any)._id,
              hedgeCycle: closedHedges.length + 1,
              hedgePhase: action.hedgePhase || 'FULL',
            });
            this.logger.log(`[OrphanHedge] Opened hedge ${trade.telegramId} ${trade.symbol} ${hedgeDir} $${hedgeNotional.toFixed(0)} @ ${fillPrice} PnL=${realPnlPct.toFixed(2)}%`);
          }
        } catch (err) {
          this.logger.error(`[OrphanHedge] trade ${(trade as any)._id} error: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[OrphanHedge] outer error: ${err?.message}`);
    }
  }

  // ─── Grid Recovery ─────────────────────────────────────────────────────

  /**
   * Build grid levels array for a new trade.
   * Level 0 = base (FILLED at entry), levels 1-N = PENDING at deviation steps.
   */
  // Fixed 4 DCA grid levels at 0%, 2%, 4%, 6% — matches sim exactly
  private static readonly GRID_DEVIATIONS = [0, 2, 4, 6];
  private static readonly GRID_DCA_WEIGHTS = [40, 15, 15, 30]; // L0=40%, L1=15%, L2=15%, L3=30%
  private static readonly GRID_LEVEL_COUNT = 4;

  private buildGridLevels(
    fillPrice: number,
    _direction: string,
    _sub: SubscriberInfo,
    _stopLossPrice: number,
  ): Array<any> {
    const grids: any[] = [];
    for (let i = 0; i < UserRealTradingService.GRID_LEVEL_COUNT; i++) {
      const dev = UserRealTradingService.GRID_DEVIATIONS[i];
      const volumePct = UserRealTradingService.GRID_DCA_WEIGHTS[i];
      if (i === 0) {
        grids.push({
          level: 0, deviationPct: 0, fillPrice, quantity: 0,
          volumePct, status: "FILLED", filledAt: new Date(),
        });
      } else {
        grids.push({
          level: i, deviationPct: dev, fillPrice: 0, quantity: 0,
          volumePct, status: "PENDING",
        });
      }
    }
    return grids;
  }

  /** DCA volume weights: L0=35% base, remaining 65% linearly increasing (matches sim) */
  private getDcaWeights(levelCount: number): number[] {
    if (levelCount <= 1) return [100];
    const baseWeight = 35;
    const remaining = 100 - baseWeight;
    const dcaCount = levelCount - 1;
    // Linearly increasing weights for DCA levels
    const raw = Array.from({ length: dcaCount }, (_, i) => i + 1);
    const total = raw.reduce((s, v) => s + v, 0);
    const dcaWeights = raw.map((v) => Math.round((v / total) * remaining * 10) / 10);
    return [baseWeight, ...dcaWeights];
  }

  /**
   * Every 30 seconds: check grid-enabled open trades for:
   * 1. PENDING grid fills (price dropped to trigger level → place additional market order)
   * 2. FILLED grid TP hits (price bounced to TP → partial close via reduce-only order)
   */
  @Cron("*/30 * * * * *")
  async checkGridOrders(): Promise<void> {
    try {
      const gridTrades = await this.userTradeModel.find({
        status: "OPEN",
        gridLevels: { $exists: true, $ne: [] },
      }).lean();
      if (gridTrades.length === 0) return;

      for (const trade of gridTrades) {
        try {
          const currentPrice = this.marketDataService.getLatestPrice(trade.symbol);
          if (!currentPrice) continue;

          const origEntry = trade.originalEntryPrice ?? trade.entryPrice;
          const grids: any[] = trade.gridLevels ?? [];
          const { direction, symbol, telegramId } = trade;
          let gridChanged = false;

          // DCA continues even when hedge is active — lowers avgEntry for easier recovery

          // Check PENDING grids for fill triggers (DCA: add to position)
          // RSI guard: only DCA when RSI shows exhaustion (likely to bounce)
          let rsiOk: boolean | null = null;
          const coin = symbol.replace("USDT", "");

          for (const grid of grids) {
            if (grid.status !== "PENDING") continue;
            const triggerPrice = direction === "LONG"
              ? origEntry * (1 - grid.deviationPct / 100)
              : origEntry * (1 + grid.deviationPct / 100);
            const triggered = direction === "LONG" ? currentPrice <= triggerPrice : currentPrice >= triggerPrice;
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
                    // Level-based RSI softening (match sim: L1=48/52, L2=45/55, L3+=42/58)
                    const level = grid.level || 0;
                    const rsiThresh = level <= 1 ? 48 : level <= 2 ? 45 : 42;
                    const rsiExhausted = direction === "LONG" ? rsi < rsiThresh : rsi > (100 - rsiThresh);

                    // Sustained momentum check: if last 3 closes are all declining (LONG) or rising (SHORT),
                    // selling/buying is still active — wait for at least 1 stabilization candle
                    const last4 = closes.slice(-4);
                    const sustainedAgainst = last4.length >= 4 && (
                      direction === "LONG"
                        ? last4[3] < last4[2] && last4[2] < last4[1] && last4[1] < last4[0] // 3 consecutive lower closes
                        : last4[3] > last4[2] && last4[2] > last4[1] && last4[1] > last4[0] // 3 consecutive higher closes
                    );

                    // Momentum check only for L3+ (match sim — L1-L2 use RSI only)
                    rsiOk = rsiExhausted && (level < 3 || !sustainedAgainst);
                    if (!rsiOk) {
                      this.logger.log(
                        `[Grid] ${symbol} user ${telegramId} L${grid.level} RSI=${rsi.toFixed(1)} sustained=${sustainedAgainst} — skip DCA (waiting for exhaustion/stabilization)`,
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

              await this.placeGridOrder(trade as any, grid, currentPrice);
              gridChanged = true;
            }
          }

          // No individual grid TP — TP/SL for the whole position is handled by Binance algo orders.
          // When Binance SL/TP fires, all grids close together (handled by onTradeClose/protectOpenTrades).

          // Persist grid state + recalculate avg entry + SL/TP if changed
          if (gridChanged) {
            const filledGrids = grids.filter(g => g.status === "FILLED");
            const filledCount = filledGrids.length;
            // Recalculate weighted avg entry
            const totalQty = filledGrids.reduce((s, g) => s + (g.quantity || 0), 0);
            const avgEntry = totalQty > 0
              ? filledGrids.reduce((s, g) => s + g.fillPrice * (g.quantity || 0), 0) / totalQty
              : origEntry;

            // Recalculate SL from new avgEntry — keep same % distance as original
            const origSlPct = origEntry > 0
              ? Math.abs((trade.slPrice - origEntry) / origEntry * 100)
              : 2.5; // fallback
            const newSlPrice = direction === "LONG"
              ? avgEntry * (1 - origSlPct / 100)
              : avgEntry * (1 + origSlPct / 100);

            // DCA TP: 3% from new avgEntry
            const DCA_TP_PCT = this.tradingConfig.get().dcaTpPct ?? 3.0;
            const tpUpdate: Record<string, any> = {};
            if (trade.tpPrice) {
              tpUpdate.tpPrice = direction === "LONG"
                ? avgEntry * (1 + DCA_TP_PCT / 100)
                : avgEntry * (1 - DCA_TP_PCT / 100);
            }

            this.logger.log(
              `[Grid] ${symbol} user ${telegramId} DCA recalc: avgEntry=${avgEntry.toFixed(4)} SL=${newSlPrice.toFixed(4)} (${origSlPct.toFixed(1)}% from avg) old SL=${trade.slPrice.toFixed(4)}`,
            );

            await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
              gridLevels: grids,
              gridFilledCount: filledCount,
              gridAvgEntry: avgEntry,
              entryPrice: avgEntry, // sync for display
              slPrice: newSlPrice,
              ...tpUpdate,
            });
          }
        } catch (err) {
          this.logger.error(`[Grid] Error checking ${trade.symbol} user ${trade.telegramId}: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[Grid] checkGridOrders outer error: ${err?.message}`);
    }
  }

  /**
   * Place a grid level order: additional market order at the grid trigger price.
   * Each grid gets its own quantity (equal split of total volume).
   */
  private async placeGridOrder(
    trade: UserTradeDocument,
    grid: any,
    currentPrice: number,
  ): Promise<void> {
    const { telegramId, chatId, symbol, direction } = trade;
    const level = grid.level;

    // Prevent duplicate grid placement — double check: Redis lock + DB status
    const lockKey = `cache:grid-lock:${telegramId}:${symbol}:${level}`;
    const acquired = await this.redisService.setNX(lockKey, "1", 120);
    if (!acquired) return;

    // Re-read from DB to verify grid is still PENDING (prevent race between 30s cron cycles)
    const freshTrade = await this.userTradeModel.findById((trade as any)._id).lean();
    const freshGrid = (freshTrade as any)?.gridLevels?.find((g: any) => g.level === level);
    if (!freshGrid || freshGrid.status !== 'PENDING') {
      this.logger.debug(`[Grid] ${symbol} L${level} already filled (DB check) — skip`);
      return;
    }

    const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
    if (!keys?.apiKey) return;

    try {
      const sub = await this.subscriptionService.getSubscription(telegramId);
      if (!sub || !sub.gridEnabled) return;

      const fullVol = this.getVolForUser(symbol, sub);
      const gridVol = fullVol * (UserRealTradingService.GRID_DCA_WEIGHTS[grid.level] / 100);

      const [qtyPrec, pricePrec] = await Promise.all([
        this.getQuantityPrecision(symbol),
        this.getPricePrecision(symbol),
      ]);

      const gridQty = parseFloat((gridVol / currentPrice).toFixed(qtyPrec));
      if (gridQty <= 0) return;

      // Place additional market order (same direction — adds to existing position)
      const order = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
        symbol,
        side: direction as "LONG" | "SHORT",
        quantity: gridQty,
        leverage: trade.leverage,
      });
      const gridFillPrice = parseFloat(order.avgPrice) || currentPrice;

      // Update grid level (no individual TP — whole position uses signal TP)
      grid.status = "FILLED";
      grid.fillPrice = gridFillPrice;
      grid.quantity = gridQty;
      grid.filledAt = new Date();

      // Update total quantity + recalculate avg entry
      const newTotalQty = trade.quantity + gridQty;
      const filledGrids = (trade.gridLevels ?? []).filter((g: any) => g.status === "FILLED");
      const totalQty = filledGrids.reduce((s: number, g: any) => s + (g.quantity || 0), 0) + gridQty;
      const avgEntry = totalQty > 0
        ? (filledGrids.reduce((s: number, g: any) => s + g.fillPrice * (g.quantity || 0), 0) + gridFillPrice * gridQty) / totalQty
        : trade.entryPrice;

      // SL stays at original price — do NOT move SL when DCA fills.
      // DCA TP: always 4% from new avgEntry
      const currentSlPrice = (trade as any).slMovedToEntry
        ? (trade.gridGlobalSlPrice ?? trade.slPrice)   // trailing already moved SL
        : (trade.gridGlobalSlPrice ?? trade.slPrice);  // original SL price unchanged
      const tpUpdate: Record<string, any> = {};

      let newTpPrice: number | undefined;
      if (trade.tpPrice) {
        // Always use 4% TP from new avgEntry after DCA (MAX_TP cap)
        // Previously used origTpPct which could be <4%, wasting DCA advantage
        const DCA_TP_PCT = 3.0;
        newTpPrice = direction === "LONG"
          ? avgEntry * (1 + DCA_TP_PCT / 100)
          : avgEntry * (1 - DCA_TP_PCT / 100);
        tpUpdate.tpPrice = newTpPrice;
        this.logger.log(`[Grid] ${symbol} TP recalc: avgEntry=${avgEntry.toFixed(4)} → TP=${newTpPrice.toFixed(4)} (4% from avgEntry)`);
      }

      const filledCount = filledGrids.length;
      await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
        quantity: newTotalQty,
        notionalUsdt: newTotalQty * avgEntry,
        entryPrice: avgEntry,
        gridAvgEntry: avgEntry,
        gridLevels: trade.gridLevels,
        gridFilledCount: filledCount,
        ...tpUpdate,
      });

      // Sync grid state back to ai_signal so admin frontend shows grid data
      if ((trade as any).aiSignalId) {
        await this.aiSignalModel.findByIdAndUpdate((trade as any).aiSignalId, {
          gridLevels: trade.gridLevels,
          gridFilledCount: filledCount,
          gridAvgEntry: avgEntry,
          entryPrice: avgEntry,
          ...(tpUpdate.tpPrice ? { takeProfitPrice: tpUpdate.tpPrice } : {}),
        }).catch(err => this.logger.warn(`[Grid] ${symbol} signal sync failed: ${err?.message}`));
      }

      // Update SL on Binance for new total quantity (same SL price — don't move SL)
      await new Promise((r) => setTimeout(r, 1500));
      if (trade.binanceSlAlgoId) {
        await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
      }
      const roundedSl = parseFloat(currentSlPrice.toFixed(pricePrec));
      try {
        const slOrder = await this.binanceService.setStopLoss(
          keys.apiKey, keys.apiSecret, symbol, roundedSl,
          direction as "LONG" | "SHORT", newTotalQty,
        );
        const newSlId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, { binanceSlAlgoId: newSlId });
      } catch (err) {
        this.logger.error(`[Grid] ${symbol} L${level} SL update failed for user ${telegramId}: ${err?.message}`);
      }

      // Update TP for new avg entry + total quantity (cancel old, place new)
      if (newTpPrice) {
        try {
          // Cancel old TP if exists
          if (trade.binanceTpAlgoId) {
            await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});
          }
          const roundedTp = parseFloat(newTpPrice.toFixed(pricePrec));
          const tpOrder = await this.binanceService.setTakeProfitAtPrice(
            keys.apiKey, keys.apiSecret, symbol, roundedTp,
            direction as "LONG" | "SHORT", newTotalQty,
          );
          const newTpId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
          await this.userTradeModel.findByIdAndUpdate((trade as any)._id, { binanceTpAlgoId: newTpId, tpPrice: roundedTp });
          this.logger.log(`[Grid] ${symbol} L${level} TP updated: $${roundedTp} (4% from avgEntry=${avgEntry.toFixed(4)}) qty=${newTotalQty}`);
        } catch (err) {
          this.logger.error(`[Grid] ${symbol} L${level} TP update failed for user ${telegramId}: ${err?.message}`);
        }
      }

      // Notify user
      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
      const msg =
        `🔲 *Grid DCA L${level} Filled*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${symbol} ${direction}\n` +
        `L${level}: *×${gridQty}* @ ${fmtP(gridFillPrice)}\n` +
        `Avg Entry: *${fmtP(avgEntry)}*\n` +
        `Total Qty: *×${newTotalQty.toFixed(qtyPrec)}*\n` +
        `SL: ${fmtP(currentSlPrice)}` + (newTpPrice ? ` | TP: ${fmtP(newTpPrice)}` : "");
      await this.telegramService.sendTelegramMessage(chatId, msg).catch(() => {});

      this.logger.log(
        `[Grid] ${symbol} L${level} filled for user ${telegramId}: ×${gridQty} @ ${gridFillPrice}`,
      );
    } catch (err) {
      this.logger.error(`[Grid] ${symbol} L${level} failed for user ${telegramId}: ${err?.message}`);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Returns true if any grid level for this user+symbol is currently being replaced (cancel/place window). */
  private async isGridReplacing(telegramId: string | number, symbol: string): Promise<boolean> {
    const levelCount = 10; // max grid levels to check
    for (let i = 0; i < levelCount; i++) {
      const lockKey = `cache:grid-lock:${telegramId}:${symbol}:${i}`;
      const locked = await this.redisService.get(lockKey);
      if (locked) return true;
    }
    return false;
  }

  private async resolveLeverage(
    sub: SubscriberInfo,
    params: AiTunedParams,
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<number> {
    const mode = sub.realModeLeverageMode ?? "AI";
    if (mode === "FIXED") return sub.realModeLeverage ?? 10;
    if (mode === "MAX") {
      try {
        const client = this.binanceService.createClient(apiKey, apiSecret);
        const brackets = await (client as any).futuresLeverageBracket({ symbol, recvWindow: 5000 });
        return (brackets as any)[0]?.brackets?.[0]?.initialLeverage ?? 20;
      } catch {
        return 20;
      }
    }
    // "AI" mode
    return (params as any).leverage ?? 10;
  }

  /**
   * Volume per trade = tradingBalance / maxOpenPositions.
   * tradingBalance is the total balance the user inputs.
   */
  private getVolForUser(symbol: string, sub: { coinVolumes?: Record<string, number>; tradingBalance?: number }): number {
    const base = symbol.replace(/USDT$/, '');
    return sub.coinVolumes?.[base] ?? sub.coinVolumes?.[symbol] ?? sub.tradingBalance ?? 1000;
  }

  /** Fetch exchangeInfo once and cache both qty precision and price decimal places (from tickSize). */
  private async fetchAndCacheSymbolPrecisions(symbol: string): Promise<{ qty: number; price: number }> {
    try {
      const res = await axios.get("https://fapi.binance.com/fapi/v1/exchangeInfo", {
        timeout: 5_000,
        httpsAgent: getProxyAgent(),
      });
      const info = res.data.symbols?.find((s: any) => s.symbol === symbol);
      const qty = info?.quantityPrecision ?? 3;

      // Derive price decimal places from PRICE_FILTER tickSize — this is the actual Binance constraint,
      // not the display-only `pricePrecision` field.
      const priceFilter = info?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
      const tickSize = priceFilter?.tickSize ? parseFloat(priceFilter.tickSize) : 0.01;
      const price = tickSize >= 1 ? 0 : Math.min(8, Math.round(-Math.log10(tickSize)));

      await this.redisService.set(QTY_PRECISION_KEY(symbol), qty, 24 * 3600);
      await this.redisService.set(PRICE_PRECISION_KEY(symbol), price, 24 * 3600);
      return { qty, price };
    } catch {
      return { qty: 3, price: 2 };
    }
  }

  private async getQuantityPrecision(symbol: string): Promise<number> {
    const cached = await this.redisService.get<number>(QTY_PRECISION_KEY(symbol));
    if (cached != null) return cached;
    return (await this.fetchAndCacheSymbolPrecisions(symbol)).qty;
  }

  private async getPricePrecision(symbol: string): Promise<number> {
    const cached = await this.redisService.get<number>(PRICE_PRECISION_KEY(symbol));
    if (cached != null) return cached;
    return (await this.fetchAndCacheSymbolPrecisions(symbol)).price;
  }

  /** Invalidate cached precision and re-fetch from Binance exchangeInfo. */
  private async refreshPricePrecision(symbol: string): Promise<number> {
    await this.redisService.delete(PRICE_PRECISION_KEY(symbol));
    await this.redisService.delete(QTY_PRECISION_KEY(symbol));
    return (await this.fetchAndCacheSymbolPrecisions(symbol)).price;
  }

  /** Re-register data streams for users with OPEN trades (called on module init). */
  private async reRegisterOpenTradeStreams(): Promise<void> {
    if (!this.userDataStreamService) {
      this.logger.warn(`[RealTrading] reRegisterOpenTradeStreams: userDataStreamService not set yet`);
      return;
    }
    try {
      const telegramIds = await this.userTradeModel
        .distinct("telegramId", { status: "OPEN" })
        .exec();
      for (const telegramId of telegramIds) {
        const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
        if (keys?.apiKey) {
          await this.userDataStreamService.registerUser(telegramId, keys.apiKey, keys.apiSecret).catch(() => {});
        }
      }
      if (telegramIds.length > 0) {
        this.logger.log(
          `[RealTrading] Re-registered data streams for ${telegramIds.length} user(s) with open trades`,
        );
      }
    } catch (err) {
      this.logger.warn(`[RealTrading] reRegisterOpenTradeStreams error: ${err?.message}`);
    }
  }

  // ─── Account PnL Snapshot ──────────────────────────────────────────────

  /**
   * Cron: every 5min fetch Binance Futures balance + positions as FALLBACK.
   * Primary source is WebSocket ACCOUNT_UPDATE in UserDataStreamService (realtime).
   * This cron fills in markPrice/leverage/liquidationPrice which WS doesn't provide.
   *
   * Redis key: cache:account-pnl:{telegramId}
   * TTL: 360s (6min, stale after 1 missed cycle)
   */
  @Cron("0 */5 * * * *")
  async snapshotAccountPnl(): Promise<void> {
    try {
      const subs = await this.subscriptionService.findRealModeSubscribers();
      if (!subs.length) return;

      for (const sub of subs) {
        try {
          const keys = await this.userSettingsService.getApiKeys(sub.telegramId, "binance");
          if (!keys?.apiKey) continue;

          const [balance, positions] = await Promise.all([
            this.binanceService.getFuturesBalance(keys.apiKey, keys.apiSecret),
            this.binanceService.getOpenPositions(keys.apiKey, keys.apiSecret),
          ]);

          if (!balance) continue;

          const snapshot = {
            telegramId: sub.telegramId,
            username: (sub as any).username || "",
            walletBalance: balance.walletBalance,
            availableBalance: balance.availableBalance,
            unrealizedPnl: balance.unrealizedPnl,
            totalBalance: balance.walletBalance + balance.unrealizedPnl,
            positions: (positions || []).map((p) => ({
              symbol: p.symbol,
              side: p.side,
              quantity: p.quantity,
              entryPrice: p.entryPrice,
              markPrice: p.currentPrice,
              unrealizedPnl: p.unrealizedPnl,
              leverage: p.leverage,
              margin: p.margin,
              liquidationPrice: p.liquidationPrice,
              stopLoss: p.stopLoss,
              takeProfit: p.takeProfit,
            })),
            positionCount: (positions || []).length,
            updatedAt: new Date().toISOString(),
          };

          await this.redisService.set(
            `cache:account-pnl:${sub.telegramId}`,
            snapshot,
            360, // 6min TTL — WS updates more frequently
          );
        } catch {
          // fail-open per user — don't break loop
        }
      }
    } catch (err) {
      this.logger.debug(`[RealTrading] snapshotAccountPnl error: ${err?.message}`);
    }
  }

  /**
   * Get all account PnL snapshots from Redis (called by admin API).
   */
  async getAllAccountPnl(): Promise<any[]> {
    const subs = await this.subscriptionService.findRealModeSubscribers();

    const results: any[] = [];
    for (const sub of subs) {
      const snapshot = await this.redisService.get<any>(`cache:account-pnl:${sub.telegramId}`);
      if (snapshot) results.push(snapshot);
    }
    return results;
  }

  // ─── Independent Real Hedge Check ─────────────────────────────────────

  /**
   * Check hedge independently for each real user based on THEIR actual entry/notional.
   * Called from position-monitor on every price tick (via callback).
   */
  async checkRealHedge(signal: any, currentPrice: number, regime: string): Promise<void> {
    const signalId = signal._id?.toString();
    if (!signalId) return;

    const subscribers = await this.subscriptionService.findRealModeSubscribers();
    if (subscribers.length === 0) return;

    for (const sub of subscribers) {
      try {
        // Find user's main trade for this signal
        const mainTrade = await this.userTradeModel.findOne({
          telegramId: sub.telegramId, aiSignalId: signalId,
          status: 'OPEN', isHedge: { $ne: true },
        }).lean();
        if (!mainTrade) continue;

        // Find user's open hedge trade (if any)
        const hedgeTrade = await this.userTradeModel.findOne({
          telegramId: sub.telegramId, aiSignalId: signalId,
          status: 'OPEN', isHedge: true,
        }).lean();

        // Build hedge history from closed hedge trades
        const closedHedges = await this.userTradeModel.find({
          telegramId: sub.telegramId, aiSignalId: signalId,
          status: 'CLOSED', isHedge: true,
        }).lean();
        const hedgeHistory = closedHedges.map((h: any) => ({
          direction: h.direction, entryPrice: h.entryPrice, exitPrice: h.exitPrice,
          pnlUsdt: h.pnlUsdt, closedAt: h.closedAt, reason: h.closeReason,
        }));

        // Calculate real PnL from user's actual entry
        const entry = (mainTrade as any).gridAvgEntry || mainTrade.entryPrice;
        const realPnlPct = mainTrade.direction === 'LONG'
          ? ((currentPrice - entry) / entry) * 100
          : ((entry - currentPrice) / entry) * 100;

        // Compute actual filled notional — sum DCA grid levels if available, else use opening notional
        const filledGridNotional = (mainTrade as any).gridLevels?.length > 0
          ? (mainTrade as any).gridLevels
              .filter((g: any) => g.status === 'FILLED')
              .reduce((s: number, g: any) => s + ((g.quantity || 0) * entry), 0) || mainTrade.notionalUsdt
          : mainTrade.notionalUsdt;

        // Build context from real trade data
        const ctx: HedgePositionContext = {
          id: `real:${sub.telegramId}:${signalId}`,
          symbol: mainTrade.symbol,
          coin: mainTrade.symbol.replace('USDT', ''),
          direction: mainTrade.direction,
          entryPrice: entry,
          positionNotional: filledGridNotional || mainTrade.notionalUsdt || 0,
          hedgeActive: !!hedgeTrade,
          hedgeCycleCount: closedHedges.length,
          hedgeHistory,
          hedgeEntryPrice: hedgeTrade?.entryPrice,
          hedgeDirection: hedgeTrade?.direction,
          hedgeNotional: hedgeTrade?.notionalUsdt,
          hedgeTpPrice: (hedgeTrade as any)?.tpPrice,
          hedgeSlAtEntry: (hedgeTrade as any)?.hedgeSlAtEntry,
          hedgeTrailActivated: (hedgeTrade as any)?.hedgeTrailActivated,
          hedgeSafetySlPrice: (mainTrade as any)?.slPrice,
          stopLossPrice: mainTrade.slPrice,
        };

        const action = await this.hedgeManager.checkHedge(ctx, currentPrice, realPnlPct, regime);
        if (!action || action.action === 'NONE') {
          // Update hedge flags on trade if needed
          if (action?.hedgeSlAtEntry && hedgeTrade) {
            await this.userTradeModel.updateOne({ _id: hedgeTrade._id }, { $set: { hedgeSlAtEntry: true } }).catch(() => {});
          }
          if (action?.hedgeTrailActivated && hedgeTrade) {
            await this.userTradeModel.updateOne({ _id: hedgeTrade._id }, { $set: { hedgeTrailActivated: true } }).catch(() => {});
          }
          continue;
        }

        if (action.action === 'CLOSE_HEDGE' && hedgeTrade) {
          // Close real hedge
          const keys = await this.userSettingsService.getApiKeys(sub.telegramId, 'binance');
          if (keys?.apiKey) {
            await this.binanceService.closePosition(keys.apiKey, keys.apiSecret, mainTrade.symbol, hedgeTrade.quantity, hedgeTrade.direction).catch(() => {});
            const hPnl = hedgeTrade.direction === 'LONG'
              ? ((currentPrice - hedgeTrade.entryPrice) / hedgeTrade.entryPrice) * 100
              : ((hedgeTrade.entryPrice - currentPrice) / hedgeTrade.entryPrice) * 100;
            await this.userTradeModel.findByIdAndUpdate(hedgeTrade._id, {
              status: 'CLOSED', exitPrice: currentPrice,
              pnlPercent: Math.round(hPnl * 100) / 100,
              pnlUsdt: Math.round((hPnl / 100) * hedgeTrade.notionalUsdt * 100) / 100,
              closeReason: action.reason?.includes('trail') ? 'HEDGE_TRAIL' : hPnl >= 0 ? 'HEDGE_TP' : 'HEDGE_CLOSE',
              closedAt: new Date(),
            });
            // Restore SL on main trade
            const mainEntry = (mainTrade as any).gridAvgEntry || mainTrade.entryPrice;
            const restoredSl = mainTrade.direction === 'LONG'
              ? +(mainEntry * 0.60).toFixed(6) : +(mainEntry * 1.40).toFixed(6);
            const pp = await this.getPricePrecision(mainTrade.symbol);
            const roundedSl = parseFloat(restoredSl.toFixed(pp));
            const slQty = mainTrade.quantity;
            try {
              const slOrder = await this.binanceService.setStopLoss(keys.apiKey, keys.apiSecret, mainTrade.symbol, roundedSl, mainTrade.direction as 'LONG' | 'SHORT', slQty);
              const newSlId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
              await this.userTradeModel.updateOne({ _id: mainTrade._id }, { $set: { slPrice: roundedSl, binanceSlAlgoId: newSlId } });
            } catch {}
            this.logger.log(`[RealHedge] Closed hedge for ${sub.telegramId} ${mainTrade.symbol} PnL=${hPnl.toFixed(2)}% (${action.reason})`);
          }
        } else if (action.action === 'OPEN_FULL' || action.action === 'OPEN_PARTIAL') {
          // Open real hedge
          const keys = await this.userSettingsService.getApiKeys(sub.telegramId, 'binance');
          if (!keys?.apiKey) continue;

          // Cancel main SL (hedge manages risk)
          if ((mainTrade as any).binanceSlAlgoId) {
            await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, (mainTrade as any).binanceSlAlgoId).catch(() => {});
            await this.userTradeModel.updateOne({ _id: mainTrade._id }, { $set: { binanceSlAlgoId: null, slPrice: 0 } }).catch(() => {});
          }

          const hedgeDir = action.hedgeDirection || (mainTrade.direction === 'LONG' ? 'SHORT' : 'LONG');
          // Use filled grid notional (actual position size) for hedge sizing — matches sim
          const mainEntry = (mainTrade as any).gridAvgEntry || mainTrade.entryPrice;
          const filledGridNotional = (mainTrade as any).gridLevels?.length > 0
            ? (mainTrade as any).gridLevels
                .filter((g: any) => g.status === 'FILLED')
                .reduce((s: number, g: any) => s + ((g.quantity || 0) * mainEntry), 0) || mainTrade.notionalUsdt
            : mainTrade.notionalUsdt;
          const hedgeNotional = action.hedgeNotional || filledGridNotional * 0.75;
          const [qtyPrec] = await Promise.all([this.getQuantityPrecision(mainTrade.symbol)]);
          const hedgeQty = parseFloat((hedgeNotional / currentPrice).toFixed(qtyPrec));
          if (hedgeQty <= 0) continue;

          try {
            const order = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
              symbol: mainTrade.symbol, side: hedgeDir as 'LONG' | 'SHORT',
              quantity: hedgeQty, leverage: mainTrade.leverage || 1,
            });
            const fillPrice = parseFloat(order?.avgPrice) || currentPrice;

            // Recalculate TP from actual fill price (not tick price) to correct for slippage
            let actualTpPrice = action.hedgeTpPrice;
            if (action.hedgeTpPrice && fillPrice !== currentPrice) {
              actualTpPrice = this.hedgeManager.getHedgeTpPrice(fillPrice, hedgeDir, regime);
            }

            // Place TP for hedge
            if (actualTpPrice) {
              const pp = await this.getPricePrecision(mainTrade.symbol);
              await this.binanceService.setTakeProfitAtPrice(
                keys.apiKey, keys.apiSecret, mainTrade.symbol,
                parseFloat(actualTpPrice.toFixed(pp)), hedgeDir as 'LONG' | 'SHORT', hedgeQty,
              ).catch(() => {});
            }

            await this.userTradeModel.create({
              telegramId: sub.telegramId, chatId: sub.chatId,
              symbol: mainTrade.symbol, direction: hedgeDir,
              entryPrice: fillPrice, quantity: hedgeQty,
              leverage: mainTrade.leverage || 1, notionalUsdt: hedgeNotional,
              slPrice: 0, tpPrice: actualTpPrice || 0,
              status: 'OPEN', openedAt: new Date(),
              aiSignalId: signalId, isHedge: true,
              parentTradeId: mainTrade._id,
              hedgeCycle: (closedHedges.length || 0) + 1,
              hedgePhase: action.hedgePhase || 'FULL',
            });
            this.logger.log(`[RealHedge] Opened hedge for ${sub.telegramId} ${mainTrade.symbol} ${hedgeDir} $${hedgeNotional.toFixed(0)} @ ${fillPrice}`);
          } catch (err) {
            this.logger.error(`[RealHedge] Open FAILED for ${sub.telegramId} ${mainTrade.symbol}: ${err?.message}`);
          }
        }
      } catch (err) {
        this.logger.error(`[RealHedge] Error for ${sub.telegramId}: ${err?.message}`);
      }
    }
  }

  // ─── Hedge Event Tracking (sim-driven, kept for backward compat) ────

  /**
   * SIM controls REAL: when sim opens/closes hedge, mirror to real Binance trades.
   * This is the ONLY path for real hedge open/close (no independent checkRealHedge).
   */
  async onHedgeEvent(signal: any, action: any, price: number): Promise<void> {
    if (!action || action.action === 'NONE') return;

    const signalId = signal._id?.toString();
    if (!signalId) return;

    if (action.action === 'OPEN_FULL' || action.action === 'OPEN_PARTIAL' || action.action === 'UPGRADE_FULL') {
      // Open hedge trade for each real subscriber (Binance Hedge Mode)
      const subscribers = await this.subscriptionService.findRealModeSubscribers();
      for (const sub of subscribers) {
        try {
          // Find parent (main) trade for this signal
          const parentTrade = await this.userTradeModel.findOne({
            telegramId: sub.telegramId,
            aiSignalId: signalId,
            status: 'OPEN',
            isHedge: { $ne: true },
          });
          if (!parentTrade) continue;

          // Cancel main trade SL on Binance — hedge manages risk now
          const mainKeys = await this.userSettingsService.getApiKeys(sub.telegramId, 'binance');
          if (mainKeys?.apiKey && (parentTrade as any).binanceSlAlgoId) {
            await this.binanceService.cancelAlgoOrder(mainKeys.apiKey, mainKeys.apiSecret, (parentTrade as any).binanceSlAlgoId).catch(() => {});
            await this.userTradeModel.updateOne({ _id: parentTrade._id }, { $set: { binanceSlAlgoId: null, slPrice: 0 } }).catch(() => {});
            this.logger.log(`[UserRealTrading] Hedge open: cancelled main SL for ${sub.telegramId} ${signal.symbol}`);
          }

          // Check if hedge trade already exists
          const existingHedge = await this.userTradeModel.findOne({
            telegramId: sub.telegramId,
            aiSignalId: signalId,
            isHedge: true,
            status: 'OPEN',
          });
          if (existingHedge) continue;

          const hedgeDir = action.hedgeDirection || (signal.direction === 'LONG' ? 'SHORT' : 'LONG');
          // Use real trade's filled notional for hedge sizing (not sim notional)
          const mainEntry = (parentTrade as any).gridAvgEntry || parentTrade.entryPrice;
          const filledGridNotional = (parentTrade as any).gridLevels?.length > 0
            ? (parentTrade as any).gridLevels
                .filter((g: any) => g.status === 'FILLED')
                .reduce((s: number, g: any) => s + ((g.quantity || 0) * mainEntry), 0) || parentTrade.notionalUsdt
            : parentTrade.notionalUsdt;
          const hedgeNotional = (filledGridNotional || parentTrade.notionalUsdt) * 0.75;
          if (hedgeNotional <= 0) continue;

          const keys = await this.userSettingsService.getApiKeys(sub.telegramId, 'binance');
          if (!keys?.apiKey) continue;

          const [qtyPrec, pricePrec] = await Promise.all([
            this.getQuantityPrecision(signal.symbol),
            this.getPricePrecision(signal.symbol),
          ]);
          const hedgeQty = parseFloat((hedgeNotional / price).toFixed(qtyPrec));
          if (hedgeQty <= 0) continue;

          let fillPrice = price;
          try {
            const order = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
              symbol: signal.symbol,
              side: hedgeDir as 'LONG' | 'SHORT',
              quantity: hedgeQty,
              leverage: parentTrade.leverage || 1,
            });
            fillPrice = parseFloat(order?.avgPrice || order?.price) || price;
            this.logger.log(`[UserRealTrading] Hedge order placed on Binance: ${signal.symbol} ${hedgeDir} qty=${hedgeQty} fill=${fillPrice}`);
          } catch (err) {
            this.logger.error(`[UserRealTrading] Hedge Binance order FAILED for ${sub.telegramId} ${signal.symbol}: ${err?.message}`);
            continue; // Don't create trade record if Binance order failed
          }

          // Recalculate TP from actual fill price (slippage correction)
          const regime = (signal as any).regime || 'MIXED';
          const actualTpPrice = this.hedgeManager.getHedgeTpPrice(fillPrice, hedgeDir, regime);
          if (actualTpPrice) {
            try {
              await this.binanceService.setTakeProfitAtPrice(
                keys.apiKey, keys.apiSecret,
                signal.symbol,
                parseFloat(actualTpPrice.toFixed(pricePrec)),
                hedgeDir as 'LONG' | 'SHORT',
                hedgeQty,
              );
            } catch (err) {
              this.logger.warn(`[UserRealTrading] Hedge TP order failed: ${err?.message}`);
            }
          }

          await this.userTradeModel.create({
            telegramId: sub.telegramId,
            chatId: sub.chatId,
            symbol: signal.symbol,
            direction: hedgeDir,
            entryPrice: fillPrice,
            quantity: hedgeQty,
            leverage: parentTrade.leverage || 1,
            notionalUsdt: hedgeNotional,
            slPrice: 0,
            tpPrice: actualTpPrice || 0,
            status: 'OPEN',
            openedAt: new Date(),
            aiSignalId: signalId,
            isHedge: true,
            parentTradeId: parentTrade._id,
            hedgeCycle: (signal.hedgeCycleCount || 0) + 1,
            hedgePhase: action.hedgePhase || 'FULL',
          });

          this.logger.log(
            `[UserRealTrading] Hedge trade opened for ${sub.telegramId} | ${signal.symbol} ${hedgeDir} $${hedgeNotional.toFixed(0)} @ ${fillPrice}`,
          );
        } catch (err) {
          this.logger.error(`[UserRealTrading] Hedge open error for ${sub.telegramId}: ${err?.message}`);
        }
      }
    } else if (action.action === 'CLOSE_HEDGE') {
      const isFlip = action.hedgePhase === 'FLIP';
      // Close all open hedge trades for this signal
      const openHedges = await this.userTradeModel.find({
        aiSignalId: signalId,
        isHedge: true,
        status: 'OPEN',
      });

      for (const hedge of openHedges) {
        try {
          // Close REAL Binance hedge position
          const keys = await this.userSettingsService.getApiKeys(hedge.telegramId, 'binance');
          if (keys?.apiKey) {
            try {
              await this.binanceService.closePosition(
                keys.apiKey, keys.apiSecret,
                hedge.symbol, hedge.quantity, hedge.direction,
              );
              this.logger.log(`[UserRealTrading] Hedge Binance position closed: ${hedge.symbol} ${hedge.direction} qty=${hedge.quantity}`);
            } catch (err) {
              this.logger.error(`[UserRealTrading] Hedge Binance close FAILED for ${hedge.telegramId} ${hedge.symbol}: ${err?.message}`);
            }
          }

          const pnlPct = hedge.direction === 'LONG'
            ? ((price - hedge.entryPrice) / hedge.entryPrice) * 100
            : ((hedge.entryPrice - price) / hedge.entryPrice) * 100;
          const pnlUsdt = Math.round((pnlPct / 100) * hedge.notionalUsdt * 100) / 100;

          let closeReason = 'HEDGE_CLOSE';
          if (isFlip) closeReason = 'HEDGE_FLIP';
          else if (action.reason?.includes('Recovery')) closeReason = 'HEDGE_RECOVERY';
          else if (action.reason?.includes('trail')) closeReason = 'HEDGE_TRAIL';
          else if (action.reason?.includes('TP')) closeReason = 'HEDGE_TP';
          else if (pnlUsdt >= 0) closeReason = 'HEDGE_TP';

          await this.userTradeModel.findByIdAndUpdate(hedge._id, {
            status: 'CLOSED',
            exitPrice: price,
            pnlPercent: Math.round(pnlPct * 100) / 100,
            pnlUsdt,
            closeReason,
            closedAt: new Date(),
          });

          this.logger.log(
            `[UserRealTrading] Hedge trade closed for ${hedge.telegramId} | ${signal.symbol} PnL: ${pnlPct.toFixed(2)}% ($${pnlUsdt}) reason=${closeReason}`,
          );

          // Restore SL on main trade after hedge close (40% safety net)
          if (!isFlip && keys?.apiKey) {
            const mainTrd = await this.userTradeModel.findOne({
              telegramId: hedge.telegramId, aiSignalId: signalId,
              status: 'OPEN', isHedge: { $ne: true },
            });
            if (mainTrd) {
              const mainEntry = (mainTrd as any).gridAvgEntry || mainTrd.entryPrice;
              const slPct = 40;
              const restoredSl = mainTrd.direction === 'LONG'
                ? +(mainEntry * (1 - slPct / 100)).toFixed(6)
                : +(mainEntry * (1 + slPct / 100)).toFixed(6);
              const pp = await this.getPricePrecision(signal.symbol);
              const roundedSl = parseFloat(restoredSl.toFixed(pp));
              const slQty = mainTrd.gridLevels?.length > 0
                ? mainTrd.gridLevels.filter((g: any) => g.status === 'FILLED').reduce((s: number, g: any) => s + (g.quantity || 0), 0) || mainTrd.quantity
                : mainTrd.quantity;
              try {
                const slOrder = await this.binanceService.setStopLoss(
                  keys.apiKey, keys.apiSecret, signal.symbol, roundedSl,
                  mainTrd.direction as 'LONG' | 'SHORT', slQty,
                );
                const newSlId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: mainTrd._id }, { $set: { slPrice: roundedSl, binanceSlAlgoId: newSlId } });
                this.logger.log(`[UserRealTrading] Hedge close: restored SL $${roundedSl} for ${hedge.telegramId} ${signal.symbol}`);
              } catch (err) {
                this.logger.error(`[UserRealTrading] Hedge close: SL restore FAILED ${signal.symbol}: ${err?.message}`);
              }
            }
          }

          // FLIP: Close main trade (old direction) + open new main (flipped direction)
          if (isFlip) {
            const mainTrade = await this.userTradeModel.findOne({
              telegramId: hedge.telegramId,
              aiSignalId: signalId,
              status: 'OPEN',
              isHedge: { $ne: true },
            });
            if (mainTrade && keys?.apiKey) {
              // Close old main position on Binance
              try {
                await this.binanceService.closePosition(
                  keys.apiKey, keys.apiSecret,
                  mainTrade.symbol, mainTrade.quantity, mainTrade.direction,
                );
                this.logger.log(`[UserRealTrading] FLIP: closed main Binance position ${mainTrade.symbol} ${mainTrade.direction}`);
              } catch (err) {
                this.logger.error(`[UserRealTrading] FLIP: main close FAILED: ${err?.message}`);
              }

              // Close main trade record
              const mainPnlPct = mainTrade.direction === 'LONG'
                ? ((price - mainTrade.entryPrice) / mainTrade.entryPrice) * 100
                : ((mainTrade.entryPrice - price) / mainTrade.entryPrice) * 100;
              const mainPnlUsdt = Math.round((mainPnlPct / 100) * mainTrade.notionalUsdt * 100) / 100;

              await this.userTradeModel.findByIdAndUpdate(mainTrade._id, {
                status: 'CLOSED',
                exitPrice: price,
                pnlPercent: Math.round(mainPnlPct * 100) / 100,
                pnlUsdt: mainPnlUsdt,
                closeReason: 'FLIP',
                closedAt: new Date(),
              });

              // Open new main trade in flipped direction (hedge direction becomes new main)
              const newDirection = hedge.direction; // hedge was opposite, now becomes main
              const newNotional = mainTrade.notionalUsdt; // same volume as original main
              const [qtyPrec] = await Promise.all([this.getQuantityPrecision(signal.symbol)]);
              const newQty = parseFloat((newNotional / price).toFixed(qtyPrec));

              if (newQty > 0) {
                try {
                  const flipOrder = await this.binanceService.openPosition(keys.apiKey, keys.apiSecret, {
                    symbol: signal.symbol,
                    side: newDirection as 'LONG' | 'SHORT',
                    quantity: newQty,
                    leverage: mainTrade.leverage || 1,
                  });
                  const flipFill = parseFloat(flipOrder?.avgPrice || flipOrder?.price) || price;

                  await this.userTradeModel.create({
                    telegramId: hedge.telegramId,
                    chatId: mainTrade.chatId,
                    symbol: signal.symbol,
                    direction: newDirection,
                    entryPrice: flipFill,
                    quantity: newQty,
                    leverage: mainTrade.leverage || 1,
                    notionalUsdt: newNotional,
                    slPrice: 0,
                    tpPrice: 0,
                    status: 'OPEN',
                    openedAt: new Date(),
                    aiSignalId: signalId,
                    isHedge: false,
                    isFlipped: true,
                  });

                  this.logger.log(
                    `[UserRealTrading] FLIP: new main trade ${signal.symbol} ${newDirection} $${newNotional.toFixed(0)} @ ${flipFill}`,
                  );
                } catch (err) {
                  this.logger.error(`[UserRealTrading] FLIP: new main open FAILED: ${err?.message}`);
                }
              }
            }
          }
        } catch (err) {
          this.logger.error(`[UserRealTrading] Hedge close error for ${hedge.telegramId}: ${err?.message}`);
        }
      }
    }
  }
}
