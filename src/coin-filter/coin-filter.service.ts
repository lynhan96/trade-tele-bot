import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import { MarketDataService, Ticker24h } from "../market-data/market-data.service";

export interface CoinShortlistEntry {
  symbol: string; // "BTCUSDT"
  coin: string; // "BTC"
  currency: string; // "USDT"
  priceChangePercent: number;
  quoteVolume: number; // USD volume
  lastPrice: number;
}

const SHORTLIST_CACHE_KEY = "cache:filter:shortlist";
const SHORTLIST_TTL = 360; // 6 minutes
const AI_MARKET_FILTERS_KEY = "cache:ai:market-filters";

@Injectable()
export class CoinFilterService {
  private readonly logger = new Logger(CoinFilterService.name);

  // Fixed priority coins that are always included if on USDT futures
  private readonly priorityCoins = ["BTC", "ETH", "SOL", "BNB", "XRP"];

  constructor(
    private readonly redisService: RedisService,
    private readonly marketDataService: MarketDataService,
    private readonly configService: ConfigService,
  ) {}

  private async getEffectiveFilterConfig(): Promise<{
    minVolumeUsd: number;
    minPriceChangePct: number;
    maxShortlistSize: number;
    source: "ai" | "env";
  }> {
    const aiConfig = await this.redisService.get<{
      minVolumeUsd: number;
      minPriceChangePct: number;
      maxShortlistSize: number;
    }>(AI_MARKET_FILTERS_KEY);

    const configuredMin = parseInt(
      this.configService.get("AI_MAX_SHORTLIST_SIZE", "50"),
    );

    if (aiConfig?.minVolumeUsd) {
      // Always respect .env as minimum floor — AI can exceed it but never go below
      return {
        ...aiConfig,
        maxShortlistSize: Math.max(aiConfig.maxShortlistSize, configuredMin),
        source: "ai",
      };
    }

    return {
      minVolumeUsd: parseFloat(
        this.configService.get("AI_MIN_COIN_VOLUME_USD", "10000000"),
      ),
      minPriceChangePct: parseFloat(
        this.configService.get("AI_MIN_PRICE_CHANGE_PCT", "0.3"),
      ),
      maxShortlistSize: configuredMin,
      source: "env",
    };
  }

  /**
   * Scan and compute the shortlist of coins to watch.
   * Called every 5 minutes by AiSignalService.
   */
  async scanAndFilter(): Promise<CoinShortlistEntry[]> {
    const tickers = await this.marketDataService.fetchAndCacheTicker24h();
    if (!tickers || tickers.length === 0) {
      this.logger.warn("[CoinFilter] No tickers returned, using cached shortlist");
      return this.getShortlist();
    }

    const { minVolumeUsd, minPriceChangePct, maxShortlistSize, source } =
      await this.getEffectiveFilterConfig();

    // Filter: only USDT pairs with sufficient volume
    const usdtPairs = tickers.filter(
      (t) =>
        t.symbol.endsWith("USDT") &&
        !t.symbol.includes("_") && // exclude delivery contracts
        parseFloat(t.quoteVolume) >= minVolumeUsd,
    );

    // Score each coin: prioritize volume, then price change
    const scored = usdtPairs.map((t) => ({
      symbol: t.symbol,
      coin: t.symbol.replace("USDT", ""),
      currency: "USDT",
      priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
      quoteVolume: parseFloat(t.quoteVolume),
      lastPrice: parseFloat(t.lastPrice),
    }));

    // Sort by volume descending
    scored.sort((a, b) => b.quoteVolume - a.quoteVolume);

    // Pick top N, but always include priority coins first
    const shortlist: CoinShortlistEntry[] = [];
    const addedSymbols = new Set<string>();

    // Priority first
    for (const coin of this.priorityCoins) {
      const entry = scored.find((s) => s.coin === coin);
      if (entry && !addedSymbols.has(entry.symbol)) {
        shortlist.push(entry);
        addedSymbols.add(entry.symbol);
      }
      if (shortlist.length >= maxShortlistSize) break;
    }

    // Fill remaining slots with top-volume coins
    for (const entry of scored) {
      if (shortlist.length >= maxShortlistSize) break;
      if (!addedSymbols.has(entry.symbol)) {
        shortlist.push(entry);
        addedSymbols.add(entry.symbol);
      }
    }

    await this.redisService.set(SHORTLIST_CACHE_KEY, shortlist, SHORTLIST_TTL);

    // Update MarketDataService subscriptions
    const coins = shortlist.map((s) => s.coin);
    await this.marketDataService.updateSubscriptions(coins);

    this.logger.log(
      `[CoinFilter] Shortlist (${shortlist.length}, src=${source}, vol>=$${(minVolumeUsd / 1e6).toFixed(0)}M, chg>=${minPriceChangePct}%): ${shortlist.map((s) => s.symbol).join(", ")}`,
    );

    return shortlist;
  }

  /**
   * Get the currently cached shortlist. Returns [] if not yet computed.
   */
  async getShortlist(): Promise<CoinShortlistEntry[]> {
    return (
      (await this.redisService.get<CoinShortlistEntry[]>(SHORTLIST_CACHE_KEY)) || []
    );
  }
}
