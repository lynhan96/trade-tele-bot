import { Injectable, Logger } from '@nestjs/common';
import { TradingConfigService } from '../../ai-signal/trading-config';
import { FuturesAnalyticsService, CoinAnalytics } from '../../market-data/futures-analytics.service';
import { RedisService } from '../../redis/redis.service';

/**
 * On-Chain Filter Service — Phase 1 (Binance data, free)
 *
 * 1. OI Change Filter — Open Interest momentum
 * 2. Funding Rate Filter — avoid overcrowded positions
 * 3. Long/Short Ratio — contrarian signal
 * 4. Taker Buy/Sell — aggressive flow direction
 *
 * Each filter toggleable via TradingConfig.
 */
@Injectable()
export class OnChainFilterService {
  private readonly logger = new Logger(OnChainFilterService.name);

  constructor(
    private readonly tradingConfig: TradingConfigService,
    private readonly futuresAnalytics: FuturesAnalyticsService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Run all on-chain filters for a coin+direction.
   * Returns pass/block with reasons.
   */
  async checkAll(
    coin: string,
    isLong: boolean,
  ): Promise<{ pass: boolean; reasons: string[] }> {
    const cfg = this.tradingConfig.get();
    if (!cfg.onChainFilterEnabled) {
      return { pass: true, reasons: ['On-chain filters disabled'] };
    }

    const symbol = coin.endsWith('USDT') ? coin : `${coin}USDT`;
    let analytics: CoinAnalytics | null = null;

    try {
      analytics = await this.futuresAnalytics.fetchSingleCoin(symbol);
    } catch (err) {
      this.logger.debug(`[OnChain] ${coin} fetch failed: ${err.message}`);
      return { pass: true, reasons: ['Data unavailable — skip'] };
    }

    if (!analytics) {
      return { pass: true, reasons: ['No analytics data — skip'] };
    }

    const results = await Promise.all([
      this.checkFundingRate(coin, isLong, analytics, cfg),
      this.checkLongShortRatio(coin, isLong, analytics, cfg),
      this.checkTakerFlow(coin, isLong, analytics, cfg),
      this.checkOIChange(coin, isLong, symbol, cfg),
    ]);

    const blocked = results.filter((r) => !r.pass);
    const reasons = results.map((r) => r.reason);

    if (blocked.length > 0) {
      this.logger.debug(
        `[OnChain] ${coin} ${isLong ? 'LONG' : 'SHORT'} BLOCKED: ${blocked.map((r) => r.reason).join(' | ')}`,
      );
    }

    return {
      pass: blocked.length === 0,
      reasons,
    };
  }

  /**
   * 1. Funding Rate Filter
   * FR > 0.05% → too many longs, avoid LONG (likely to dump)
   * FR < -0.05% → too many shorts, avoid SHORT (likely to squeeze)
   * FR near 0 → neutral, OK
   */
  private async checkFundingRate(
    coin: string,
    isLong: boolean,
    analytics: CoinAnalytics,
    cfg: any,
  ): Promise<{ pass: boolean; reason: string }> {
    if (!cfg.onChainFundingRateEnabled) {
      return { pass: true, reason: 'FR: disabled' };
    }

    const fr = analytics.fundingRate;
    const frPct = fr * 100; // Convert to %
    const threshold = cfg.onChainFundingThreshold || 0.05; // 0.05%

    if (isLong && frPct > threshold) {
      return {
        pass: false,
        reason: `FR: ${frPct.toFixed(4)}% > ${threshold}% — overcrowded LONG, avoid`,
      };
    }

    if (!isLong && frPct < -threshold) {
      return {
        pass: false,
        reason: `FR: ${frPct.toFixed(4)}% < -${threshold}% — overcrowded SHORT, avoid`,
      };
    }

    return {
      pass: true,
      reason: `FR: ${frPct.toFixed(4)}% OK`,
    };
  }

  /**
   * 2. Long/Short Ratio — Contrarian Filter
   * Retail > 60% LONG → contrarian SHORT signal (avoid LONG)
   * Retail > 60% SHORT → contrarian LONG signal (avoid SHORT)
   */
  private async checkLongShortRatio(
    coin: string,
    isLong: boolean,
    analytics: CoinAnalytics,
    cfg: any,
  ): Promise<{ pass: boolean; reason: string }> {
    if (!cfg.onChainLongShortEnabled) {
      return { pass: true, reason: 'L/S: disabled' };
    }

    const longPct = analytics.longPercent;
    const shortPct = analytics.shortPercent;
    const extremeThreshold = cfg.onChainLongShortExtreme || 60; // 60%

    if (isLong && longPct > extremeThreshold) {
      return {
        pass: false,
        reason: `L/S: ${longPct.toFixed(1)}% LONG (>${extremeThreshold}%) — contrarian, avoid LONG`,
      };
    }

    if (!isLong && shortPct > extremeThreshold) {
      return {
        pass: false,
        reason: `L/S: ${shortPct.toFixed(1)}% SHORT (>${extremeThreshold}%) — contrarian, avoid SHORT`,
      };
    }

    return {
      pass: true,
      reason: `L/S: ${longPct.toFixed(1)}%L/${shortPct.toFixed(1)}%S OK`,
    };
  }

  /**
   * 3. Taker Flow — Aggressive buying/selling
   * Taker buy ratio > 1.2 → strong buying pressure → confirm LONG
   * Taker buy ratio < 0.8 → strong selling pressure → confirm SHORT
   * Between 0.8-1.2 → neutral, don't block
   */
  private async checkTakerFlow(
    coin: string,
    isLong: boolean,
    analytics: CoinAnalytics,
    cfg: any,
  ): Promise<{ pass: boolean; reason: string }> {
    if (!cfg.onChainTakerFlowEnabled) {
      return { pass: true, reason: 'Taker: disabled' };
    }

    const ratio = analytics.takerBuyRatio;
    if (!ratio || ratio === 0) {
      return { pass: true, reason: 'Taker: no data' };
    }

    const sellThreshold = cfg.onChainTakerSellThreshold || 0.7;
    const buyThreshold = cfg.onChainTakerBuyThreshold || 1.3;

    // Strong selling but trying to LONG → bad
    if (isLong && ratio < sellThreshold) {
      return {
        pass: false,
        reason: `Taker: ${ratio.toFixed(2)} (strong sell <${sellThreshold}) — avoid LONG`,
      };
    }

    // Strong buying but trying to SHORT → bad
    if (!isLong && ratio > buyThreshold) {
      return {
        pass: false,
        reason: `Taker: ${ratio.toFixed(2)} (strong buy >${buyThreshold}) — avoid SHORT`,
      };
    }

    const label = ratio > 1.1 ? 'BUY' : ratio < 0.9 ? 'SELL' : 'NEUTRAL';
    return {
      pass: true,
      reason: `Taker: ${ratio.toFixed(2)} ${label} OK`,
    };
  }

  /**
   * 4. OI Change Filter — Open Interest momentum
   * OI surge + price up → strong LONG (confirm)
   * OI surge + price down → new SHORT positions (confirm SHORT)
   * OI drop → positions closing, avoid new entry
   */
  private async checkOIChange(
    coin: string,
    isLong: boolean,
    symbol: string,
    cfg: any,
  ): Promise<{ pass: boolean; reason: string }> {
    if (!cfg.onChainOIEnabled) {
      return { pass: true, reason: 'OI: disabled' };
    }

    try {
      // Get current and previous OI from Redis cache
      const prevKey = `cache:futures:prev_oi:${symbol}`;
      const prevOI = await this.redisService.get(prevKey);

      // Fetch current OI
      const axios = require('axios');
      const { getProxyAgent } = require('../../utils/proxy');
      const agent = getProxyAgent();
      const res = await axios.get('https://fapi.binance.com/fapi/v1/openInterest', {
        params: { symbol },
        timeout: 5000,
        ...(agent ? { httpsAgent: agent } : {}),
      });

      const currentOI = parseFloat(res.data?.openInterest || '0');
      if (currentOI <= 0) return { pass: true, reason: 'OI: no data' };

      // Store current as prev for next check
      await this.redisService.set(prevKey, currentOI, 3600); // 1h TTL

      if (!prevOI || prevOI === 0) {
        return { pass: true, reason: `OI: ${(currentOI / 1000).toFixed(0)}K (first read)` };
      }

      const oiChangePct = ((currentOI - Number(prevOI)) / Number(prevOI)) * 100;
      const dropThreshold = cfg.onChainOIDropThreshold || -5; // -5% drop = positions closing

      // OI dropping significantly → avoid new entry
      if (oiChangePct < dropThreshold) {
        return {
          pass: false,
          reason: `OI: ${oiChangePct.toFixed(1)}% drop — positions closing, avoid entry`,
        };
      }

      const label = oiChangePct > 3 ? '↑SURGE' : oiChangePct < -1 ? '↓DROP' : '→STABLE';
      return {
        pass: true,
        reason: `OI: ${oiChangePct.toFixed(1)}% ${label}`,
      };
    } catch (err) {
      return { pass: true, reason: 'OI: fetch error — skip' };
    }
  }
}
