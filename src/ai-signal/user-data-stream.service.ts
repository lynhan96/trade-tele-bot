import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BinanceService } from "../binance/binance.service";
import { UserRealTradingService } from "./user-real-trading.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require("ws");

const WS_FSTREAM = "wss://fstream.binance.com/ws/";
const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface StreamEntry {
  listenKey: string;
  ws: any; // WebSocket instance
  keepAliveInterval: NodeJS.Timeout;
  apiKey: string;
  apiSecret: string;
}

@Injectable()
export class UserDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserDataStreamService.name);
  private readonly streams = new Map<number, StreamEntry>();

  constructor(
    private readonly binanceService: BinanceService,
    private readonly userRealTradingService: UserRealTradingService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register this service into UserRealTradingService to break circular dep
    this.userRealTradingService.setDataStreamService(this);
  }

  async onModuleDestroy(): Promise<void> {
    for (const [telegramId] of this.streams) {
      await this.unregisterUser(telegramId).catch(() => {});
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Open a Binance Futures User Data Stream WebSocket for the given user.
   * Idempotent — skips if already registered.
   */
  async registerUser(
    telegramId: number,
    apiKey: string,
    apiSecret: string,
  ): Promise<void> {
    if (this.streams.has(telegramId)) return; // already watching

    let listenKey: string;
    try {
      const client = this.binanceService.createClient(apiKey, apiSecret);
      const result = await (client as any).futuresGetDataStream();
      listenKey = result.listenKey ?? result;
    } catch (err) {
      this.logger.error(
        `[UserDataStream] Failed to get listenKey for user ${telegramId}: ${err?.message}`,
      );
      return;
    }

    const ws = new WebSocket(`${WS_FSTREAM}${listenKey}`);

    ws.on("open", () => {
      this.logger.log(`[UserDataStream] WS opened for user ${telegramId}`);
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const event = JSON.parse(raw.toString());
        this.handleEvent(telegramId, event);
      } catch {
        // ignore parse errors
      }
    });

    ws.on("close", (code: number) => {
      this.logger.warn(
        `[UserDataStream] WS closed for user ${telegramId} (code: ${code}) — will reconnect in 10s`,
      );
      // Auto-reconnect after 10s (unless unregistered)
      setTimeout(() => {
        if (!this.streams.has(telegramId)) return;
        this.streams.delete(telegramId);
        this.registerUser(telegramId, apiKey, apiSecret).catch(() => {});
      }, 10_000);
    });

    ws.on("error", (err: Error) => {
      this.logger.warn(`[UserDataStream] WS error for user ${telegramId}: ${err?.message}`);
    });

    // Keepalive: PUT listenKey every 30 minutes to prevent expiry
    const keepAliveInterval = setInterval(async () => {
      try {
        const client = this.binanceService.createClient(apiKey, apiSecret);
        await (client as any).futuresKeepaliveDataStream({ listenKey });
      } catch (err) {
        this.logger.warn(
          `[UserDataStream] Keepalive failed for user ${telegramId}: ${err?.message}`,
        );
      }
    }, KEEPALIVE_INTERVAL_MS);

    this.streams.set(telegramId, { listenKey, ws, keepAliveInterval, apiKey, apiSecret });
    this.logger.log(
      `[UserDataStream] Registered data stream for user ${telegramId} (listenKey: ${listenKey.slice(0, 8)}...)`,
    );
  }

  /**
   * Close the data stream WebSocket for the given user.
   */
  async unregisterUser(telegramId: number): Promise<void> {
    const entry = this.streams.get(telegramId);
    if (!entry) return;

    clearInterval(entry.keepAliveInterval);
    try {
      entry.ws.close();
    } catch {
      // ignore
    }
    try {
      const client = this.binanceService.createClient(entry.apiKey, entry.apiSecret);
      await (client as any).futuresCloseDataStream({ listenKey: entry.listenKey });
    } catch {
      // ignore — listenKey may already be expired
    }
    this.streams.delete(telegramId);
    this.logger.log(`[UserDataStream] Unregistered data stream for user ${telegramId}`);
  }

  /** Returns the number of active streams (for status display). */
  activeStreamCount(): number {
    return this.streams.size;
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  /**
   * Handle a raw Binance Futures WebSocket event.
   * Detects position closes (TP/SL fills) and notifies UserRealTradingService.
   *
   * Raw Binance event fields for ORDER_TRADE_UPDATE:
   *   e = "ORDER_TRADE_UPDATE"
   *   o.s = symbol
   *   o.X = orderStatus ("FILLED", "NEW", ...)
   *   o.ap = average fill price
   *   o.L = last fill price
   *   o.R = isReduceOnly
   *   o.cp = closePosition (true when algo order closes position)
   *   o.ot = originalOrderType ("STOP_MARKET", "TAKE_PROFIT_MARKET", ...)
   */
  private handleEvent(telegramId: number, event: any): void {
    if (event.e !== "ORDER_TRADE_UPDATE") return;

    const order = event.o;
    if (!order) return;

    const orderStatus: string = order.X;

    // Log all FILLED events for debugging
    if (orderStatus === "FILLED") {
      this.logger.log(
        `[UserDataStream] User ${telegramId} FILLED: ${order.s} ${order.S} type=${order.o} ot=${order.ot} R=${order.R} cp=${order.cp} qty=${order.q} price=${order.ap || order.L}`,
      );
    }

    if (orderStatus !== "FILLED") return;

    // Lenient boolean check — Binance may send true, "true", or "TRUE"
    const toBool = (v: any) => v === true || v === "true" || v === "TRUE";
    const isClose: boolean = toBool(order.R) || toBool(order.cp);
    if (!isClose) return;

    const symbol: string = order.s;
    const fillPrice = parseFloat(order.ap || order.L || "0");
    if (!fillPrice) return;

    const origOrderType: string = order.ot ?? order.o ?? "";
    const reason =
      origOrderType.includes("STOP") ? "STOP_LOSS" :
      origOrderType.includes("TAKE_PROFIT") ? "TAKE_PROFIT" : "MANUAL";

    this.logger.log(
      `[UserDataStream] User ${telegramId} ${symbol} position closed @ ${fillPrice} — ${reason}`,
    );

    this.userRealTradingService
      .onTradeClose(telegramId, symbol, fillPrice, reason)
      .catch((err) =>
        this.logger.error(`[UserDataStream] onTradeClose error: ${err?.message}`),
      );
  }
}
