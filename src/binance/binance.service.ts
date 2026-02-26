import { Injectable, Logger } from "@nestjs/common";
import Binance, { CandleChartInterval_LT } from "binance-api-node";

export interface Position {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  isolated: boolean;
  positionSide: string;
  liquidationPrice: string;
  margin: string;
  takeProfit?: string;
  stopLoss?: string;
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
  volume: number; // margin * quantity
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
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);

  createClient(apiKey: string, apiSecret: string) {
    return Binance({
      apiKey,
      apiSecret,
    });
  }

  async getAccountBalance(
    apiKey: string,
    apiSecret: string,
  ): Promise<AccountBalance> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      const account = await client.futuresAccountInfo();

      return {
        totalBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance),
        totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit),
      };
    } catch (error) {
      this.logger.error("Error fetching account balance:", error.message);
      throw error;
    }
  }

  async getOpenPositions(
    apiKey: string,
    apiSecret: string,
  ): Promise<PositionInfo[]> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      const positions = await client.futuresPositionRisk();

      // Filter only positions with non-zero quantity
      const openPositions = positions.filter(
        (pos) => parseFloat(pos.positionAmt) !== 0,
      );

      // Fetch algo orders (new endpoint since Binance migration on 2025-12-09)
      // Conditional orders (STOP_MARKET, TAKE_PROFIT_MARKET) are now on /fapi/v1/openAlgoOrders
      const algoOrders: any[] = await (client as any)
        .privateRequest('GET', '/fapi/v1/openAlgoOrders', {})
        .catch(() => []);
      const algoOrdersBySymbol = new Map<string, any[]>();
      if (Array.isArray(algoOrders)) {
        for (const order of algoOrders) {
          if (!algoOrdersBySymbol.has(order.symbol)) {
            algoOrdersBySymbol.set(order.symbol, []);
          }
          algoOrdersBySymbol.get(order.symbol).push(order);
        }
      }

      const positionInfos: PositionInfo[] = [];

      for (const pos of openPositions) {
        const quantity = Math.abs(parseFloat(pos.positionAmt));
        const entryPrice = parseFloat(pos.entryPrice);
        const currentPrice = parseFloat(pos.markPrice);
        const unrealizedPnl = parseFloat(pos.unRealizedProfit);
        const leverage = parseFloat(pos.leverage);

        // Margin: position notional / leverage
        const margin = (quantity * entryPrice) / leverage;
        // Volume: notional value of the position
        const volume = quantity * entryPrice;

        const positionInfo: PositionInfo = {
          symbol: pos.symbol,
          side: parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT",
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
          liquidationPrice: parseFloat(pos.liquidationPrice),
        };

        // Check algo orders for TP/SL (new Binance API since 2025-12-09)
        const symbolAlgoOrders = algoOrdersBySymbol.get(pos.symbol) || [];
        for (const order of symbolAlgoOrders) {
          if (
            order.orderType === "TAKE_PROFIT_MARKET" ||
            order.orderType === "TAKE_PROFIT"
          ) {
            positionInfo.takeProfit = order.triggerPrice;
          }
          if (
            order.orderType === "STOP_MARKET" ||
            order.orderType === "STOP"
          ) {
            positionInfo.stopLoss = order.triggerPrice;
          }
        }

        positionInfos.push(positionInfo);
      }

      return positionInfos;
    } catch (error) {
      this.logger.error("Error fetching positions:", error.message);
      throw error;
    }
  }

  async setTakeProfit(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    percentage: number,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      // Get current position
      const positions = await client.futuresPositionRisk();
      const position = positions.find(
        (p) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0,
      );

      if (!position) {
        throw new Error(`No open position found for ${symbol}`);
      }

      const entryPrice = parseFloat(position.entryPrice);
      const isLong = parseFloat(position.positionAmt) > 0;

      // Calculate TP price based on percentage
      let tpPrice: number;
      if (isLong) {
        tpPrice = entryPrice * (1 + percentage / 100);
      } else {
        tpPrice = entryPrice * (1 - percentage / 100);
      }

      // Round to appropriate precision
      const symbolInfo = await client.futuresExchangeInfo();
      const symbolData = symbolInfo.symbols.find((s) => s.symbol === symbol);
      const pricePrecision = symbolData?.pricePrecision || 2;
      tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

      // Cancel existing TP algo orders (new endpoint since Binance migration 2025-12-09)
      const openAlgoOrders: any[] = await (client as any)
        .privateRequest('GET', '/fapi/v1/openAlgoOrders', { symbol })
        .catch(() => []);
      if (Array.isArray(openAlgoOrders)) {
        for (const order of openAlgoOrders) {
          if (
            order.orderType === "TAKE_PROFIT_MARKET" ||
            order.orderType === "TAKE_PROFIT"
          ) {
            await (client as any)
              .privateRequest('DELETE', '/fapi/v1/algoOrder', { algoId: order.algoId })
              .catch(() => {});
          }
        }
      }

      // Place new TP order via Algo Order API (required since Binance migration 2025-12-09)
      const tpOrder = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side: isLong ? "SELL" : "BUY",
        type: "TAKE_PROFIT_MARKET",
        triggerPrice: tpPrice.toString(),
        closePosition: "true",
      });

      return {
        success: true,
        symbol,
        side: isLong ? "LONG" : "SHORT",
        entryPrice,
        tpPrice,
        percentage,
        order: tpOrder,
      };
    } catch (error) {
      this.logger.error("Error setting take profit:", error.message);
      throw error;
    }
  }

  async closePosition(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quantity: number,
    side: string,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      // Close position by creating opposite order
      const order = await client.futuresOrder({
        symbol,
        side: side === "LONG" ? "SELL" : "BUY",
        type: "MARKET",
        quantity: quantity.toString(),
        reduceOnly: "true",
      });

      this.logger.log(`Closed position ${symbol}: ${side} ${quantity}`);
      return order;
    } catch (error) {
      this.logger.error(`Error closing position ${symbol}:`, error.message);
      throw error;
    }
  }

  async getCurrentPrice(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<number> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      const prices = await client.futuresMarkPrice();
      const ticker = prices.find((p) => p.symbol === symbol);

      if (!ticker) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      return parseFloat(ticker.markPrice);
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
    params: {
      symbol: string;
      side: "LONG" | "SHORT";
      quantity: number;
      leverage: number;
    },
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      // Set leverage — fall back to symbol's max if requested leverage is too high
      let effectiveLeverage = params.leverage;
      try {
        await client.futuresLeverage({
          symbol: params.symbol,
          leverage: params.leverage,
        });
      } catch (leverageError) {
        const brackets = await client.futuresLeverageBracket({
          symbol: params.symbol,
          recvWindow: 5000,
        });
        const maxLeverage =
          (brackets as any)[0]?.brackets?.[0]?.initialLeverage ?? 20;
        this.logger.warn(
          `Leverage ${params.leverage}x not valid for ${params.symbol}, falling back to max ${maxLeverage}x`,
        );
        await client.futuresLeverage({
          symbol: params.symbol,
          leverage: maxLeverage,
        });
        effectiveLeverage = maxLeverage;
      }

      // Open position with market order
      const order = await client.futuresOrder({
        symbol: params.symbol,
        side: params.side === "LONG" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: params.quantity.toString(),
      });

      this.logger.log(
        `Opened Binance position ${params.symbol}: ${params.side} ${params.quantity} @ ${effectiveLeverage}x, Avg Price: ${order.avgPrice || "N/A"}`,
      );

      // Return order with avgPrice for re-entry optimization
      return order;
    } catch (error) {
      this.logger.error(
        `Error opening Binance position ${params.symbol}:`,
        error.message,
      );
      throw error;
    }
  }

  async getKlines(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    interval: CandleChartInterval_LT,
    limit: number,
  ): Promise<any[]> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      const klines = await client.futuresCandles({
        symbol,
        interval,
        limit,
      });

      return klines;
    } catch (error) {
      this.logger.error(`Error fetching klines for ${symbol}:`, error.message);
      throw error;
    }
  }

  async setStopLoss(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    stopPrice: number,
    side: "LONG" | "SHORT",
    quantity: number,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      // Place stop loss via Algo Order API (required since Binance migration 2025-12-09)
      const order = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side: side === "LONG" ? "SELL" : "BUY",
        type: "STOP_MARKET",
        triggerPrice: stopPrice.toString(),
        closePosition: "true",
      });

      this.logger.log(`Set stop loss for ${symbol} at $${stopPrice} (${side})`);
      return order;
    } catch (error) {
      this.logger.error(
        `Error setting stop loss for ${symbol}:`,
        error.message,
      );
      throw error;
    }
  }
}
