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
import { UserTrade, UserTradeDocument } from "../schemas/user-trade.schema";
import { DailyLimitHistory, DailyLimitHistoryDocument } from "../schemas/daily-limit-history.schema";
import { AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";
import { getProxyAgent } from "../utils/proxy";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios");

/** Max tolerance — skip order if price moved beyond this from signal entry. */
const ENTRY_PRICE_TOLERANCE = 0.01; // 1%

/** TradFi-Perps symbols that require separate Binance agreement — skip for real orders. */
const TRADFI_BLACKLIST = new Set(["XAUUSDT", "XAGUSDT", "MSTRUSDT"]);

/** Redis key for caching symbol quantity precision. */
const QTY_PRECISION_KEY = (symbol: string) => `cache:binance:qty-precision:${symbol}`;
/** Redis key for caching symbol price precision (tick size decimals). */
const PRICE_PRECISION_KEY = (symbol: string) => `cache:binance:price-precision:${symbol}`;
/** Redis lock to prevent duplicate order placement (30s TTL). */
const ORDER_LOCK_KEY = (telegramId: number, symbol: string) => `cache:order-lock:${telegramId}:${symbol}`;
/** Redis counter for atomic position slot reservation. */
const POS_SLOT_KEY = (telegramId: number) => `cache:pos-slots:${telegramId}`;
/** Redis key for temporarily blacklisting closed/errored symbols (1h TTL). */
const CLOSED_SYMBOL_KEY = (symbol: string) => `cache:closed-symbol:${symbol}`;

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
    @InjectModel(UserTrade.name)
    private readonly userTradeModel: Model<UserTradeDocument>,
    @InjectModel(DailyLimitHistory.name)
    private readonly dailyLimitHistoryModel: Model<DailyLimitHistoryDocument>,
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

    // Filter out subscribers who already have an open trade on this symbol
    const eligibleSubs: typeof subscribers = [];
    for (const sub of subscribers) {
      // Skip users whose cycle is paused (target hit — let existing positions ride)
      if (sub.cyclePaused) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${sub.telegramId} cycle paused, skipping new trade`);
        continue;
      }

      const existing = await this.userTradeModel.findOne({ telegramId: sub.telegramId, symbol, status: "OPEN" }).lean();
      if (existing) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${sub.telegramId} already has open position, skipping`);
        continue;
      }

      // Atomic position slot reservation via Redis Lua script (prevents race condition)
      const maxPos = sub.maxOpenPositions ?? 10;
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

    const lockKey = ORDER_LOCK_KEY(telegramId, symbol);
    try {
      // Redis lock to prevent duplicate orders when INTRADAY + SWING fire simultaneously
      const acquired = await this.redisService.setNX(lockKey, "1", 30);
      if (!acquired) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} order lock active, skipping duplicate`);
        await this.redisService.decr(slotKey); // release reserved slot
        return;
      }

      const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
      if (!keys?.apiKey) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} has no Binance API keys`);
        await this.redisService.decr(slotKey);
        return;
      }

      // Double-check: no existing Binance position on this symbol (race condition guard)
      try {
        const positions = await this.binanceService.getOpenPositions(keys.apiKey, keys.apiSecret);
        const existing = positions.find(p => p.symbol === symbol && p.quantity !== 0);
        if (existing) {
          this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} already has Binance position (qty=${existing.quantity}), skipping`);
          await this.redisService.decr(slotKey);
          return;
        }
      } catch (err) {
        this.logger.warn(`[RealTrading] ${symbol}: failed to check positions for user ${telegramId}: ${err?.message}`);
      }

      // Final DB-level dedup: ensure no existing OPEN trade for this symbol BEFORE placing any order
      const existingTrade = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN" });
      if (existingTrade) {
        this.logger.warn(`[RealTrading] ${symbol}: user ${telegramId} already has OPEN trade in DB, skipping`);
        await this.redisService.decr(slotKey);
        return;
      }

      const leverage = await this.resolveLeverage(sub, params, keys.apiKey, keys.apiSecret, symbol);
      const vol = this.getVolForSymbol(symbol, sub.coinVolumes, sub.tradingBalance);
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

      // Custom TP/SL: if user has set custom %, always use their exact value
      const roundPrice = (p: number) => parseFloat(p.toFixed(pricePrecision));

      let effectiveSl = stopLossPrice;
      let effectiveTp = takeProfitPrice;
      if (sub.customSlPct) {
        effectiveSl = direction === "LONG"
          ? fillPrice * (1 - sub.customSlPct / 100)
          : fillPrice * (1 + sub.customSlPct / 100);
        this.logger.debug(`[RealTrading] ${symbol} SL: using user config ${sub.customSlPct}%`);
      }
      if (sub.customTpPct) {
        effectiveTp = direction === "LONG"
          ? fillPrice * (1 + sub.customTpPct / 100)
          : fillPrice * (1 - sub.customTpPct / 100);
        this.logger.debug(`[RealTrading] ${symbol} TP: using user config ${sub.customTpPct}%`);
      }
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
      });

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
        `Volume: *${vol.toLocaleString()} USDT*`;
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
    const openTrades = await this.userTradeModel.find({ symbol, status: "OPEN" }).lean();
    if (openTrades.length === 0) return;

    // Round price to exchange precision before placing orders
    const pricePrecision = await this.getPricePrecision(symbol);
    const roundedSlPrice = parseFloat(newSlPrice.toFixed(pricePrecision));

    for (const trade of openTrades) {
      try {
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
            keys.apiKey, keys.apiSecret, symbol, finalSlPrice, direction as "LONG" | "SHORT", trade.quantity,
          );
        } catch (slErr) {
          if (slErr?.message?.includes("Precision")) {
            const freshPrec = await this.refreshPricePrecision(symbol);
            finalSlPrice = parseFloat(newSlPrice.toFixed(freshPrec));
            this.logger.warn(`[RealTrading] ${symbol} SL precision retry: ${roundedSlPrice} → ${finalSlPrice}`);
            slOrder = await this.binanceService.setStopLoss(
              keys.apiKey, keys.apiSecret, symbol, finalSlPrice, direction as "LONG" | "SHORT", trade.quantity,
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
        const label = isBreakEven ? "hoa von (break-even)" : "+2% profit (trailing stop)";
        const fmtP = (p: number) =>
          p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
          p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
        const msg =
          `🔒 *Real Mode: SL Duoc Chuyen*\n\n` +
          `${symbol} ${direction}\n` +
          `SL moi: *${fmtP(roundedSlPrice)}* (${label})`;
        await this.telegramService.sendTelegramMessage(trade.chatId, msg).catch(() => {});

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
    const openTrades = await this.userTradeModel.find({ symbol, status: "OPEN" }).lean();
    if (openTrades.length === 0) return;

    const pricePrecision = await this.getPricePrecision(symbol);
    const roundedTpPrice = parseFloat(newTpPrice.toFixed(pricePrecision));

    for (const trade of openTrades) {
      try {
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
            keys.apiKey, keys.apiSecret, symbol, finalTpPrice, direction as "LONG" | "SHORT", trade.quantity,
          );
        } catch (tpErr) {
          if (tpErr?.message?.includes("Precision")) {
            const freshPrec = await this.refreshPricePrecision(symbol);
            finalTpPrice = parseFloat(newTpPrice.toFixed(freshPrec));
            this.logger.warn(`[RealTrading] ${symbol} TP precision retry: ${roundedTpPrice} → ${finalTpPrice}`);
            tpOrder = await this.binanceService.setTakeProfitAtPrice(
              keys.apiKey, keys.apiSecret, symbol, finalTpPrice, direction as "LONG" | "SHORT", trade.quantity,
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
  ): Promise<void> {
    // Also handle trades that were marked CLOSED by protectOpenTrades but without PnL
    let trade = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN" });
    if (!trade) {
      trade = await this.userTradeModel.findOne({
        telegramId, symbol, status: "CLOSED", pnlUsdt: { $in: [null, undefined, 0] },
        closedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // within last 5 min
      });
      if (!trade) return;
    }

    const pnlPct =
      trade.direction === "LONG"
        ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
    const pnlUsdt = (pnlPct / 100) * trade.notionalUsdt;

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

    // Accumulate cumulative PnL on user subscription
    await this.subscriptionService.incrementTradePnl(trade.telegramId, pnlUsdt);

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
    const trade = await this.userTradeModel.findOne({ telegramId, symbol, status: "OPEN" }).lean();
    if (!trade) return { success: false };

    const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
    if (!keys?.apiKey) return { success: false };

    try {
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

      const pnlPct = trade.direction === "LONG"
        ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
      const pnlUsdt = (pnlPct / 100) * trade.notionalUsdt;

      await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
        status: "CLOSED",
        closeReason: reason,
        exitPrice,
        pnlPercent: pnlPct,
        pnlUsdt,
        closedAt: new Date(),
      });

      await this.subscriptionService.incrementTradePnl(telegramId, pnlUsdt);

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
      const unrealizedPnlPct = t.direction === "LONG"
        ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
        : ((t.entryPrice - currentPrice) / t.entryPrice) * 100;
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
      const unrealizedPnlPct = t.direction === "LONG"
        ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
        : ((t.entryPrice - currentPrice) / t.entryPrice) * 100;
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
        // Cancel existing SL algo order
        if (trade.binanceSlAlgoId) {
          await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId).catch(() => {});
        }
        // Cancel existing TP algo order
        if (trade.binanceTpAlgoId) {
          await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceTpAlgoId).catch(() => {});
        }

        // Place reduce-only market order to close
        const closeOrder = await this.binanceService.closePosition(
          keys.apiKey, keys.apiSecret, trade.symbol, trade.quantity, trade.direction,
        );
        const exitPrice = parseFloat(closeOrder.avgPrice) || (await this.marketDataService.getPrice(trade.symbol)) || trade.entryPrice;

        const pnlPct = trade.direction === "LONG"
          ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
          : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
        const pnlUsdt = (pnlPct / 100) * trade.notionalUsdt;

        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
          status: "CLOSED",
          closeReason: reason,
          exitPrice,
          pnlPercent: pnlPct,
          pnlUsdt,
          closedAt: new Date(),
        });

        await this.subscriptionService.incrementTradePnl(telegramId, pnlUsdt);

        this.logger.log(
          `[RealTrading] closeAllRealPositions: closed ${trade.symbol} ${trade.direction} @ ${exitPrice} for user ${telegramId} (${reason})`,
        );
        closed++;
      } catch (err) {
        this.logger.error(
          `[RealTrading] closeAllRealPositions error ${trade.symbol} for user ${telegramId}: ${err?.message}`,
        );
      }
    }
    return closed;
  }

  // ─── Cycle P&L limit crons ───────────────────────────────────────────────

  /** Trailing floor ratio: lock profits when PnL drops to 60% of peak. */
  private readonly TRAILING_FLOOR_RATIO = 0.6;

  /**
   * Every 1 minute: check cycle P&L limits for real-mode users.
   * PAUSE: when PnL >= target → stop opening new trades, let existing ride
   * LOCK:  when PnL drops to 60% of peak after PAUSE → close all, reset cycle
   * SL:    when PnL <= -stopLoss → close all, disable real mode
   */
  @Cron("0 */1 * * * *")
  async checkCycleLimits(): Promise<void> {
    try {
      const users = await this.subscriptionService.findRealModeSubscribersWithCycleLimits();
      if (users.length === 0) return;

      for (const user of users) {
        try {
          const stats = await this.getCycleStats(user.telegramId, user.cycleResetAt);
          if (stats.totalNotionalUsdt === 0 && stats.openTrades.length === 0) continue;

          const balance = user.tradingBalance || 1000;
          const pnlPct = (stats.totalPnlUsdt / balance) * 100;
          const target = user.realModeDailyTargetPct;
          const slLimit = user.realModeDailyStopLossPct;
          const peak = user.cyclePeakPct ?? 0;
          const paused = user.cyclePaused === true;

          // ── Always track peak (before target hit too) ──
          if (pnlPct > peak && pnlPct > 0) {
            await this.subscriptionService.setCyclePeakPct(user.telegramId, pnlPct);
          }

          // ── SL check (always active) ──
          if (slLimit != null && pnlPct <= -slLimit) {
            const closedCount = await this.closeAllRealPositions(user.telegramId, user.chatId, "CYCLE_STOP_LOSS");
            await this.dailyLimitHistoryModel.create({
              telegramId: user.telegramId, username: user.username,
              type: "CYCLE_STOP_LOSS", pnlUsdt: stats.totalPnlUsdt, pnlPct,
              limitPct: slLimit, positionsClosed: closedCount, triggeredAt: new Date(),
            });
            await this.subscriptionService.setRealMode(user.telegramId, false);
            await this.subscriptionService.setRealModeDailyDisabled(user.telegramId, new Date());
            await this.subscriptionService.setCycleResetAt(user.telegramId, null);

            const sign = stats.totalPnlUsdt >= 0 ? "+" : "";
            const msg =
              `🛑 *Cycle SL: Dung Lo*\n` +
              `━━━━━━━━━━━━━━━━━━\n\n` +
              `Cycle PnL: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${pnlPct.toFixed(2)}%*)\n` +
              `Gioi han: *-${slLimit}%*\n` +
              (closedCount > 0 ? `Da dong: *${closedCount} lenh*\n` : ``) +
              `\nReal mode da *TAT*. Se tu dong BAT lai vao ngay mai 00:01 UTC.`;
            await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});
            this.logger.log(`[RealTrading] Cycle SL for user ${user.telegramId}: ${pnlPct.toFixed(2)}%`);
            continue;
          }

          if (target == null) continue;

          // ── PAUSE: target hit → stop new trades ──
          if (!paused && pnlPct >= target) {
            await this.subscriptionService.setCyclePaused(user.telegramId, true);

            const sign = stats.totalPnlUsdt >= 0 ? "+" : "";
            const floor = (pnlPct * this.TRAILING_FLOOR_RATIO).toFixed(2);
            const msg =
              `🎯 *Cycle Target: Dat Muc Tieu!*\n` +
              `━━━━━━━━━━━━━━━━━━\n\n` +
              `Cycle PnL: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${pnlPct.toFixed(2)}%*)\n` +
              `Muc tieu: *+${target}%* ✅\n\n` +
              `Bot *NGUNG mo lenh moi*.\n` +
              `Lenh dang mo se tiep tuc chay TP/SL rieng.\n` +
              `Trailing floor: *+${floor}%* — dong tat ca neu PnL giam ve muc nay.`;
            await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});
            this.logger.log(`[RealTrading] Cycle PAUSE for user ${user.telegramId}: ${pnlPct.toFixed(2)}% (target ${target}%)`);
            continue;
          }

          // ── Already paused: check trailing floor ──
          if (paused) {
            // Check trailing floor: close all when PnL drops to 60% of peak
            const floor = peak * this.TRAILING_FLOOR_RATIO;
            if (pnlPct <= floor) {
              const closedCount = await this.closeAllRealPositions(user.telegramId, user.chatId, "CYCLE_TARGET");
              await this.dailyLimitHistoryModel.create({
                telegramId: user.telegramId, username: user.username,
                type: "CYCLE_TARGET", pnlUsdt: stats.totalPnlUsdt, pnlPct,
                limitPct: target, positionsClosed: closedCount, triggeredAt: new Date(),
              });
              // Reset cycle — new cycle starts fresh
              const resetAt = new Date(Date.now() + 1000);
              await this.subscriptionService.setCycleResetAt(user.telegramId, resetAt);

              const sign = stats.totalPnlUsdt >= 0 ? "+" : "";
              const msg =
                `🔒 *Cycle Lock: Khoa Loi Nhuan*\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `Cycle PnL: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${pnlPct.toFixed(2)}%*)\n` +
                `Peak: *+${peak.toFixed(2)}%* · Floor: *+${floor.toFixed(2)}%*\n` +
                (closedCount > 0 ? `Da dong: *${closedCount} lenh*\n` : ``) +
                `\nCycle moi bat dau — bot tiep tuc mo lenh.`;
              await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});
              this.logger.log(`[RealTrading] Cycle LOCK for user ${user.telegramId}: ${pnlPct.toFixed(2)}% (peak ${peak.toFixed(2)}%, floor ${floor.toFixed(2)}%)`);
            }

            // If all positions closed naturally (TP/SL) while paused, reset cycle
            if (stats.openTrades.length === 0 && paused) {
              const resetAt = new Date(Date.now() + 1000);
              await this.subscriptionService.setCycleResetAt(user.telegramId, resetAt);

              const sign = stats.totalPnlUsdt >= 0 ? "+" : "";
              const msg =
                `✅ *Cycle Hoan Tat*\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `Tat ca lenh da dong.\n` +
                `Cycle PnL: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${pnlPct.toFixed(2)}%*)\n` +
                `Peak: *+${(peak).toFixed(2)}%*\n\n` +
                `Cycle moi bat dau — bot tiep tuc mo lenh.`;
              await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});
              this.logger.log(`[RealTrading] Cycle complete (all closed) for user ${user.telegramId}`);
            }
          }
        } catch (err) {
          this.logger.error(`[RealTrading] checkCycleLimits error for user ${user.telegramId}: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[RealTrading] checkCycleLimits outer error: ${err?.message}`);
    }
  }

  /**
   * At 00:01 UTC daily: re-enable real mode for users who were auto-disabled by cycle SL yesterday.
   * Also resets cycle so they start fresh.
   */
  @Cron("0 1 0 * * *")
  async resetDailyLimits(): Promise<void> {
    try {
      const users = await this.subscriptionService.findUsersForDailyReset();
      if (users.length === 0) return;

      for (const user of users) {
        try {
          await this.subscriptionService.setRealMode(user.telegramId, true);
          await this.subscriptionService.setRealModeDailyDisabled(user.telegramId, null);
          await this.subscriptionService.setCycleResetAt(user.telegramId, new Date());

          const targetLine = user.realModeDailyTargetPct != null
            ? `Muc tieu: *+${user.realModeDailyTargetPct}%*\n` : ``;
          const slLine = user.realModeDailyStopLossPct != null
            ? `Gioi han lo: *-${user.realModeDailyStopLossPct}%*\n` : ``;

          const msg =
            `🌅 *Real Mode: Ngay Moi Bat Dau*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Real mode da duoc *BAT lai* cho ngay hom nay.\n` +
            `Cycle moi bat dau.\n` +
            targetLine + slLine +
            `\nDung /ai off de tat neu can.`;
          await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});

          this.logger.log(`[RealTrading] Daily reset: re-enabled real mode for user ${user.telegramId}`);
        } catch (err) {
          this.logger.error(`[RealTrading] resetDailyLimits error for user ${user.telegramId}: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[RealTrading] resetDailyLimits outer error: ${err?.message}`);
    }
  }

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
   * Every 3 minutes: scan all OPEN trades and ensure each has a live SL and TP on Binance.
   * If SL or TP is missing (failed at placement or silently dropped), place it immediately.
   * This protects clients from unprotected open positions.
   */
  @Cron("*/30 * * * * *")
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
          const algoMap = await this.binanceService.getOpenAlgoOrders(keys.apiKey, keys.apiSecret);

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
          const openSymbols = new Set(binancePositions.map((p) => p.symbol));

          // Dedup: only process one OPEN trade per symbol (close duplicates silently)
          const seenSymbols = new Set<string>();
          const dedupedTrades: typeof trades = [];
          for (const trade of trades) {
            if (seenSymbols.has(trade.symbol)) {
              this.logger.warn(`[RealTrading] ${trade.symbol} user ${telegramId}: closing duplicate OPEN trade record`);
              await this.userTradeModel.updateOne(
                { _id: (trade as any)._id },
                { $set: { status: "CLOSED", closeReason: "DUPLICATE", closedAt: new Date() } },
              );
              continue;
            }
            seenSymbols.add(trade.symbol);
            dedupedTrades.push(trade);
          }

          for (const trade of dedupedTrades) {
            const { symbol, direction, slPrice, tpPrice, chatId } = trade;

            // Position already closed on Binance — mark trade as closed with PnL
            if (!openSymbols.has(symbol)) {
              // Calculate PnL using latest price (best approximation of exit price)
              let exitPrice = this.marketDataService.getLatestPrice(symbol);
              let pnlPct = 0;
              let pnlUsdt = 0;
              if (exitPrice && trade.entryPrice) {
                pnlPct = direction === "LONG"
                  ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
                  : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;
                pnlUsdt = (pnlPct / 100) * (trade.notionalUsdt || 0);
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

              this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: position gone on Binance — marking CLOSED (PnL: ${pnlPct.toFixed(2)}%)`);

              // Notify user
              if (exitPrice) {
                const sign = pnlPct >= 0 ? "+" : "";
                const emoji = pnlPct >= 0 ? "✅" : "❌";
                await this.telegramService.sendTelegramMessage(chatId,
                  `${emoji} *Real Mode: Lenh Da Dong*\n━━━━━━━━━━━━━━━━━━\n\n${symbol} ${direction}\nPnL: *${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsdt.toFixed(2)} USDT)*\n_Vi the da dong tren Binance_`
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

            // ── Auto SL to entry at 3% profit ──────────────────────────────
            // If trade is 3%+ in profit, move SL to entry (break-even) for protection
            const currentPrice = this.marketDataService.getLatestPrice(symbol);
            if (currentPrice && trade.entryPrice) {
              const currentPnlPct = direction === "LONG"
                ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
                : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;
              if (currentPnlPct >= 3 && slPrice && slPrice !== trade.entryPrice) {
                // SL should be at entry — price has moved 3%+ in our favor
                const roundedEntry = round(trade.entryPrice);
                this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: PnL ${currentPnlPct.toFixed(1)}% >= 3% — moving SL to entry ${roundedEntry}`);
                try {
                  if (trade.binanceSlAlgoId) {
                    await this.binanceService.cancelAlgoOrder(keys.apiKey, keys.apiSecret, trade.binanceSlAlgoId);
                  }
                  const slOrder = await this.binanceService.setStopLoss(
                    keys.apiKey, keys.apiSecret, symbol, roundedEntry,
                    direction as "LONG" | "SHORT", trade.quantity,
                  );
                  const newId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                  await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { slPrice: roundedEntry, binanceSlAlgoId: newId } });
                  await this.telegramService.sendTelegramMessage(chatId,
                    `🛡️ *Bao Ve Vi The: SL -> Entry*\n\n${symbol} ${direction}\nSL moi: *${fmtP(roundedEntry)}* (hoa von)\nPnL: *+${currentPnlPct.toFixed(1)}%*`
                  ).catch(() => {});
                } catch (err) {
                  this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: SL-to-entry failed: ${err?.message}`);
                }
                continue; // SL handled — skip the missing SL check below
              }
            }

            // ── SL missing ──────────────────────────────────────────────────
            // If slPrice not in trade record, compute from user's customSlPct
            let effectiveSlPrice = slPrice;
            if (!effectiveSlPrice && sub?.customSlPct && trade.entryPrice) {
              effectiveSlPrice = direction === "LONG"
                ? trade.entryPrice * (1 - sub.customSlPct / 100)
                : trade.entryPrice * (1 + sub.customSlPct / 100);
              await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { slPrice: effectiveSlPrice } });
            }
            if (!algo?.hasSl && effectiveSlPrice) {
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: SL missing — placing at $${effectiveSlPrice}`);
              try {
                const roundedSl = round(effectiveSlPrice);
                const slOrder = await this.binanceService.setStopLoss(
                  keys.apiKey, keys.apiSecret, symbol, roundedSl,
                  direction as "LONG" | "SHORT", trade.quantity,
                );
                const newId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { binanceSlAlgoId: newId } });
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
            // If tpPrice not in trade record, compute from user's customTpPct
            let effectiveTpPrice = tpPrice;
            if (!effectiveTpPrice && sub?.customTpPct && trade.entryPrice) {
              effectiveTpPrice = direction === "LONG"
                ? trade.entryPrice * (1 + sub.customTpPct / 100)
                : trade.entryPrice * (1 - sub.customTpPct / 100);
              // Save computed TP back to trade record
              await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { tpPrice: effectiveTpPrice } });
            }
            if (effectiveTpPrice && !algo?.hasTp) {
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: TP missing — placing at $${effectiveTpPrice}`);
              try {
                const roundedTp = round(effectiveTpPrice);
                const tpOrder = await this.binanceService.setTakeProfitAtPrice(
                  keys.apiKey, keys.apiSecret, symbol, roundedTp,
                  direction as "LONG" | "SHORT",
                  trade.quantity,
                );
                const newId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { binanceTpAlgoId: newId } });
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

  // ─── Private helpers ──────────────────────────────────────────────────────

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

  private getVolForSymbol(
    symbol: string,
    coinVolumes?: Record<string, number>,
    tradingBalance?: number,
  ): number {
    const base = symbol.replace(/USDT$/, "");
    return coinVolumes?.[base] ?? coinVolumes?.[symbol] ?? tradingBalance ?? 1000;
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
}
