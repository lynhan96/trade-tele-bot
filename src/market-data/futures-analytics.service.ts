import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

export interface CoinAnalytics {
  symbol: string;
  fundingRate: number; // e.g. 0.0001 = 0.01%
  openInterest: number; // in contracts
  openInterestUsd: number; // OI * price
  longShortRatio: number; // >1 = more longs, <1 = more shorts
  longPercent: number;
  shortPercent: number;
  takerBuyRatio: number; // >1 = more taker buys (aggressive buying)
}

export interface MoneyFlowAlert {
  symbol: string;
  alertType: "OI_SURGE" | "OI_DROP" | "VOLUME_SPIKE" | "FUNDING_EXTREME" | "LONG_SHORT_EXTREME";
  message: string;
  severity: "HIGH" | "MEDIUM";
  data: Record<string, number>;
}

const ANALYTICS_CACHE_KEY = "cache:futures:analytics";
const ANALYTICS_TTL = 300; // 5 minutes
const PREV_OI_KEY = "cache:futures:prev_oi";

@Injectable()
export class FuturesAnalyticsService {
  private readonly logger = new Logger(FuturesAnalyticsService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Fetch futures analytics for multiple symbols from Binance.
   * Returns funding rate, OI, long/short ratio, taker buy/sell ratio.
   */
  async fetchAnalytics(symbols: string[]): Promise<Map<string, CoinAnalytics>> {
    const axios = require("axios");
    const results = new Map<string, CoinAnalytics>();

    // Batch: fetch all in parallel (max 10 at a time to avoid rate limits)
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map((symbol) => this.fetchSingleCoinAnalytics(axios, symbol));
      const batchResults = await Promise.allSettled(promises);

      for (let j = 0; j < batch.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled" && result.value) {
          results.set(batch[j], result.value);
        }
      }
    }

    // Cache results
    const cacheObj: Record<string, CoinAnalytics> = {};
    results.forEach((v, k) => { cacheObj[k] = v; });
    await this.redisService.set(ANALYTICS_CACHE_KEY, cacheObj, ANALYTICS_TTL);

    this.logger.debug(`[FuturesAnalytics] Fetched analytics for ${results.size}/${symbols.length} coins`);
    return results;
  }

  private async fetchSingleCoinAnalytics(axios: any, symbol: string): Promise<CoinAnalytics | null> {
    try {
      const [fundingRes, oiRes, lsRes, takerRes] = await Promise.allSettled([
        axios.get("https://fapi.binance.com/fapi/v1/fundingRate", {
          params: { symbol, limit: 1 },
          timeout: 5000,
        }),
        axios.get("https://fapi.binance.com/fapi/v1/openInterest", {
          params: { symbol },
          timeout: 5000,
        }),
        axios.get("https://fapi.binance.com/futures/data/globalLongShortAccountRatio", {
          params: { symbol, period: "1h", limit: 1 },
          timeout: 5000,
        }),
        axios.get("https://fapi.binance.com/futures/data/takerlongshortRatio", {
          params: { symbol, period: "1h", limit: 1 },
          timeout: 5000,
        }),
      ]);

      const funding = fundingRes.status === "fulfilled" && fundingRes.value.data?.[0]
        ? parseFloat(fundingRes.value.data[0].fundingRate)
        : 0;

      const oi = oiRes.status === "fulfilled" && oiRes.value.data
        ? parseFloat(oiRes.value.data.openInterest)
        : 0;

      const ls = lsRes.status === "fulfilled" && lsRes.value.data?.[0]
        ? {
            ratio: parseFloat(lsRes.value.data[0].longShortRatio),
            long: parseFloat(lsRes.value.data[0].longAccount),
            short: parseFloat(lsRes.value.data[0].shortAccount),
          }
        : { ratio: 1, long: 0.5, short: 0.5 };

      const taker = takerRes.status === "fulfilled" && takerRes.value.data?.[0]
        ? parseFloat(takerRes.value.data[0].buySellRatio)
        : 1;

      return {
        symbol,
        fundingRate: funding,
        openInterest: oi,
        openInterestUsd: 0, // Will be enriched by caller with price
        longShortRatio: ls.ratio,
        longPercent: ls.long * 100,
        shortPercent: ls.short * 100,
        takerBuyRatio: taker,
      };
    } catch (err) {
      this.logger.debug(`[FuturesAnalytics] Failed for ${symbol}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Get cached analytics. Returns empty map if not yet fetched.
   */
  async getCachedAnalytics(): Promise<Map<string, CoinAnalytics>> {
    const cached = await this.redisService.get<Record<string, CoinAnalytics>>(ANALYTICS_CACHE_KEY);
    if (!cached) return new Map();
    return new Map(Object.entries(cached));
  }

  /**
   * Detect money flow alerts by comparing current analytics with previous state.
   * Returns alerts for: OI surges, volume spikes, extreme funding, extreme L/S ratios.
   */
  async detectMoneyFlowAlerts(
    analytics: Map<string, CoinAnalytics>,
    priceVolData: { symbol: string; lastPrice: number; quoteVolume: number; priceChangePercent: number }[],
  ): Promise<MoneyFlowAlert[]> {
    const alerts: MoneyFlowAlert[] = [];
    const prevOi = await this.redisService.get<Record<string, number>>(PREV_OI_KEY) || {};
    const newOi: Record<string, number> = {};

    for (const [symbol, data] of analytics) {
      const coinInfo = priceVolData.find((c) => c.symbol === symbol);
      if (!coinInfo) continue;

      const coin = symbol.replace("USDT", "");
      newOi[symbol] = data.openInterest;

      // ── OI change detection ──
      const previousOi = prevOi[symbol];
      if (previousOi && previousOi > 0) {
        const oiChangePercent = ((data.openInterest - previousOi) / previousOi) * 100;

        if (oiChangePercent > 15) {
          alerts.push({
            symbol,
            alertType: "OI_SURGE",
            severity: oiChangePercent > 30 ? "HIGH" : "MEDIUM",
            message: `${coin}: OI tang ${oiChangePercent.toFixed(0)}% trong 5 phut, co dong tien lon vao.`,
            data: { oiChange: oiChangePercent, oi: data.openInterest },
          });
        } else if (oiChangePercent < -15) {
          alerts.push({
            symbol,
            alertType: "OI_DROP",
            severity: oiChangePercent < -30 ? "HIGH" : "MEDIUM",
            message: `${coin}: OI giam ${Math.abs(oiChangePercent).toFixed(0)}% trong 5 phut, dong tien rut manh.`,
            data: { oiChange: oiChangePercent, oi: data.openInterest },
          });
        }
      }

      // ── Extreme funding rate ──
      const fundingPct = data.fundingRate * 100;
      if (Math.abs(fundingPct) > 0.1) {
        alerts.push({
          symbol,
          alertType: "FUNDING_EXTREME",
          severity: Math.abs(fundingPct) > 0.3 ? "HIGH" : "MEDIUM",
          message: fundingPct > 0
            ? `${coin}: Funding rate +${fundingPct.toFixed(3)}% (long tra phi cao, co the giam)`
            : `${coin}: Funding rate ${fundingPct.toFixed(3)}% (short tra phi cao, co the tang)`,
          data: { fundingRate: fundingPct },
        });
      }

      // ── Extreme long/short ratio ──
      if (data.longShortRatio > 2.5) {
        alerts.push({
          symbol,
          alertType: "LONG_SHORT_EXTREME",
          severity: "MEDIUM",
          message: `${coin}: ${data.longPercent.toFixed(0)}% Long vs ${data.shortPercent.toFixed(0)}% Short — qua nhieu long, rui ro long squeeze.`,
          data: { lsRatio: data.longShortRatio },
        });
      } else if (data.longShortRatio < 0.4) {
        alerts.push({
          symbol,
          alertType: "LONG_SHORT_EXTREME",
          severity: "MEDIUM",
          message: `${coin}: ${data.longPercent.toFixed(0)}% Long vs ${data.shortPercent.toFixed(0)}% Short — qua nhieu short, rui ro short squeeze.`,
          data: { lsRatio: data.longShortRatio },
        });
      }

      // ── Volume spike (24h vol > $500M and price change > 15%) ──
      if (coinInfo.quoteVolume > 500_000_000 && Math.abs(coinInfo.priceChangePercent) > 15) {
        alerts.push({
          symbol,
          alertType: "VOLUME_SPIKE",
          severity: "HIGH",
          message: `${coin}: Volume $${(coinInfo.quoteVolume / 1e6).toFixed(0)}M voi gia ${coinInfo.priceChangePercent > 0 ? "tang" : "giam"} ${Math.abs(coinInfo.priceChangePercent).toFixed(1)}% — dong tien lon bat thuong!`,
          data: { volume: coinInfo.quoteVolume, priceChange: coinInfo.priceChangePercent },
        });
      }
    }

    // Save current OI for next comparison
    await this.redisService.set(PREV_OI_KEY, newOi, 600); // 10 min TTL

    return alerts;
  }

  /**
   * Format analytics data for a single coin (used in /ai check).
   */
  formatCoinAnalytics(data: CoinAnalytics, price: number): string {
    const fundingPct = (data.fundingRate * 100).toFixed(4);
    const fundingIcon = data.fundingRate > 0 ? "🔴" : data.fundingRate < 0 ? "🟢" : "⚪";
    const oiUsd = data.openInterest * price;
    const fmtOi = oiUsd >= 1e9 ? `$${(oiUsd / 1e9).toFixed(1)}B`
      : oiUsd >= 1e6 ? `$${(oiUsd / 1e6).toFixed(0)}M`
      : `$${oiUsd.toFixed(0)}`;

    return (
      `📊 *Futures Data:*\n` +
      `  ${fundingIcon} Funding: *${fundingPct}%*\n` +
      `  🏦 Open Interest: *${fmtOi}*\n` +
      `  📈 Long: *${data.longPercent.toFixed(1)}%* | Short: *${data.shortPercent.toFixed(1)}%* (L/S: ${data.longShortRatio.toFixed(2)})\n` +
      `  🔄 Taker Buy/Sell: *${data.takerBuyRatio.toFixed(2)}*`
    );
  }
}
