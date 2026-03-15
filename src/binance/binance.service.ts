import { Injectable, Logger } from "@nestjs/common";
import Binance, { CandleChartInterval_LT } from "binance-api-node";

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

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);

  createClient(apiKey: string, apiSecret: string) {
    return Binance({
      apiKey,
      apiSecret,
    });
  }

  /**
   * Enable hedge mode (dual side position) so the account can hold LONG and SHORT
   * positions simultaneously on the same symbol. Safe to call if already enabled.
   */
  async enableHedgeMode(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      await (client as any).privateRequest('POST', '/fapi/v1/positionSide/dual', {
        dualSidePosition: 'true',
      });
      this.logger.log('Hedge mode (dual side position) enabled');
      return true;
    } catch (error) {
      // "No need to change position side." means it's already enabled
      if (error?.message?.includes('No need to change')) {
        this.logger.debug('Hedge mode already enabled');
        return true;
      }
      this.logger.warn(`Failed to enable hedge mode: ${error?.message}`);
      return false;
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

  async closePosition(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quantity: number,
    side: string,
  ): Promise<any> {
    try {
      const client = this.createClient(apiKey, apiSecret);

      // Fetch actual position size from Binance to avoid ReduceOnly rejection
      // (DB quantity may differ from actual if grids partially filled or position was adjusted externally)
      let actualQty = quantity;
      try {
        const positions = await client.futuresPositionRisk({ symbol });
        const pos = (positions as any[]).find(
          (p: any) => p.symbol === symbol && (side === "LONG" ? parseFloat(p.positionAmt) > 0 : parseFloat(p.positionAmt) < 0),
        );
        if (pos) {
          const binanceQty = Math.abs(parseFloat(pos.positionAmt));
          if (binanceQty > 0 && binanceQty !== quantity) {
            this.logger.warn(`closePosition ${symbol}: DB qty=${quantity} vs Binance qty=${binanceQty} — using Binance value`);
            actualQty = binanceQty;
          }
        }
      } catch { /* fail-open: use DB quantity */ }

      const order = await client.futuresOrder({
        symbol,
        side: side === "LONG" ? "SELL" : "BUY",
        positionSide: side as any,
        type: "MARKET",
        quantity: actualQty.toString(),
      });

      this.logger.log(`Closed position ${symbol}: ${side} ${actualQty}`);
      return order;
    } catch (error) {
      this.logger.error(`Error closing position ${symbol}:`, error.message);
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

      // Open position with market order (hedge mode: include positionSide)
      const order = await client.futuresOrder({
        symbol: params.symbol,
        side: params.side === "LONG" ? "BUY" : "SELL",
        positionSide: params.side,
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
    const client = this.createClient(apiKey, apiSecret);
    const orderSide = side === "LONG" ? "SELL" : "BUY";

    // Try closePosition first (shows in Binance app position row)
    try {
      const order = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side: orderSide,
        positionSide: side as any,
        type: "STOP_MARKET",
        triggerPrice: stopPrice.toString(),
        closePosition: "true",
      });
      this.logger.log(`Set stop loss for ${symbol} at $${stopPrice} (${side}) [closePosition]`);
      return order;
    } catch (error) {
      this.logger.warn(`SL closePosition failed for ${symbol}: ${error.message} — retrying with quantity`);
    }

    // Fallback: use quantity if closePosition fails (GTE conflict)
    try {
      const order = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side: orderSide,
        positionSide: side as any,
        type: "STOP_MARKET",
        triggerPrice: stopPrice.toString(),
        quantity: quantity.toString(),
      });
      this.logger.log(`Set stop loss for ${symbol} at $${stopPrice} (${side}) [quantity fallback]`);
      return order;
    } catch (error) {
      this.logger.error(`Error setting stop loss for ${symbol}:`, error.message);
      throw error;
    }
  }

  /**
   * Place a take profit algo order at a specific price (no position fetch needed).
   */
  async setTakeProfitAtPrice(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    tpPrice: number,
    side: "LONG" | "SHORT",
    quantity?: number,
  ): Promise<any> {
    const client = this.createClient(apiKey, apiSecret);
    const orderSide = side === "LONG" ? "SELL" : "BUY";

    // Try closePosition first (shows in Binance app position row)
    try {
      const order = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side: orderSide,
        positionSide: side as any,
        type: "TAKE_PROFIT_MARKET",
        triggerPrice: tpPrice.toString(),
        closePosition: "true",
      });
      this.logger.log(`Set take profit for ${symbol} at $${tpPrice} (${side}) [closePosition]`);
      return order;
    } catch (error) {
      this.logger.warn(`TP closePosition failed for ${symbol}: ${error.message} — retrying with quantity`);
    }

    // Fallback: use quantity if closePosition fails (GTE conflict)
    if (quantity) {
      try {
        const order = await (client as any).privateRequest('POST', '/fapi/v1/algoOrder', {
          algoType: 'CONDITIONAL',
          symbol,
          side: orderSide,
          positionSide: side as any,
          type: "TAKE_PROFIT_MARKET",
          triggerPrice: tpPrice.toString(),
          quantity: quantity.toString(),
        });
        this.logger.log(`Set take profit for ${symbol} at $${tpPrice} (${side}) [quantity fallback]`);
        return order;
      } catch (error2) {
        this.logger.error(`Error setting take profit for ${symbol}:`, error2.message);
        throw error2;
      }
    }
    throw new Error(`TP closePosition failed for ${symbol} and no quantity available for fallback`);
  }

  /**
   * Get Binance Futures USDT balance for a user.
   */
  async getFuturesBalance(
    apiKey: string,
    apiSecret: string,
  ): Promise<{ walletBalance: number; availableBalance: number; unrealizedPnl: number } | null> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      const balances = await client.futuresAccountBalance();
      const usdt = (balances as any[]).find((b: any) => b.asset === "USDT");
      if (!usdt) return null;
      return {
        walletBalance: parseFloat(usdt.balance),
        availableBalance: parseFloat(usdt.availableBalance),
        unrealizedPnl: parseFloat(usdt.crossUnPnl || "0"),
      };
    } catch (err) {
      this.logger.warn(`[Binance] getFuturesBalance failed: ${err?.message}`);
      return null;
    }
  }

  /**
   * Fetch all open algo orders + regular open orders (SL/TP) for a user.
   * Returns null when ALL API calls fail — caller MUST skip SL/TP re-placement to avoid spam.
   */
  async getOpenAlgoOrders(
    apiKey: string,
    apiSecret: string,
  ): Promise<Map<string, { hasSl: boolean; hasTp: boolean; slAlgoId?: string; tpAlgoId?: string }> | null> {
    const result = new Map<string, { hasSl: boolean; hasTp: boolean; slAlgoId?: string; tpAlgoId?: string }>();
    const client = this.createClient(apiKey, apiSecret);
    let anySuccess = false;

    try {
      // 1. Algo orders (placed by setStopLoss/setTakeProfitAtPrice via /fapi/v1/algoOrder)
      try {
        const algoOrders: any[] = await (client as any).privateRequest('GET', '/fapi/v1/openAlgoOrders', {});
        if (Array.isArray(algoOrders)) {
          anySuccess = true;
          for (const o of algoOrders) {
            const sym = o.symbol as string;
            if (!result.has(sym)) result.set(sym, { hasSl: false, hasTp: false });
            const entry = result.get(sym)!;
            if (o.orderType === 'STOP_MARKET' || o.orderType === 'STOP') {
              entry.hasSl = true;
              entry.slAlgoId = o.algoId?.toString();
            }
            if (o.orderType === 'TAKE_PROFIT_MARKET' || o.orderType === 'TAKE_PROFIT') {
              entry.hasTp = true;
              entry.tpAlgoId = o.algoId?.toString();
            }
          }
        }
      } catch (err) {
        this.logger.debug(`openAlgoOrders API failed: ${err?.message}`);
      }

      // 2. Regular open orders fallback (some SL/TP may be placed as regular orders)
      try {
        const regularOrders: any[] = await client.futuresOpenOrders({});
        if (Array.isArray(regularOrders)) {
          anySuccess = true;
          for (const o of regularOrders) {
            const sym = o.symbol as string;
            const oType = o.type as string;
            if (oType !== 'STOP_MARKET' && oType !== 'STOP' && oType !== 'TAKE_PROFIT_MARKET' && oType !== 'TAKE_PROFIT') continue;
            if (!result.has(sym)) result.set(sym, { hasSl: false, hasTp: false });
            const entry = result.get(sym)!;
            if (oType === 'STOP_MARKET' || oType === 'STOP') {
              entry.hasSl = true;
              if (!entry.slAlgoId) entry.slAlgoId = o.orderId?.toString();
            }
            if (oType === 'TAKE_PROFIT_MARKET' || oType === 'TAKE_PROFIT') {
              entry.hasTp = true;
              if (!entry.tpAlgoId) entry.tpAlgoId = o.orderId?.toString();
            }
          }
        }
      } catch (err) {
        this.logger.debug(`futuresOpenOrders fallback failed: ${err?.message}`);
      }
    } catch (err) {
      this.logger.warn(`getOpenAlgoOrders outer error: ${err?.message}`);
    }

    if (!anySuccess) {
      this.logger.warn(`getOpenAlgoOrders: ALL API calls failed — returning null`);
      return null;
    }
    return result;
  }

  /**
   * Cancel an algo order by algoId.
   */
  async cancelAlgoOrder(
    apiKey: string,
    apiSecret: string,
    algoId: string,
  ): Promise<void> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      await (client as any).privateRequest('DELETE', '/fapi/v1/algoOrder', { algoId });
    } catch (error) {
      this.logger.warn(`cancelAlgoOrder ${algoId}: ${error.message}`);
    }
  }

  /**
   * Get the average fill price from the most recent trade for a symbol.
   * Uses futuresUserTrades to get actual execution prices from Binance.
   */
  async getLastFillPrice(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<number | null> {
    try {
      const client = this.createClient(apiKey, apiSecret);
      const trades = await (client as any).futuresUserTrades({ symbol, limit: 5 });
      if (!trades || trades.length === 0) return null;
      // Most recent trade is last in array
      const last = trades[trades.length - 1];
      return parseFloat(last.price) || null;
    } catch (error) {
      this.logger.warn(`getLastFillPrice ${symbol}: ${error.message}`);
      return null;
    }
  }
}
