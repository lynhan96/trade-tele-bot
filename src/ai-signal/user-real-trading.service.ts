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
import { AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios");

/** Tolerance for signal entry price vs current market price — profile-aware. */
const ENTRY_PRICE_TOLERANCE_INTRADAY = 0.01; // 1% — skip real order if price moved too far from signal entry
const ENTRY_PRICE_TOLERANCE_SWING = 0.01;    // 1% — same for swing signals

/** Redis key for caching symbol quantity precision. */
const QTY_PRECISION_KEY = (symbol: string) => `cache:binance:qty-precision:${symbol}`;
/** Redis key for caching symbol price precision (tick size decimals). */
const PRICE_PRECISION_KEY = (symbol: string) => `cache:binance:price-precision:${symbol}`;

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
  ) {}

  async onModuleInit(): Promise<void> {
    // Re-open data streams for any users with OPEN trades (bot restart recovery)
    // Delayed to allow UserDataStreamService to initialize first
    setTimeout(() => this.reRegisterOpenTradeStreams().catch(() => {}), 5_000);
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
    const currentPrice = await this.fetchCurrentPrice(symbol);
    if (!currentPrice) {
      this.logger.warn(`[RealTrading] ${symbol}: cannot fetch current price, skipping real orders`);
      return;
    }

    const priceDeviation = Math.abs(currentPrice - entryPrice) / entryPrice;
    const tolerance = params.timeframeProfile === "SWING"
      ? ENTRY_PRICE_TOLERANCE_SWING
      : ENTRY_PRICE_TOLERANCE_INTRADAY;
    if (priceDeviation > tolerance) {
      this.logger.log(
        `[RealTrading] ${symbol} price deviation ${(priceDeviation * 100).toFixed(2)}% > ${(tolerance * 100).toFixed(1)}% (${params.timeframeProfile}) — skipping real orders`,
      );
      // Notify all real-mode subscribers about the skip
      for (const sub of subscribers) {
        const msg =
          `⚠️ *Real Mode: Bo qua lenh*\n\n` +
          `${symbol} ${direction}\n` +
          `Gia tin hieu: $${entryPrice.toFixed(4)}\n` +
          `Gia hien tai: $${currentPrice.toFixed(4)}\n` +
          `Lech: ${(priceDeviation * 100).toFixed(2)}% > ${(tolerance * 100).toFixed(1)}%\n\n` +
          `_Lenh khong duoc dat do gia di qua xa diem vao._`;
        await this.telegramService.sendTelegramMessage(sub.chatId, msg).catch(() => {});
      }
      return;
    }

    // Filter out subscribers who already have an open trade on this symbol
    // (prevents duplicate positions when INTRADAY + SWING both trigger for dual-timeframe coins)
    const eligibleSubs: typeof subscribers = [];
    for (const sub of subscribers) {
      const existing = await this.userTradeModel.findOne({ telegramId: sub.telegramId, symbol, status: "OPEN" }).lean();
      if (existing) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${sub.telegramId} already has open position, skipping`);
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

    try {
      const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
      if (!keys?.apiKey) {
        this.logger.debug(`[RealTrading] ${symbol}: user ${telegramId} has no Binance API keys`);
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

      // Merge user's custom TP/SL% with AI defaults:
      // SL = wider (larger %) of user vs AI → max(userSL%, defaultSL%)
      // TP = bigger (larger %) of user vs AI → max(userTP%, defaultTP%)
      const roundPrice = (p: number) => parseFloat(p.toFixed(pricePrecision));
      const defaultSlPct = Math.abs(fillPrice - stopLossPrice) / fillPrice * 100;
      const defaultTpPct = takeProfitPrice ? Math.abs(takeProfitPrice - fillPrice) / fillPrice * 100 : 0;

      let effectiveSl = stopLossPrice;
      let effectiveTp = takeProfitPrice;
      if (sub.customSlPct) {
        const slPct = Math.max(sub.customSlPct, defaultSlPct);
        effectiveSl = direction === "LONG"
          ? fillPrice * (1 - slPct / 100)
          : fillPrice * (1 + slPct / 100);
        this.logger.debug(`[RealTrading] ${symbol} SL: user=${sub.customSlPct}%, AI=${defaultSlPct.toFixed(2)}% → using ${slPct.toFixed(2)}%`);
      }
      if (sub.customTpPct) {
        const tpPct = Math.max(sub.customTpPct, defaultTpPct);
        effectiveTp = direction === "LONG"
          ? fillPrice * (1 + tpPct / 100)
          : fillPrice * (1 - tpPct / 100);
        this.logger.debug(`[RealTrading] ${symbol} TP: user=${sub.customTpPct}%, AI=${defaultTpPct.toFixed(2)}% → using ${tpPct.toFixed(2)}%`);
      }
      const roundedSl = roundPrice(effectiveSl);
      const roundedTp = effectiveTp ? roundPrice(effectiveTp) : undefined;

      // Place SL algo order
      let binanceSlAlgoId: string | undefined;
      try {
        const slOrder = await this.binanceService.setStopLoss(
          keys.apiKey,
          keys.apiSecret,
          symbol,
          roundedSl,
          direction as "LONG" | "SHORT",
          quantity,
        );
        binanceSlAlgoId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();
      } catch (err) {
        this.logger.error(`[RealTrading] ${symbol} SL order failed for user ${telegramId}: ${err?.message}`);
        await this.telegramService.sendTelegramMessage(chatId,
          `⚠️ *Real Mode: SL Order That Bai*\n\n${symbol} — SL tai $${roundedSl} khong duoc dat.\nLoi: ${err?.message}\n\n_Hay tu dat SL tren Binance._`
        ).catch(() => {});
      }

      // Place TP algo order (if signal has TP price)
      let binanceTpAlgoId: string | undefined;
      if (roundedTp) {
        try {
          const tpOrder = await this.binanceService.setTakeProfitAtPrice(
            keys.apiKey,
            keys.apiSecret,
            symbol,
            roundedTp,
            direction as "LONG" | "SHORT",
          );
          binanceTpAlgoId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
        } catch (err) {
          this.logger.warn(`[RealTrading] ${symbol} TP order failed for user ${telegramId}: ${err?.message}`);
          await this.telegramService.sendTelegramMessage(chatId,
            `⚠️ *Real Mode: TP Order That Bai*\n\n${symbol} — TP tai $${roundedTp} khong duoc dat.\nLoi: ${err?.message}\n\n_Lenh van mo, SL van hoat dong._`
          ).catch(() => {});
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

      // Send confirmation to user
      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
      const dirEmoji = direction === "LONG" ? "📈" : "📉";
      const msg =
        `${dirEmoji} *Real Mode: Dat Lenh Thanh Cong*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Symbol: *${symbol}* ${direction}\n` +
        `So luong: *×${quantity}* (${leverage}x)\n` +
        `Gia vao: *${fmtP(fillPrice)}*\n` +
        `Stop Loss: *${fmtP(roundedSl)}*${binanceSlAlgoId ? "" : " ⚠️"}\n` +
        (roundedTp ? `Take Profit: *${fmtP(roundedTp)}*${binanceTpAlgoId ? "" : " ⚠️"}\n` : "") +
        `Volume: *${vol.toLocaleString()} USDT*`;
      await this.telegramService.sendTelegramMessage(chatId, msg).catch(() => {});

      // Register data stream to monitor fills/closings
      if (this.userDataStreamService) {
        await this.userDataStreamService.registerUser(telegramId, keys.apiKey, keys.apiSecret).catch(() => {});
      }
    } catch (err) {
      this.logger.error(`[RealTrading] ${symbol} order failed for user ${telegramId}: ${err?.message}`);
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

        // Place new SL
        const slOrder = await this.binanceService.setStopLoss(
          keys.apiKey,
          keys.apiSecret,
          symbol,
          newSlPrice,
          direction as "LONG" | "SHORT",
          trade.quantity,
        );
        const newAlgoId = slOrder?.algoId?.toString() ?? slOrder?.orderId?.toString();

        await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
          slPrice: newSlPrice,
          binanceSlAlgoId: newAlgoId,
        });

        const isBreakEven = Math.abs(newSlPrice - trade.entryPrice) / trade.entryPrice < 0.001;
        const label = isBreakEven ? "hoa von (break-even)" : "+2% profit (trailing stop)";
        const fmtP = (p: number) =>
          p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
          p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
        const msg =
          `🔒 *Real Mode: SL Duoc Chuyen*\n\n` +
          `${symbol} ${direction}\n` +
          `SL moi: *${fmtP(newSlPrice)}* (${label})`;
        await this.telegramService.sendTelegramMessage(trade.chatId, msg).catch(() => {});

        this.logger.log(
          `[RealTrading] ${symbol} SL moved to ${newSlPrice} for user ${trade.telegramId} (${label})`,
        );
      } catch (err) {
        this.logger.error(
          `[RealTrading] moveStopLoss failed for user ${trade.telegramId} ${symbol}: ${err?.message}`,
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

    await this.userTradeModel.findByIdAndUpdate((trade as any)._id, {
      status: "CLOSED",
      closeReason: reason,
      exitPrice,
      pnlPercent: pnlPct,
      pnlUsdt,
      closedAt: new Date(),
    });

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
      const exitPrice = parseFloat(closeOrder.avgPrice) || (await this.fetchCurrentPrice(symbol)) || trade.entryPrice;

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
   * Returns open trades with unrealized PnL and closed trades since start of UTC day.
   */
  async getDailyStats(telegramId: number): Promise<{
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

    const [openDocs, closedDocs, allTimeAgg] = await Promise.all([
      this.userTradeModel.find({ telegramId, status: "OPEN" }).lean(),
      this.userTradeModel.find({
        telegramId, status: "CLOSED",
        closedAt: { $gte: startOfToday },
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

    // Fetch current prices for open trades
    const openTrades = await Promise.all(openDocs.map(async (t) => {
      const currentPrice = (await this.fetchCurrentPrice(t.symbol)) ?? t.entryPrice;
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
    }));

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
        const exitPrice = parseFloat(closeOrder.avgPrice) || (await this.fetchCurrentPrice(trade.symbol)) || trade.entryPrice;

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

  // ─── Daily P&L limit crons ────────────────────────────────────────────────

  /**
   * Every 5 minutes: check daily P&L limits for real-mode users.
   * If a user's daily profit target or stop loss is hit → close all + disable real mode.
   */
  @Cron("0 */5 * * * *")
  async checkDailyLimits(): Promise<void> {
    try {
      const users = await this.subscriptionService.findRealModeSubscribersWithDailyLimits();
      if (users.length === 0) return;

      for (const user of users) {
        try {
          const stats = await this.getDailyStats(user.telegramId);
          if (stats.totalNotionalUsdt === 0) continue; // no trades today

          const pnlPct = stats.dailyPnlPct;
          const targetHit = user.realModeDailyTargetPct != null && pnlPct >= user.realModeDailyTargetPct;
          const slHit = user.realModeDailyStopLossPct != null && pnlPct <= -user.realModeDailyStopLossPct;

          if (!targetHit && !slHit) continue;

          const reason = targetHit ? "DAILY_TARGET" : "DAILY_STOP_LOSS";
          const sign = stats.totalPnlUsdt >= 0 ? "+" : "";

          // Close all open positions
          const closedCount = await this.closeAllRealPositions(user.telegramId, user.chatId, reason);

          // Disable real mode
          await this.subscriptionService.setRealMode(user.telegramId, false);
          await this.subscriptionService.setRealModeDailyDisabled(user.telegramId, new Date());

          const emoji = targetHit ? "🎯" : "🛑";
          const titleVi = targetHit ? "Dat Muc Tieu Ngay" : "Dung Lo Ngay";
          const msg =
            `${emoji} *Real Mode: ${titleVi}*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `PnL hom nay: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${pnlPct.toFixed(2)}%*)\n` +
            (targetHit ? `Muc tieu: *+${user.realModeDailyTargetPct}%*\n` : ``) +
            (slHit ? `Gioi han lo: *-${user.realModeDailyStopLossPct}%*\n` : ``) +
            (closedCount > 0 ? `Da dong: *${closedCount} lenh*\n` : ``) +
            `\nReal mode da *TAT*. Se tu dong BAT lai vao ngay mai 00:01 UTC.`;
          await this.telegramService.sendTelegramMessage(user.chatId, msg).catch(() => {});

          this.logger.log(
            `[RealTrading] Daily limit hit for user ${user.telegramId}: ${reason} — PnL ${sign}${pnlPct.toFixed(2)}%`,
          );
        } catch (err) {
          this.logger.error(`[RealTrading] checkDailyLimits error for user ${user.telegramId}: ${err?.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[RealTrading] checkDailyLimits outer error: ${err?.message}`);
    }
  }

  /**
   * At 00:01 UTC daily: re-enable real mode for users who were auto-disabled by a daily limit yesterday.
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

          const targetLine = user.realModeDailyTargetPct != null
            ? `Muc tieu: *+${user.realModeDailyTargetPct}%*\n` : ``;
          const slLine = user.realModeDailyStopLossPct != null
            ? `Gioi han lo: *-${user.realModeDailyStopLossPct}%*\n` : ``;

          const msg =
            `🌅 *Real Mode: Ngay Moi Bat Dau*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Real mode da duoc *BAT lai* cho ngay hom nay.\n` +
            targetLine + slLine +
            `\nDung /ai realmode off de tat neu can.`;
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
   * Every 3 minutes: scan all OPEN trades and ensure each has a live SL and TP on Binance.
   * If SL or TP is missing (failed at placement or silently dropped), place it immediately.
   * This protects clients from unprotected open positions.
   */
  @Cron("0 */3 * * * *")
  async protectOpenTrades(): Promise<void> {
    try {
      const openTrades = await this.userTradeModel.find({ status: "OPEN" }).exec();
      if (openTrades.length === 0) return;

      // Group by user to do one algo-order API call per user
      const byUser = new Map<number, typeof openTrades>();
      for (const trade of openTrades) {
        if (!byUser.has(trade.telegramId)) byUser.set(trade.telegramId, []);
        byUser.get(trade.telegramId)!.push(trade);
      }

      for (const [telegramId, trades] of byUser) {
        try {
          const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
          if (!keys?.apiKey) continue;

          // One call to get all open algo orders for this user
          const algoMap = await this.binanceService.getOpenAlgoOrders(keys.apiKey, keys.apiSecret);

          const ppCache = new Map<string, number>();
          const getPP = async (sym: string) => {
            if (!ppCache.has(sym)) ppCache.set(sym, await this.getPricePrecision(sym));
            return ppCache.get(sym)!;
          };

          // Fetch actual open positions on Binance to verify trades are still open
          const binancePositions = await this.binanceService.getOpenPositions(keys.apiKey, keys.apiSecret).catch(() => []);
          const openSymbols = new Set(binancePositions.map((p) => p.symbol));

          for (const trade of trades) {
            const { symbol, direction, slPrice, tpPrice, chatId } = trade;

            // Position already closed on Binance — mark trade as closed with PnL
            if (!openSymbols.has(symbol)) {
              // Skip if already closed by another handler (race condition)
              const freshTrade = await this.userTradeModel.findById((trade as any)._id);
              if (!freshTrade || freshTrade.status === "CLOSED") continue;

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

              this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: position gone on Binance — marking CLOSED (PnL: ${pnlPct.toFixed(2)}%)`);
              await this.userTradeModel.updateOne(
                { _id: (trade as any)._id },
                { $set: {
                  status: "CLOSED",
                  closeReason: "BINANCE_CLOSED",
                  closedAt: new Date(),
                  ...(exitPrice ? { exitPrice, pnlPercent: pnlPct, pnlUsdt } : {}),
                } },
              );

              // Notify user
              if (exitPrice) {
                const sign = pnlPct >= 0 ? "+" : "";
                const emoji = pnlPct >= 0 ? "✅" : "❌";
                const fmtExit = exitPrice >= 1000 ? `$${exitPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
                  exitPrice >= 1 ? `$${exitPrice.toFixed(2)}` : `$${exitPrice.toFixed(4)}`;
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

            // ── SL missing ──────────────────────────────────────────────────
            if (!algo?.hasSl) {
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: SL missing — placing at $${slPrice}`);
              try {
                const roundedSl = round(slPrice);
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
                // "GTE can only be used with open positions" means position is already closed
                if (errMsg.includes("GTE") && errMsg.includes("open positions")) {
                  this.logger.log(`[RealTrading] ${symbol} user ${telegramId}: SL failed with GTE — position closed on Binance`);
                  const exitP = this.marketDataService.getLatestPrice(symbol);
                  let pnlP = 0, pnlU = 0;
                  if (exitP && trade.entryPrice) {
                    pnlP = direction === "LONG"
                      ? ((exitP - trade.entryPrice) / trade.entryPrice) * 100
                      : ((trade.entryPrice - exitP) / trade.entryPrice) * 100;
                    pnlU = (pnlP / 100) * (trade.notionalUsdt || 0);
                  }
                  await this.userTradeModel.updateOne(
                    { _id: (trade as any)._id },
                    { $set: { status: "CLOSED", closeReason: "BINANCE_CLOSED", closedAt: new Date(),
                      ...(exitP ? { exitPrice: exitP, pnlPercent: pnlP, pnlUsdt: pnlU } : {}) } },
                  );
                  const sign = pnlP >= 0 ? "+" : "";
                  const emoji = pnlP >= 0 ? "✅" : "❌";
                  await this.telegramService.sendTelegramMessage(chatId,
                    `${emoji} *Real Mode: Lenh Da Dong*\n━━━━━━━━━━━━━━━━━━\n\n${symbol} ${direction}\nPnL: *${sign}${pnlP.toFixed(2)}% (${sign}${pnlU.toFixed(2)} USDT)*\n_Vi the da dong tren Binance (SL/TP)_`
                  ).catch(() => {});
                  continue;
                }
                this.logger.error(`[RealTrading] ${symbol} user ${telegramId}: SL re-place FAILED: ${errMsg}`);
                await this.telegramService.sendTelegramMessage(chatId,
                  `🚨 *CANH BAO: ${symbol} Khong Co SL!*\n\nKhong the tu dong dat SL tai ${fmtP(slPrice)}.\n*Hay dong lenh hoac dat SL thu cong tren Binance ngay!*\nLoi: ${errMsg}`
                ).catch(() => {});
              }
            }

            // ── TP missing ──────────────────────────────────────────────────
            if (tpPrice && !algo?.hasTp) {
              this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: TP missing — placing at $${tpPrice}`);
              try {
                const roundedTp = round(tpPrice);
                const tpOrder = await this.binanceService.setTakeProfitAtPrice(
                  keys.apiKey, keys.apiSecret, symbol, roundedTp,
                  direction as "LONG" | "SHORT",
                );
                const newId = tpOrder?.algoId?.toString() ?? tpOrder?.orderId?.toString();
                await this.userTradeModel.updateOne({ _id: trade._id }, { $set: { binanceTpAlgoId: newId } });
                await this.telegramService.sendTelegramMessage(chatId,
                  `🛡️ *Bao Ve Vi The: TP Duoc Dat Lai*\n\n${symbol} ${direction}\nTP: *${fmtP(roundedTp)}*\n_TP bi mat — da tu dong dat lai._`
                ).catch(() => {});
              } catch (err) {
                this.logger.warn(`[RealTrading] ${symbol} user ${telegramId}: TP re-place failed: ${err?.message}`);
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

  private async fetchCurrentPrice(symbol: string): Promise<number | null> {
    // Prefer the live WebSocket price (already subscribed for signal monitoring)
    const wsPrice = this.marketDataService.getLatestPrice(symbol);
    if (wsPrice && wsPrice > 0) return wsPrice;

    // Fallback: HTTP fetch if symbol not in current shortlist/WS feed
    try {
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
        { timeout: 5_000 },
      );
      return parseFloat(res.data.price);
    } catch {
      return null;
    }
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
