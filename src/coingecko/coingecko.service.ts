import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";

/**
 * CoinGecko integration for social momentum and trending coin detection.
 * Toggle: enabled when COINGECKO_API_KEY env var is set.
 * Free Demo tier: 10k calls/month, 30 calls/min — polls conservatively.
 */

export interface TrendingCoin {
  id: string;
  symbol: string;      // e.g. "btc"
  name: string;
  marketCapRank: number;
  priceChangePercent24h: number;
  score: number;        // CoinGecko trending score (0 = most trending)
}

export interface CategoryTrend {
  id: string;
  name: string;         // e.g. "Artificial Intelligence", "Meme"
  marketCapChange24h: number;
  volume24h: number;
  topCoins: string[];   // top coin IDs in this category
}

export interface CoinSocialData {
  id: string;
  symbol: string;
  twitterFollowers: number;
  redditSubscribers: number;
  redditActiveAccounts48h: number;
  telegramUsers: number;
  communityScore: number;     // CoinGecko's own score
  developerScore: number;
  socialMomentumScore: number; // computed by us: normalized 0-1
}

const CACHE_TRENDING_KEY = "cache:coingecko:trending";
const CACHE_CATEGORIES_KEY = "cache:coingecko:categories";
const CACHE_SOCIAL_PREFIX = "cache:coingecko:social:";
const CACHE_BTC_DOM_KEY = "cache:coingecko:btc-dominance";
const CACHE_BTC_DOM_PREV_KEY = "cache:coingecko:btc-dominance:prev";
const CACHE_TRENDING_TTL = 30 * 60;    // 30 min (trending updates every 10 min on CG)
const CACHE_CATEGORIES_TTL = 60 * 60;  // 1 hour
const CACHE_SOCIAL_TTL = 2 * 60 * 60;  // 2 hours (save calls on free tier)
const CACHE_BTC_DOM_TTL = 15 * 60;     // 15 min — BTC.D changes slowly
const CACHE_BTC_DOM_PREV_TTL = 45 * 60; // prev snapshot kept 45 min (delta window)

// CoinGecko symbol → Binance symbol mapping for common discrepancies
const SYMBOL_MAP: Record<string, string> = {
  // Add overrides here if CoinGecko uses a different symbol than Binance
};

@Injectable()
export class CoinGeckoService implements OnModuleInit {
  private readonly logger = new Logger(CoinGeckoService.name);
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private lastCallTime = 0;
  private callCount = 0;
  private callCountResetAt = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.apiKey = configService.get<string>("COINGECKO_API_KEY") || null;
    this.enabled = !!this.apiKey;

    // Demo (free) uses api.coingecko.com; paid uses pro-api.coingecko.com
    const isPaid = configService.get<string>("COINGECKO_PAID", "false") === "true";
    this.baseUrl = isPaid
      ? "https://pro-api.coingecko.com/api/v3"
      : "https://api.coingecko.com/api/v3";
  }

  async onModuleInit() {
    if (this.enabled) {
      this.logger.log("[CoinGecko] Enabled — social momentum scoring active");
    } else {
      this.logger.log("[CoinGecko] Disabled — set COINGECKO_API_KEY to enable");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ─── Rate limiting (30 calls/min for free tier) ────────────────────────

  private async rateLimitedFetch(url: string): Promise<any> {
    const now = Date.now();

    // Reset counter every minute
    if (now - this.callCountResetAt > 60_000) {
      this.callCount = 0;
      this.callCountResetAt = now;
    }

    // Free tier: 30 calls/min
    const maxPerMin = parseInt(this.configService.get("COINGECKO_RATE_LIMIT", "25"));
    if (this.callCount >= maxPerMin) {
      this.logger.debug("[CoinGecko] Rate limit reached, skipping call");
      return null;
    }

    // Min 2s between calls to be safe
    const elapsed = now - this.lastCallTime;
    if (elapsed < 2000) {
      await new Promise(r => setTimeout(r, 2000 - elapsed));
    }

    try {
      const axios = require("axios");
      const headers: Record<string, string> = {};

      const isPaid = this.configService.get<string>("COINGECKO_PAID", "false") === "true";
      if (isPaid) {
        headers["x-cg-pro-api-key"] = this.apiKey;
      } else {
        headers["x-cg-demo-api-key"] = this.apiKey;
      }

      const response = await axios.get(url, {
        headers,
        timeout: 10_000,
      });

      this.lastCallTime = Date.now();
      this.callCount++;

      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        this.logger.warn("[CoinGecko] Rate limited (429), backing off");
      } else {
        this.logger.warn(`[CoinGecko] API error: ${status || err.message}`);
      }
      return null;
    }
  }

  // ─── Trending Coins ───────────────────────────────────────────────────

  async fetchTrending(): Promise<TrendingCoin[]> {
    if (!this.enabled) return [];

    const cached = await this.redisService.get<TrendingCoin[]>(CACHE_TRENDING_KEY);
    if (cached) return cached;

    const data = await this.rateLimitedFetch(`${this.baseUrl}/search/trending`);
    if (!data?.coins) return [];

    const trending: TrendingCoin[] = data.coins.map((item: any, idx: number) => ({
      id: item.item?.id || "",
      symbol: (item.item?.symbol || "").toLowerCase(),
      name: item.item?.name || "",
      marketCapRank: item.item?.market_cap_rank || 0,
      priceChangePercent24h: item.item?.data?.price_change_percentage_24h?.usd || 0,
      score: idx, // 0 = most trending
    }));

    await this.redisService.set(CACHE_TRENDING_KEY, trending, CACHE_TRENDING_TTL);
    this.logger.log(`[CoinGecko] Fetched ${trending.length} trending coins: ${trending.map(t => t.symbol).join(", ")}`);

    return trending;
  }

  // ─── Category Trends ──────────────────────────────────────────────────

  async fetchCategories(): Promise<CategoryTrend[]> {
    if (!this.enabled) return [];

    const cached = await this.redisService.get<CategoryTrend[]>(CACHE_CATEGORIES_KEY);
    if (cached) return cached;

    const data = await this.rateLimitedFetch(
      `${this.baseUrl}/coins/categories?order=market_cap_change_24h_desc`,
    );
    if (!data || !Array.isArray(data)) return [];

    // Top 20 categories by 24h market cap change
    const categories: CategoryTrend[] = data.slice(0, 20).map((cat: any) => ({
      id: cat.id || "",
      name: cat.name || "",
      marketCapChange24h: cat.market_cap_change_24h || 0,
      volume24h: cat.volume_24h || 0,
      topCoins: (cat.top_3_coins || []).map((url: string) => {
        // Extract coin ID from image URL (best effort)
        const match = url.match(/\/coins\/images\/(\d+)\//);
        return match ? match[1] : "";
      }),
    }));

    await this.redisService.set(CACHE_CATEGORIES_KEY, categories, CACHE_CATEGORIES_TTL);
    this.logger.log(`[CoinGecko] Fetched ${categories.length} categories, top: ${categories.slice(0, 3).map(c => `${c.name}(${c.marketCapChange24h?.toFixed(1)}%)`).join(", ")}`);

    return categories;
  }

  // ─── Coin Social Data ─────────────────────────────────────────────────

  async fetchCoinSocial(coinId: string): Promise<CoinSocialData | null> {
    if (!this.enabled) return null;

    const cacheKey = `${CACHE_SOCIAL_PREFIX}${coinId}`;
    const cached = await this.redisService.get<CoinSocialData>(cacheKey);
    if (cached) return cached;

    const data = await this.rateLimitedFetch(
      `${this.baseUrl}/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=true`,
    );
    if (!data) return null;

    const community = data.community_data || {};
    const developer = data.developer_data || {};

    // Compute social momentum: weighted combination of community activity
    const twitterFollowers = community.twitter_followers || 0;
    const redditSubs = community.reddit_subscribers || 0;
    const redditActive = community.reddit_accounts_active_48h || 0;
    const telegramUsers = community.telegram_channel_user_count || 0;

    // Normalize each metric to 0-1 scale using realistic caps
    const twitterScore = Math.min(1, twitterFollowers / 5_000_000);
    const redditScore = Math.min(1, redditSubs / 2_000_000);
    const redditActiveScore = Math.min(1, redditActive / 50_000);
    const telegramScore = Math.min(1, telegramUsers / 500_000);

    // Weighted social momentum (emphasize active engagement over total followers)
    const socialMomentumScore =
      twitterScore * 0.2 +
      redditScore * 0.15 +
      redditActiveScore * 0.35 + // active engagement matters most
      telegramScore * 0.3;

    const result: CoinSocialData = {
      id: data.id,
      symbol: (data.symbol || "").toLowerCase(),
      twitterFollowers,
      redditSubscribers: redditSubs,
      redditActiveAccounts48h: redditActive,
      telegramUsers,
      communityScore: data.community_score || 0,
      developerScore: data.developer_score || 0,
      socialMomentumScore,
    };

    await this.redisService.set(cacheKey, result, CACHE_SOCIAL_TTL);
    return result;
  }

  // ─── Aggregate: get social momentum for a Binance symbol ──────────────

  /**
   * Map a Binance symbol (e.g. "BTC") to CoinGecko ID and fetch social data.
   * Uses the trending coins list as a lookup table.
   */
  async getSocialMomentumForSymbol(binanceSymbol: string): Promise<number> {
    if (!this.enabled) return 0;

    const symbol = binanceSymbol.toLowerCase();
    const mappedSymbol = SYMBOL_MAP[symbol] || symbol;

    // Check if this coin is trending (big boost)
    const trending = await this.fetchTrending();
    const trendingEntry = trending.find(t => t.symbol === mappedSymbol);
    const trendingBoost = trendingEntry
      ? Math.max(0, 1 - trendingEntry.score / 10) * 0.3 // top trending = +0.3
      : 0;

    return trendingBoost; // For free tier, just use trending status
  }

  // ─── BTC Dominance ─────────────────────────────────────────────────────

  /**
   * Fetch BTC market cap dominance from CoinGecko public /global endpoint.
   * Does NOT require an API key — uses public API with no auth.
   * Returns { current, delta30m } where delta30m = change over last ~30 minutes.
   * Positive delta = BTC.D rising (altcoin money flowing to BTC → long trap risk).
   * Fail-open: returns null on error so callers can skip the filter safely.
   */
  async getBtcDominanceDelta(): Promise<{ current: number; delta30m: number } | null> {
    try {
      // Fetch current BTC.D (cached 15min)
      let current = await this.redisService.get<number>(CACHE_BTC_DOM_KEY);
      if (current == null) {
        const axios = require("axios");
        const res = await axios.get("https://api.coingecko.com/api/v3/global", { timeout: 8_000 });
        const dom = res?.data?.data?.market_cap_percentage?.btc;
        if (dom == null) return null;
        current = parseFloat(dom.toFixed(4));

        // Rotate: save old current as prev before overwriting
        const prev = await this.redisService.get<number>(CACHE_BTC_DOM_KEY);
        if (prev != null) {
          await this.redisService.set(CACHE_BTC_DOM_PREV_KEY, prev, CACHE_BTC_DOM_PREV_TTL);
        }
        await this.redisService.set(CACHE_BTC_DOM_KEY, current, CACHE_BTC_DOM_TTL);
        this.logger.debug(`[CoinGecko] BTC Dominance: ${current.toFixed(2)}%`);
      }

      const prev = await this.redisService.get<number>(CACHE_BTC_DOM_PREV_KEY);
      const delta30m = prev != null ? current - prev : 0;
      return { current, delta30m };
    } catch (err: any) {
      this.logger.debug(`[CoinGecko] BTC dominance fetch error: ${err?.message}`);
      return null;
    }
  }

  /**
   * Get all currently trending coin symbols (uppercase, Binance format).
   */
  async getTrendingSymbols(): Promise<string[]> {
    const trending = await this.fetchTrending();
    return trending.map(t => (SYMBOL_MAP[t.symbol] || t.symbol).toUpperCase());
  }

  /**
   * Get category trend data for sector-level analysis.
   * Returns the top trending categories (positive 24h market cap change).
   */
  async getHotCategories(): Promise<CategoryTrend[]> {
    const categories = await this.fetchCategories();
    return categories.filter(c => c.marketCapChange24h > 0);
  }
}
