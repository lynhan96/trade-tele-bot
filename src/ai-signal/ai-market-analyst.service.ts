import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

/**
 * AI Market Analyst — lightweight wrapper over Redis-cached data.
 *
 * Reads cached analysis results from Redis for use by other services.
 */

// Redis keys
const ANALYSIS_KEY = "cache:ai:market-analysis";
const ALT_PULSE_KEY = "cache:ai:alt-pulse";

export interface AiMarketAnalysis {
  regime: string;
  directionBias: "LONG" | "SHORT" | "NEUTRAL";
  blockLong: boolean;
  blockShort: boolean;
  pauseAll: boolean;
  longConfidenceMin: number;
  shortConfidenceMin: number;
  slAdjust: { min: number; max: number };
  tpAdjust: { min: number; max: number };
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  strategyWeights: Record<string, number>;
  reasoning: string;
  updatedAt: string;
}

export interface AltPulse {
  green4h: number;
  green1h: number;
  avgChange4h: number;
  avgChange1h: number;
  topMovers: string[];
  topLosers: string[];
  momentum: "BULLISH" | "BEARISH" | "NEUTRAL";
  updatedAt: string;
}

export interface SignalGateResult {
  action: "APPROVE" | "REJECT" | "ADJUST";
  adjustedConfidence?: number;
  adjustedSL?: number;
  adjustedTP?: number;
  reason: string;
}

@Injectable()
export class AiMarketAnalystService {
  private readonly logger = new Logger(AiMarketAnalystService.name);

  constructor(
    private readonly redisService: RedisService,
  ) {}

  // DEPRECATED: always returns APPROVE (rule engine handles gating)
  async evaluateSignal(_params: {
    symbol: string;
    direction: "LONG" | "SHORT";
    strategy: string;
    confidence: number;
    entryPrice: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    regime: string;
  }): Promise<SignalGateResult> {
    return { action: "APPROVE", reason: "Rule engine manages gating" };
  }

  /** Get cached analysis */
  async getAnalysis(): Promise<AiMarketAnalysis | null> {
    return this.redisService.get<AiMarketAnalysis>(ANALYSIS_KEY);
  }

  /** Get cached alt pulse */
  async getAltPulse(): Promise<AltPulse | null> {
    return this.redisService.get<AltPulse>(ALT_PULSE_KEY);
  }

  /** Get strategy weight for a specific strategy (default 1.0 = normal) */
  async getStrategyWeight(strategy: string): Promise<number> {
    const weights = await this.redisService.get<Record<string, number>>("cache:ai:strategy-weights");
    return weights?.[strategy] ?? 1.0;
  }
}
