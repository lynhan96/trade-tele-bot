import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import { MarketDataService, Ticker24h } from "../market-data/market-data.service";
import { FuturesAnalyticsService, CoinAnalytics } from "../market-data/futures-analytics.service";
import { CoinGeckoService } from "../coingecko/coingecko.service";

export interface CoinShortlistEntry {
  symbol: string; // "BTCUSDT"
  coin: string; // "BTC"
  currency: string; // "USDT"
  priceChangePercent: number;
  quoteVolume: number; // USD volume
  lastPrice: number;
  score?: number; // composite quality score
}

const SHORTLIST_CACHE_KEY = "cache:filter:shortlist";
const SHORTLIST_TTL = 360; // 6 minutes
const AI_MARKET_FILTERS_KEY = "cache:ai:market-filters";

// Commodities & TradFi — not crypto, different market dynamics, skip from scan
const COMMODITY_BLACKLIST = new Set([
  "XAUUSDT", "XAGUSDT", "PAXGUSDT",   // gold, silver
  "TSLAUSDT", "MSTRUSDT",              // stocks
]);

@Injectable()
export class CoinFilterService {
  private readonly logger = new Logger(CoinFilterService.name);

  // Fixed priority coins that are always included if on USDT futures
  private readonly priorityCoins = ["BTC", "ETH", "SOL", "BNB", "XRP"];

  constructor(
    private readonly redisService: RedisService,
    private readonly marketDataService: MarketDataService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly configService: ConfigService,
    private readonly coinGeckoService: CoinGeckoService,
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

    const configuredMax = parseInt(
      this.configService.get("AI_MAX_SHORTLIST_SIZE", "25"),
    );

    if (aiConfig?.minVolumeUsd) {
      // .env is the hard cap — AI can suggest a larger list but we cap it
      return {
        ...aiConfig,
        maxShortlistSize: Math.min(aiConfig.maxShortlistSize, configuredMax),
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
      maxShortlistSize: configuredMax,
      source: "env",
    };
  }

  /**
   * Compute composite quality score for a coin.
   * Higher score = better trading candidate.
   * Weights: volume (35%) + volatility (25%) + futures analytics (25%) + social momentum (15%)
   * When CoinGecko is disabled, social weight is redistributed to volume/volatility.
   */
  private computeScore(
    entry: { quoteVolume: number; priceChangePercent: number; coin?: string },
    analytics: CoinAnalytics | undefined,
    volumeMax: number,
    changeMax: number,
    trendingSymbols?: Set<string>,
  ): number {
    // Volume score (0-1): normalized log scale to avoid mega-cap dominance
    const volScore = volumeMax > 0
      ? Math.log10(1 + entry.quoteVolume) / Math.log10(1 + volumeMax)
      : 0;

    // Volatility score (0-1): higher price change = more tradeable
    const volatilityScore = changeMax > 0
      ? entry.priceChangePercent / changeMax
      : 0;

    // Analytics score (0-1): composite of funding neutrality, L/S balance, taker activity
    let analyticsScore = 0.5; // default if no analytics
    if (analytics) {
      // Neutral funding is best (0.0001 = 0.01%); extreme funding penalized
      const fundingPenalty = Math.min(1, Math.abs(analytics.fundingRate) / 0.001);
      const fundingScore = 1 - fundingPenalty;

      // Balanced L/S is best (ratio near 1.0); extremes penalized
      const lsDeviation = Math.abs(analytics.longShortRatio - 1.0);
      const lsScore = Math.max(0, 1 - lsDeviation / 2);

      // High taker activity = more aggressive order flow = more signal potential
      const takerScore = Math.min(1, (analytics.takerBuyRatio || 1) / 2);

      analyticsScore = fundingScore * 0.3 + lsScore * 0.3 + takerScore * 0.4;
    }

    // Social momentum score (0-1): CoinGecko trending boost
    const hasSocial = trendingSymbols && trendingSymbols.size > 0;
    let socialScore = 0;
    if (hasSocial && entry.coin) {
      socialScore = trendingSymbols.has(entry.coin) ? 1.0 : 0;
    }

    // Volume tier bonus: reward high-volume coins (more liquid, less manipulation)
    // >$500M = +0.15, >$200M = +0.10, >$100M = +0.05, <$50M = -0.05 penalty
    let volumeTierBonus = 0;
    if (entry.quoteVolume >= 500_000_000) volumeTierBonus = 0.15;
    else if (entry.quoteVolume >= 200_000_000) volumeTierBonus = 0.10;
    else if (entry.quoteVolume >= 100_000_000) volumeTierBonus = 0.05;
    else if (entry.quoteVolume < 50_000_000) volumeTierBonus = -0.05;

    // Weighted total — redistribute social weight when CoinGecko disabled
    const base = hasSocial
      ? volScore * 0.35 + volatilityScore * 0.25 + analyticsScore * 0.25 + socialScore * 0.15
      : volScore * 0.4 + volatilityScore * 0.3 + analyticsScore * 0.3;
    return base + volumeTierBonus;
  }

  /**
   * Scan and compute the shortlist of coins to watch.
   * Called every 5 minutes by AiSignalService.
   * Uses composite scoring: volume (40%) + volatility (30%) + futures analytics (30%).
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
        !COMMODITY_BLACKLIST.has(t.symbol) && // exclude commodities/TradFi
        parseFloat(t.quoteVolume) >= minVolumeUsd,
    );

    // Build base entries
    const entries = usdtPairs.map((t) => ({
      symbol: t.symbol,
      coin: t.symbol.replace("USDT", ""),
      currency: "USDT" as const,
      priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
      quoteVolume: parseFloat(t.quoteVolume),
      lastPrice: parseFloat(t.lastPrice),
    }));

    // Get cached futures analytics for scoring
    const analytics = await this.futuresAnalyticsService.getCachedAnalytics();

    // Get CoinGecko trending coins (if enabled)
    let trendingSymbols: Set<string> | undefined;
    if (this.coinGeckoService.isEnabled()) {
      try {
        const trending = await this.coinGeckoService.getTrendingSymbols();
        trendingSymbols = new Set(trending);
        if (trending.length > 0) {
          this.logger.debug(`[CoinFilter] CoinGecko trending: ${trending.join(", ")}`);
        }
      } catch (err) {
        this.logger.debug("[CoinFilter] CoinGecko fetch failed, scoring without social data");
      }
    }

    // Compute normalization bounds
    const volumeMax = Math.max(...entries.map((e) => e.quoteVolume), 1);
    const changeMax = Math.max(...entries.map((e) => e.priceChangePercent), 0.1);

    // Score and sort by composite quality
    const scored: (CoinShortlistEntry & { score: number })[] = entries.map((e) => ({
      ...e,
      score: this.computeScore(e, analytics.get(e.symbol), volumeMax, changeMax, trendingSymbols),
    }));
    scored.sort((a, b) => b.score - a.score);

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

    // Fill remaining slots with top-scored coins
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
