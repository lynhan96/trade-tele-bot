import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";
import axios, { AxiosInstance } from "axios";

export interface Position {
  instId: string;
  pos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  lever: string;
  mgnMode: string;
  posSide: string;
  liqPx: string;
  margin: string;
}

export interface PositionInfo {
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  leverage: number;
  margin: number;
  volume: number;
  takeProfit: string | null;
  stopLoss: string | null;
  liquidationPrice: number;
}

export interface AccountBalance {
  totalBalance: number;
  availableBalance: number;
  totalUnrealizedProfit: number;
}

@Injectable()
export class OkxService {
  private readonly logger = new Logger(OkxService.name);
  private readonly baseUrl = "https://www.okx.com";

  private createClient(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
  ): AxiosInstance {
    const client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });

    client.interceptors.request.use((config) => {
      const timestamp = new Date().toISOString();
      const method = config.method?.toUpperCase() || "GET";
      let path = config.url || "";

      // Include query parameters in the path for signature
      if (config.params) {
        const queryString = new URLSearchParams(config.params).toString();
        if (queryString) {
          path = `${path}?${queryString}`;
        }
      }

      const body = config.data ? JSON.stringify(config.data) : "";

      const prehash = timestamp + method + path + body;
      const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(prehash)
        .digest("base64");

      config.headers["OK-ACCESS-KEY"] = apiKey;
      config.headers["OK-ACCESS-SIGN"] = signature;
      config.headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      config.headers["OK-ACCESS-PASSPHRASE"] = passphrase;
      config.headers["Content-Type"] = "application/json";

      return config;
    });

    client.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logger.error(`OKX API Error: ${error.message}`);
        if (error.response) {
          this.logger.error(`Status: ${error.response.status}`);
          this.logger.error(`Data: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
      },
    );

    return client;
  }

  async getAccountBalance(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
  ): Promise<AccountBalance> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);
      const response = await client.get("/api/v5/account/balance");

      if (response.data.code !== "0") {
        this.logger.error(
          `OKX API Error - Code: ${response.data.code}, Message: ${response.data.msg}`,
        );
        throw new Error(`OKX API Error: ${response.data.msg}`);
      }

      const data = response.data.data[0];
      const usdtDetail = data.details.find((d: any) => d.ccy === "USDT");

      const totalBalance = parseFloat(usdtDetail?.eq || "0");
      const availableBalance = parseFloat(usdtDetail?.availBal || "0");

      const positions = await this.getOpenPositions(
        apiKey,
        apiSecret,
        passphrase,
      );
      const totalUnrealizedProfit = positions.reduce(
        (sum, pos) => sum + pos.unrealizedPnl,
        0,
      );

      return {
        totalBalance,
        availableBalance,
        totalUnrealizedProfit,
      };
    } catch (error) {
      this.logger.error("Error fetching OKX account balance:", error.message);
      throw error;
    }
  }

  async getOpenPositions(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
  ): Promise<PositionInfo[]> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);
      const response = await client.get("/api/v5/account/positions", {
        params: { instType: "SWAP" },
      });

      if (response.data.code !== "0") {
        throw new Error(`OKX API Error: ${response.data.msg}`);
      }

      const positions = response.data.data;

      // Filter only positions with non-zero quantity
      const openPositions = positions.filter(
        (pos: any) => parseFloat(pos.pos) !== 0,
      );

      const positionInfos: PositionInfo[] = [];

      for (const pos of openPositions) {
        const quantity = Math.abs(parseFloat(pos.pos));
        const entryPrice = parseFloat(pos.avgPx);
        const currentPrice = parseFloat(pos.markPx);
        const unrealizedPnl = parseFloat(pos.upl);
        const leverage = parseFloat(pos.lever);
        const margin = parseFloat(pos.margin);

        // Volume calculation: quantity * entry price (notional value)
        const volume = quantity * entryPrice;

        const positionInfo: PositionInfo = {
          symbol: pos.instId,
          side: parseFloat(pos.pos) > 0 ? "LONG" : "SHORT",
          quantity,
          entryPrice,
          currentPrice,
          unrealizedPnl,
          realizedPnl: 0,
          leverage,
          margin,
          volume,
          takeProfit: null,
          stopLoss: null,
          liquidationPrice: parseFloat(pos.liqPx || "0"),
        };

        // Fetch TP/SL from algo orders
        try {
          const algoResponse = await client.get(
            "/api/v5/trade/orders-algo-pending",
            {
              params: {
                instType: "SWAP",
                instId: pos.instId,
                ordType: "conditional",
              },
            },
          );

          if (algoResponse.data.code === "0" && algoResponse.data.data) {
            for (const order of algoResponse.data.data) {
              // TP order: side opposite to position
              if (order.ordType === "conditional" && order.slOrdPx) {
                positionInfo.stopLoss = order.slOrdPx;
              }
              if (order.ordType === "conditional" && order.tpOrdPx) {
                positionInfo.takeProfit = order.tpOrdPx;
              }
            }
          }
        } catch (algoError) {
          // Silently continue if algo orders cannot be fetched
        }

        positionInfos.push(positionInfo);
      }

      return positionInfos;
    } catch (error) {
      this.logger.error("Error fetching OKX positions:", error.message);
      throw error;
    }
  }

  async setTakeProfit(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    symbol: string,
    percentage: number,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);

      // Get current position
      const positions = await this.getOpenPositions(
        apiKey,
        apiSecret,
        passphrase,
      );
      const position = positions.find((p) => p.symbol === symbol);

      if (!position) {
        throw new Error(`No open position found for ${symbol}`);
      }

      const entryPrice = position.entryPrice;
      const isLong = position.side === "LONG";

      // Calculate TP price based on percentage
      let tpPrice: number;
      if (isLong) {
        tpPrice = entryPrice * (1 + percentage / 100);
      } else {
        tpPrice = entryPrice * (1 - percentage / 100);
      }

      // Round to appropriate precision (OKX typically uses up to 8 decimals)
      tpPrice = parseFloat(tpPrice.toFixed(4));

      // Cancel existing TP orders
      try {
        const ordersResponse = await client.get(
          "/api/v5/trade/orders-algo-pending",
          {
            params: {
              instType: "SWAP",
              instId: symbol,
            },
          },
        );

        if (ordersResponse.data.code === "0") {
          const orders = ordersResponse.data.data;
          for (const order of orders) {
            if (order.ordType === "conditional" && order.tpTriggerPx) {
              await client.post("/api/v5/trade/cancel-algos", {
                data: [
                  {
                    instId: symbol,
                    algoId: order.algoId,
                  },
                ],
              });
            }
          }
        }
      } catch (err) {
        this.logger.warn("Could not cancel existing TP orders");
      }

      // Place new TP order
      const tpOrder = await client.post("/api/v5/trade/order-algo", {
        instId: symbol,
        tdMode: "cross",
        side: isLong ? "sell" : "buy",
        ordType: "conditional",
        sz: position.quantity.toString(),
        tpTriggerPx: tpPrice.toString(),
        tpOrdPx: "-1", // Market order
      });

      if (tpOrder.data.code !== "0") {
        throw new Error(`OKX API Error: ${tpOrder.data.msg}`);
      }

      return {
        success: true,
        symbol,
        side: position.side,
        entryPrice,
        tpPrice,
        percentage,
        order: tpOrder.data.data[0],
      };
    } catch (error) {
      this.logger.error("Error setting OKX take profit:", error.message);
      throw error;
    }
  }

  async closePosition(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    symbol: string,
    quantity: number,
    side: string,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);

      // Close position by creating opposite order
      const order = await client.post("/api/v5/trade/order", {
        instId: symbol,
        tdMode: "cross",
        side: side === "LONG" ? "sell" : "buy",
        ordType: "market",
        sz: quantity.toString(),
        reduceOnly: true,
      });

      if (order.data.code !== "0") {
        throw new Error(`OKX API Error: ${order.data.msg}`);
      }

      this.logger.log(`Closed OKX position ${symbol}: ${side} ${quantity}`);
      return order.data.data[0];
    } catch (error) {
      this.logger.error(`Error closing OKX position ${symbol}:`, error.message);
      throw error;
    }
  }

  async getCurrentPrice(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    symbol: string,
  ): Promise<number> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);
      const response = await client.get("/api/v5/market/ticker", {
        params: { instId: symbol },
      });

      if (response.data.code !== "0") {
        throw new Error(`OKX API Error: ${response.data.msg}`);
      }

      const ticker = response.data.data[0];
      return parseFloat(ticker.last);
    } catch (error) {
      this.logger.error(
        `Error fetching current price for ${symbol}:`,
        error.message,
      );
      throw error;
    }
  }

  async openPosition(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    params: {
      symbol: string;
      side: "LONG" | "SHORT";
      quantity: number;
      leverage: number;
    },
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);

      // Set leverage first
      await client.post("/api/v5/account/set-leverage", {
        instId: params.symbol,
        lever: params.leverage.toString(),
        mgnMode: "cross",
      });

      // Open position with market order
      const order = await client.post("/api/v5/trade/order", {
        instId: params.symbol,
        tdMode: "cross",
        side: params.side === "LONG" ? "buy" : "sell",
        ordType: "market",
        sz: params.quantity.toString(),
      });

      if (order.data.code !== "0") {
        throw new Error(`OKX API Error: ${order.data.msg}`);
      }

      // Fetch order details to get average fill price
      const orderId = order.data.data[0].ordId;
      const orderDetails = await client.get("/api/v5/trade/order", {
        params: {
          instId: params.symbol,
          ordId: orderId,
        },
      });

      const avgPx = orderDetails.data.data[0]?.avgPx || null;

      this.logger.log(
        `Opened OKX position ${params.symbol}: ${params.side} ${params.quantity} @ ${params.leverage}x, Avg Price: ${avgPx || "N/A"}`,
      );

      // Return order with avgPrice for re-entry optimization
      return {
        ...order.data.data[0],
        avgPrice: avgPx, // Add avgPrice field for consistency with Binance
      };
    } catch (error) {
      this.logger.error(
        `Error opening OKX position ${params.symbol}:`,
        error.message,
      );
      throw error;
    }
  }

  async setStopLoss(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    symbol: string,
    stopPrice: number,
    side: "LONG" | "SHORT",
    quantity: number,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);

      // Set stop loss order using conditional order
      const order = await client.post("/api/v5/trade/order-algo", {
        instId: symbol,
        tdMode: "cross",
        side: side === "LONG" ? "sell" : "buy",
        ordType: "conditional",
        sz: quantity.toString(),
        slTriggerPx: stopPrice.toString(),
        slOrdPx: "-1", // Market order when triggered
      });

      if (order.data.code !== "0") {
        throw new Error(`OKX API Error: ${order.data.msg}`);
      }

      this.logger.log(`Set stop loss for ${symbol} at $${stopPrice} (${side})`);
      return order.data.data[0];
    } catch (error) {
      this.logger.error(
        `Error setting stop loss for ${symbol}:`,
        error.message,
      );
      throw error;
    }
  }

  async getKlines(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<any[]> {
    try {
      const client = this.createClient(apiKey, apiSecret, passphrase);

      // OKX interval format: 1m, 5m, 15m, 1H, 4H, 1D
      const response = await client.get("/api/v5/market/candles", {
        params: {
          instId: symbol,
          bar: interval.replace("m", "m").replace("h", "H"),
          limit: limit.toString(),
        },
      });

      if (response.data.code !== "0") {
        throw new Error(`OKX API Error: ${response.data.msg}`);
      }

      // OKX returns: [timestamp, open, high, low, close, volume, volCcy, volCcyQuote, confirm]
      return response.data.data.map((candle: any[]) => ({
        openTime: parseInt(candle[0]),
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
      }));
    } catch (error) {
      this.logger.error(`Error fetching klines for ${symbol}:`, error.message);
      throw error;
    }
  }
}
