import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require("ws");
import { RedisService } from "../redis/redis.service";
import {
  CandleHistory,
  CandleHistoryDocument,
} from "./schemas/candle-history.schema";

export interface KlineCloseEvent {
  symbol: string;
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: boolean;
  closeTime: number;
}

export interface Ticker24h {
  symbol: string;
  priceChangePercent: string; // e.g. "3.45"
  quoteVolume: string; // USD volume
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
}

const CANDLE_MAX_LENGTH = 500;
// Base URL for Binance USDT futures WebSocket
const WS_BASE = "wss://fstream.binance.com/stream?streams=";

@Injectable()
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);

  // ws: symbol → WebSocket instance (typed as any since we use require("ws"))
  private wsSockets = new Map<string, any>();
  // Current subscribed coins
  private subscribedCoins = new Set<string>();
  // Intervals to subscribe per coin (5m/15m/1h for intraday, 4h/1d for swing)
  private readonly intervals = ["5m", "15m", "1h", "4h", "1d"];

  // Reconnect timers
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  // Real-time price listeners: symbol → Set of callbacks
  // Callbacks are fired on every kline tick (including non-final) at ~250ms resolution.
  private priceListeners = new Map<string, Set<(price: number) => void>>();

  // Shutdown flag to prevent Redis calls during module destroy
  private isShuttingDown = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    @InjectModel(CandleHistory.name)
    private readonly candleHistoryModel: Model<CandleHistoryDocument>,
  ) {}

  async onModuleInit() {
    this.logger.log(
      "[MarketData] Module init — waiting for shortlist before subscribing",
    );
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    this.closeAllSockets();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Called by CoinFilterService when the shortlist changes.
   * Subscribes to new coins and unsubscribes from removed ones.
   */
  async updateSubscriptions(newCoins: string[]): Promise<void> {
    const newSet = new Set(newCoins.map((c) => c.toUpperCase()));

    // Unsubscribe removed coins
    for (const coin of this.subscribedCoins) {
      if (!newSet.has(coin)) {
        this.unsubscribeCoin(coin);
      }
    }

    // Subscribe new coins
    for (const coin of newSet) {
      if (!this.subscribedCoins.has(coin)) {
        await this.subscribeCoin(coin);
      }
    }

    this.subscribedCoins = newSet;
    this.logger.log(
      `[MarketData] Subscribed to ${newSet.size} coins: ${[...newSet].join(", ")}`,
    );
  }

  /**
   * Fetch 24h ticker data for all USDT futures pairs and store in Redis.
   * Called every 5 minutes by CoinFilterService.
   */
  async fetchAndCacheTicker24h(): Promise<Ticker24h[]> {
    const axios = require("axios");
    try {
      const url = "https://fapi.binance.com/fapi/v1/ticker/24hr";
      const res = await axios.get(url, { timeout: 10000 });
      const tickers: Ticker24h[] = res.data;

      // Cache for 6 minutes (so it's always fresh for 5min refresh)
      await this.redisService.set("cache:market:scan", tickers, 360);
      this.logger.log(`[MarketData] Cached ${tickers.length} tickers`);
      return tickers;
    } catch (err) {
      this.logger.error(
        "[MarketData] Failed to fetch 24hr tickers",
        err?.message,
      );
      return [];
    }
  }

  /**
   * Get OHLC close-price array for a coin+interval from Redis.
   * Returns up to CANDLE_MAX_LENGTH values, oldest first.
   */
  async getClosePrices(coin: string, interval: string): Promise<number[]> {
    return (
      (await this.redisService.get<number[]>(
        `cache:candle:close:${coin.toUpperCase()}:${interval}`,
      )) || []
    );
  }

  async getOpenPrices(coin: string, interval: string): Promise<number[]> {
    return (
      (await this.redisService.get<number[]>(
        `cache:candle:open:${coin.toUpperCase()}:${interval}`,
      )) || []
    );
  }

  async getHighPrices(coin: string, interval: string): Promise<number[]> {
    return (
      (await this.redisService.get<number[]>(
        `cache:candle:high:${coin.toUpperCase()}:${interval}`,
      )) || []
    );
  }

  async getLowPrices(coin: string, interval: string): Promise<number[]> {
    return (
      (await this.redisService.get<number[]>(
        `cache:candle:low:${coin.toUpperCase()}:${interval}`,
      )) || []
    );
  }

  // ─── Real-time price listener registry ───────────────────────────────────

  /**
   * Register a callback to receive live price ticks for a symbol.
   * The callback fires on every kline message (~250ms resolution for futures).
   * Used by PositionMonitorService for real-time TP/SL checking.
   */
  registerPriceListener(symbol: string, cb: (price: number) => void): void {
    if (!this.priceListeners.has(symbol)) {
      this.priceListeners.set(symbol, new Set());
    }
    this.priceListeners.get(symbol)!.add(cb);
  }

  unregisterPriceListener(symbol: string, cb: (price: number) => void): void {
    this.priceListeners.get(symbol)?.delete(cb);
  }

  // ─── Internal: WebSocket subscription ────────────────────────────────────

  private async subscribeCoin(coin: string): Promise<void> {
    // One WebSocket per coin, combining all intervals into a combined stream
    const streams = this.intervals
      .map((i) => `${coin.toLowerCase()}usdt@kline_${i}`)
      .join("/");
    const wsKey = coin.toUpperCase();

    if (this.wsSockets.has(wsKey)) return; // already connected

    const wsUrl = `${WS_BASE}${streams}`;
    this.openSocket(wsKey, wsUrl, coin);

    // Seed candle history from REST API (so indicators can compute immediately)
    await this.seedCandleHistory(coin);
  }

  private unsubscribeCoin(coin: string): void {
    const wsKey = coin.toUpperCase();
    const ws = this.wsSockets.get(wsKey);
    if (ws) {
      ws.terminate();
      this.wsSockets.delete(wsKey);
    }
    if (this.reconnectTimers.has(wsKey)) {
      clearTimeout(this.reconnectTimers.get(wsKey));
      this.reconnectTimers.delete(wsKey);
    }
    this.logger.log(`[MarketData] Unsubscribed ${coin}`);
  }

  private openSocket(wsKey: string, wsUrl: string, coin: string): void {
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      this.logger.log(`[MarketData] WS connected for ${coin}`);
    });

    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        // Combined stream: { stream: "btcusdt@kline_15m", data: { ... } }
        if (msg.data && msg.data.e === "kline") {
          this.handleKlineMessage(msg.data);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on("error", (err) => {
      this.logger.warn(`[MarketData] WS error for ${coin}: ${err?.message}`);
    });

    ws.on("close", () => {
      this.logger.warn(
        `[MarketData] WS closed for ${coin}, scheduling reconnect...`,
      );
      this.wsSockets.delete(wsKey);
      // Reconnect after 5 seconds
      const timer = setTimeout(() => {
        if (this.subscribedCoins.has(coin.toUpperCase())) {
          this.logger.log(`[MarketData] Reconnecting WS for ${coin}`);
          this.openSocket(wsKey, wsUrl, coin);
        }
      }, 5000);
      this.reconnectTimers.set(wsKey, timer);
    });

    this.wsSockets.set(wsKey, ws);
  }

  private async handleKlineMessage(klineData: any): Promise<void> {
    if (this.isShuttingDown) return;

    const { s: symbol, k } = klineData;
    const {
      i: interval,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
      x: isFinal,
      T: closeTime,
    } = k;

    // Emit live price to registered listeners on every tick (including non-final).
    // This is used by PositionMonitorService for real-time TP/SL checking (~250ms resolution).
    const currentPrice = parseFloat(close);
    this.priceListeners.get(symbol)?.forEach((cb) => cb(currentPrice));

    // Only process when candle is CLOSED (isFinal = true)
    if (!isFinal) return;

    const coin = symbol.replace("USDT", "");
    const closePrice = parseFloat(close);
    const openPrice = parseFloat(open);
    const highPrice = parseFloat(high);
    const lowPrice = parseFloat(low);
    const volumeValue = parseFloat(volume);

    await Promise.all([
      this.appendToArray(`cache:candle:close:${coin}:${interval}`, closePrice),
      this.appendToArray(`cache:candle:open:${coin}:${interval}`, openPrice),
      this.appendToArray(`cache:candle:high:${coin}:${interval}`, highPrice),
      this.appendToArray(`cache:candle:low:${coin}:${interval}`, lowPrice),
    ]);

    // Persist to MongoDB for long-term analysis and debugging.
    // Fire-and-forget — never block the indicator computation path.
    const closeDate = new Date(closeTime);
    this.candleHistoryModel
      .updateOne(
        { symbol, interval, closeTime: closeDate },
        {
          $setOnInsert: {
            symbol,
            interval,
            closeTime: closeDate,
            open: openPrice,
            high: highPrice,
            low: lowPrice,
            close: closePrice,
            volume: volumeValue,
          },
        },
        { upsert: true },
      )
      .catch((err) =>
        this.logger.error(
          `[MarketData] CandleHistory upsert failed: ${err?.message}`,
        ),
      );
  }

  /**
   * Append a value to a cached array, keeping only the last CANDLE_MAX_LENGTH entries.
   */
  private async appendToArray(key: string, value: number): Promise<void> {
    const arr = (await this.redisService.get<number[]>(key)) || [];
    arr.push(value);
    if (arr.length > CANDLE_MAX_LENGTH) {
      arr.splice(0, arr.length - CANDLE_MAX_LENGTH);
    }
    // 7-day TTL — refreshed on every candle close
    await this.redisService.set(key, arr, 7 * 24 * 60 * 60);
  }

  /**
   * Seed candle history for a coin from Binance REST API.
   * Called once on first subscription so indicators can work immediately.
   */
  private async seedCandleHistory(coin: string): Promise<void> {
    const axios = require("axios");
    const symbol = `${coin.toUpperCase()}USDT`;

    for (const interval of this.intervals) {
      try {
        const closeKey = `cache:candle:close:${coin}:${interval}`;
        const existing = await this.redisService.get<number[]>(closeKey);
        if (existing && existing.length >= 200) {
          continue; // already seeded
        }

        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=500`;
        const res = await axios.get(url, { timeout: 15000 });
        const candles: any[] = res.data;

        const closes = candles.map((c) => parseFloat(c[4]));
        const opens = candles.map((c) => parseFloat(c[1]));
        const highs = candles.map((c) => parseFloat(c[2]));
        const lows = candles.map((c) => parseFloat(c[3]));

        const ttl = 7 * 24 * 60 * 60;
        await Promise.all([
          this.redisService.set(
            `cache:candle:close:${coin}:${interval}`,
            closes,
            ttl,
          ),
          this.redisService.set(
            `cache:candle:open:${coin}:${interval}`,
            opens,
            ttl,
          ),
          this.redisService.set(
            `cache:candle:high:${coin}:${interval}`,
            highs,
            ttl,
          ),
          this.redisService.set(
            `cache:candle:low:${coin}:${interval}`,
            lows,
            ttl,
          ),
        ]);

        // Bulk-upsert historical candles to MongoDB (idempotent — safe to re-run).
        // REST candle array layout: [openTime, open, high, low, close, volume, closeTime, ...]
        const ops = candles.map((c: any[]) => ({
          updateOne: {
            filter: {
              symbol,
              interval,
              closeTime: new Date(Number(c[6])),
            },
            update: {
              $setOnInsert: {
                symbol,
                interval,
                closeTime: new Date(Number(c[6])),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5]),
              },
            },
            upsert: true,
          },
        }));
        this.candleHistoryModel
          .bulkWrite(ops, { ordered: false })
          .catch((err) =>
            this.logger.warn(
              `[MarketData] Seed bulkWrite partial error for ${symbol} ${interval}: ${err?.message}`,
            ),
          );

        this.logger.log(
          `[MarketData] Seeded ${candles.length} candles for ${symbol} ${interval}`,
        );
      } catch (err) {
        this.logger.warn(
          `[MarketData] Failed to seed ${coin} ${interval}: ${err?.message}`,
        );
      }
    }
  }

  private closeAllSockets(): void {
    for (const [key, ws] of this.wsSockets) {
      ws.terminate();
    }
    this.wsSockets.clear();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }
}
