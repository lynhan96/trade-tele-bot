import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TradingConfigService } from './trading-config';

export interface RiskScoreResult {
  score: number;
  blocked: boolean;
  breakdown: Record<string, { score: number; weight: number; reason: string }>;
}

@Injectable()
export class RiskScoreService {
  private readonly logger = new Logger(RiskScoreService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly marketDataService: MarketDataService,
    private readonly tradingConfig: TradingConfigService,
  ) {}

  async computeRiskScore(
    coin: string,
    isLong: boolean,
    globalRegime: string,
    marketGuard: any,
    agentBrain: any,
    fundingRate: number,
    cfg: any,
  ): Promise<RiskScoreResult> {
    const breakdown: Record<
      string,
      { score: number; weight: number; reason: string }
    > = {};

    // 1. Regime direction (weight 25%)
    // STRONG_BEAR + LONG = 100, STRONG_BULL + SHORT = 100
    // BEARISH + LONG = 60, BULLISH + SHORT = 60
    // MIXED/RANGE_BOUND = 20, aligned = 0
    let regimeScore = 0;
    const regimeReason = [];
    if (globalRegime === 'STRONG_BEAR' && isLong) {
      regimeScore = 100;
      regimeReason.push('STRONG_BEAR vs LONG');
    } else if (globalRegime === 'STRONG_BULL' && !isLong) {
      regimeScore = 100;
      regimeReason.push('STRONG_BULL vs SHORT');
    } else if (globalRegime === 'BEARISH' && isLong) {
      regimeScore = 60;
      regimeReason.push('BEARISH vs LONG');
    } else if (globalRegime === 'BULLISH' && !isLong) {
      regimeScore = 60;
      regimeReason.push('BULLISH vs SHORT');
    } else if (['RANGE_BOUND', 'SIDEWAYS'].includes(globalRegime)) {
      regimeScore = 20;
      regimeReason.push('ranging');
    }
    // Sentiment override — reduce regime score if strong counter-sentiment
    try {
      const sentiment = agentBrain?.marketSentiment || 0;
      if (isLong && sentiment > 30)
        regimeScore = Math.max(0, regimeScore - 40);
      if (!isLong && sentiment < -30)
        regimeScore = Math.max(0, regimeScore - 40);
    } catch {}
    breakdown.regime = {
      score: regimeScore,
      weight: 25,
      reason: regimeReason.join(', ') || 'aligned',
    };

    // 2. Funding rate (weight 20%)
    // Crowded same-side = high risk. |funding| > 0.3% = extreme
    let fundingScore = 0;
    const fundingReason = [];
    const absF = Math.abs(fundingRate || 0);
    if (absF > 0.003) {
      fundingScore = 100;
      fundingReason.push(`extreme ${(fundingRate * 100).toFixed(3)}%`);
    } else if (isLong && fundingRate > 0.001) {
      fundingScore = Math.min(80, (fundingRate / 0.003) * 80);
      fundingReason.push(
        `crowded longs ${(fundingRate * 100).toFixed(3)}%`,
      );
    } else if (!isLong && fundingRate < -0.001) {
      fundingScore = Math.min(80, (absF / 0.003) * 80);
      fundingReason.push(
        `crowded shorts ${(fundingRate * 100).toFixed(3)}%`,
      );
    }
    breakdown.funding = {
      score: Math.round(fundingScore),
      weight: 20,
      reason: fundingReason.join(', ') || 'neutral',
    };

    // 3. EMA trend (weight 20%)
    // Check 4h EMA21 vs EMA50 spread — against trend = high risk
    let emaScore = 0;
    const emaReason = [];
    try {
      const closes = await this.marketDataService.getClosePrices(coin, '4h');
      if (closes.length >= 50) {
        const ema21 = this.calcEma(closes, 21);
        const ema50 = this.calcEma(closes, 50);
        if (ema21 && ema50) {
          const spread = ((ema21 - ema50) / ema50) * 100;
          // LONG against downtrend (ema21 < ema50): spread negative
          if (isLong && spread < -1) {
            emaScore = Math.min(80, Math.abs(spread) * 20);
            emaReason.push(`EMA downtrend spread ${spread.toFixed(1)}%`);
          } else if (!isLong && spread > 1) {
            emaScore = Math.min(80, spread * 20);
            emaReason.push(`EMA uptrend spread ${spread.toFixed(1)}%`);
          }
        }
      }
    } catch {}
    breakdown.emaTrend = {
      score: Math.round(emaScore),
      weight: 20,
      reason: emaReason.join(', ') || 'aligned',
    };

    // 4. Agent brain (weight 15%)
    let agentScore = 0;
    const agentReason = [];
    if (agentBrain) {
      if (isLong && agentBrain.blockLong) {
        agentScore = 80;
        agentReason.push('agent blocks LONG');
      }
      if (!isLong && agentBrain.blockShort) {
        agentScore = 80;
        agentReason.push('agent blocks SHORT');
      }
      // Taker pressure conflict
      if (agentBrain.takerPressure) {
        const tp = agentBrain.takerPressure;
        if (isLong && tp === 'SELL') {
          agentScore = Math.max(agentScore, 40);
          agentReason.push('taker sell pressure');
        }
        if (!isLong && tp === 'BUY') {
          agentScore = Math.max(agentScore, 40);
          agentReason.push('taker buy pressure');
        }
      }
    }
    breakdown.agentBrain = {
      score: agentScore,
      weight: 15,
      reason: agentReason.join(', ') || 'neutral',
    };

    // 5. Market Guard (weight 20%)
    let mgScore = 0;
    const mgReason = [];
    if (marketGuard) {
      if (isLong && marketGuard.blockLong) {
        mgScore = 100;
        mgReason.push('market guard blocks LONG');
      }
      if (!isLong && marketGuard.blockShort) {
        mgScore = 100;
        mgReason.push('market guard blocks SHORT');
      }
    }
    breakdown.marketGuard = {
      score: mgScore,
      weight: 20,
      reason: mgReason.join(', ') || 'clear',
    };

    // Weighted score
    const totalScore = Object.values(breakdown).reduce(
      (sum, b) => sum + (b.score * b.weight) / 100,
      0,
    );
    const threshold = cfg.riskScoreThreshold || 60;
    const blocked = totalScore > threshold;

    if (blocked) {
      const topRisks = Object.entries(breakdown)
        .filter(([, b]) => b.score > 0)
        .sort(([, a], [, b]) => b.score * b.weight - a.score * a.weight)
        .map(([k, b]) => `${k}=${b.score}`)
        .join(', ');
      this.logger.debug(
        `[RiskScore] ${coin} ${isLong ? 'LONG' : 'SHORT'} BLOCKED score=${totalScore.toFixed(0)}/${threshold} [${topRisks}]`,
      );
    }

    return { score: Math.round(totalScore), blocked, breakdown };
  }

  private calcEma(closes: number[], period: number): number | null {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema =
      closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }
}
