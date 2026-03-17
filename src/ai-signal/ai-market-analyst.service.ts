import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { RedisService } from "../redis/redis.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { TelegramBotService } from "../telegram/telegram.service";
import { MarketDataService } from "../market-data/market-data.service";
import { FuturesAnalyticsService } from "../market-data/futures-analytics.service";
import { IndicatorService } from "../strategy/indicators/indicator.service";
import { TradingConfigService } from "./trading-config";
import { MarketGuard } from "./strategy-auto-tuner.service";

/**
 * AI Market Analyst — replaces rule-based Market Guard with AI-driven analysis.
 *
 * 3 Tiers:
 * 1. Market Analyst (every 15min, Haiku) — alt pulse, direction bias, dynamic SL/TP
 * 2. Signal Gate (per signal, Haiku) — approve/reject/adjust each signal with market context
 * 3. Strategy Learner (every 4h, Sonnet) — analyze recent performance, auto-adjust config
 *
 * Redis keys:
 * - cache:ai:market-analysis → full AI analysis result
 * - cache:ai:alt-pulse → alt market momentum data
 * - cache:ai:market-guard → MarketGuard (backward compatible)
 */

// Redis keys
const ANALYSIS_KEY = "cache:ai:market-analysis";
const ALT_PULSE_KEY = "cache:ai:alt-pulse";
const MARKET_GUARD_KEY = "cache:ai:market-guard";
const SIGNAL_GATE_KEY = "cache:ai:signal-gate"; // per-symbol: cache:ai:signal-gate:{symbol}
const ANALYSIS_TTL = 20 * 60; // 20min (re-evaluated every 15min)
const SIGNAL_GATE_TTL = 10 * 60; // 10min cache per signal gate decision

// Top alts to scan for pulse (always available in MarketDataService)
const PULSE_COINS = [
  "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "LINK", "DOT", "AVAX",
  "MATIC", "UNI", "ARB", "OP", "FIL", "NEAR", "ATOM", "APT", "SUI",
  "FET", "RENDER", "INJ", "TIA", "SEI", "WLD", "JUP",
];

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
  private readonly anthropic: Anthropic | null = null;

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    private readonly redisService: RedisService,
    private readonly telegramService: TelegramBotService,
    private readonly marketDataService: MarketDataService,
    private readonly futuresAnalyticsService: FuturesAnalyticsService,
    private readonly indicatorService: IndicatorService,
    private readonly configService: ConfigService,
    private readonly tradingConfig: TradingConfigService,
  ) {
    const apiKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    if (apiKey) this.anthropic = new Anthropic({ apiKey });
    // Run on startup with delay
    setTimeout(() => this.runMarketAnalysis().catch(() => {}), 45_000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: AI MARKET ANALYST (every 15min)
  // ═══════════════════════════════════════════════════════════════════════════

  @Cron("30 */15 * * * *") // every 15min at :30s (offset from old Market Guard)
  async runMarketAnalysis(): Promise<void> {
    if (!this.anthropic) {
      this.logger.warn("[AIAnalyst] No ANTHROPIC_API_KEY — skipping");
      return;
    }

    try {
      // 1. Calculate Alt Pulse
      const altPulse = await this.calculateAltPulse();
      await this.redisService.set(ALT_PULSE_KEY, altPulse, ANALYSIS_TTL);

      // 2. Gather BTC context
      const btcContext = await this.getBtcContext();

      // 3. Gather recent performance
      const recentPerf = await this.getRecentPerformance();

      // 4. Get active positions summary
      const activePositions = await this.getActivePositionsSummary();

      // 5. Get current config
      const cfg = this.tradingConfig.get();

      // 6. Call AI
      const analysis = await this.callMarketAnalystAI({
        btc: btcContext,
        altPulse,
        recentPerformance: recentPerf,
        activePositions,
        currentConfig: {
          slMin: cfg.slMin, slMax: cfg.slMax,
          tpMin: cfg.tpMin, tpMax: cfg.tpMax,
          confidenceFloor: cfg.confidenceFloor,
        },
      });

      if (!analysis) return;

      // 7. Apply as MarketGuard (backward compatible)
      const guard: MarketGuard = {
        blockLong: analysis.blockLong,
        blockShort: analysis.blockShort,
        pauseAll: analysis.pauseAll,
        confidenceFloor: Math.max(analysis.longConfidenceMin, analysis.shortConfidenceMin),
        reason: analysis.reasoning,
        btcPrice: btcContext.price,
        regime: analysis.regime,
        updatedAt: analysis.updatedAt,
      };

      const prevGuard = await this.redisService.get<MarketGuard>(MARKET_GUARD_KEY);
      await this.redisService.set(MARKET_GUARD_KEY, guard, ANALYSIS_TTL);
      await this.redisService.set(ANALYSIS_KEY, analysis, ANALYSIS_TTL);

      // 8. Apply dynamic SL/TP to TradingConfig
      if (analysis.slAdjust && analysis.tpAdjust) {
        await this.tradingConfig.update({
          slMin: analysis.slAdjust.min,
          slMax: analysis.slAdjust.max,
          tpMin: analysis.tpAdjust.min,
          tpMax: analysis.tpAdjust.max,
        });
      }

      // 9. Notify admin on significant changes
      const changed =
        !prevGuard ||
        prevGuard.blockLong !== guard.blockLong ||
        prevGuard.blockShort !== guard.blockShort ||
        prevGuard.pauseAll !== guard.pauseAll;

      if (changed) {
        const icon = guard.pauseAll ? "🛑" : guard.blockLong ? "🔴" : guard.blockShort ? "🔵" : "🟢";
        const pulseEmoji = altPulse.momentum === "BULLISH" ? "📈" : altPulse.momentum === "BEARISH" ? "📉" : "➡️";
        const biasVi = analysis.directionBias === "LONG" ? "Ưu tiên LONG" : analysis.directionBias === "SHORT" ? "Ưu tiên SHORT" : "Trung lập";
        const riskVi = { LOW: "Thấp", MODERATE: "Trung bình", HIGH: "Cao", EXTREME: "Cực cao" }[analysis.riskLevel] || analysis.riskLevel;
        const msg =
          `${icon} *Phân tích thị trường (AI)*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Chế độ: *${analysis.regime}* | ${biasVi}\n` +
          `Rủi ro: *${riskVi}*\n\n` +
          `${pulseEmoji} Alt: ${altPulse.green4h}% tăng 4h (TB ${altPulse.avgChange4h > 0 ? "+" : ""}${altPulse.avgChange4h.toFixed(1)}%)\n` +
          `Conf tối thiểu: LONG ${analysis.longConfidenceMin} | SHORT ${analysis.shortConfidenceMin}\n` +
          `SL: ${analysis.slAdjust.min}-${analysis.slAdjust.max}% | TP: ${analysis.tpAdjust.min}-${analysis.tpAdjust.max}%\n\n` +
          `_${analysis.reasoning}_`;
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }

      this.logger.log(
        `[AIAnalyst] regime=${analysis.regime} bias=${analysis.directionBias} risk=${analysis.riskLevel} ` +
        `altPulse=${altPulse.momentum}(${altPulse.green4h}%) SL=${analysis.slAdjust.min}-${analysis.slAdjust.max}% TP=${analysis.tpAdjust.min}-${analysis.tpAdjust.max}% | ${analysis.reasoning}`,
      );
    } catch (err) {
      this.logger.error(`[AIAnalyst] Error: ${err?.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: AI SIGNAL GATE (per signal)
  // ═══════════════════════════════════════════════════════════════════════════

  async evaluateSignal(params: {
    symbol: string;
    direction: "LONG" | "SHORT";
    strategy: string;
    confidence: number;
    entryPrice: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    regime: string;
  }): Promise<SignalGateResult> {
    if (!this.anthropic) {
      return { action: "APPROVE", reason: "No AI key — pass-through" };
    }

    // Check cache first (avoid duplicate AI calls for same symbol within 10min)
    const cacheKey = `${SIGNAL_GATE_KEY}:${params.symbol}:${params.direction}`;
    const cached = await this.redisService.get<SignalGateResult>(cacheKey);
    if (cached) return cached;

    try {
      // Gather context
      const analysis = await this.redisService.get<AiMarketAnalysis>(ANALYSIS_KEY);
      const altPulse = await this.redisService.get<AltPulse>(ALT_PULSE_KEY);

      // Per-coin context
      const coin = params.symbol.replace("USDT", "");
      const coinChange4h = await this.getCoinChange(coin, "4h");
      const coinChange1h = await this.getCoinChange(coin, "1h");
      const coinRsi4h = await this.getCoinRsi(coin, "4h");
      const coinEmaAlign = await this.getCoinEmaAlignment(coin);

      // Recent trades for this coin
      const recentCoinTrades = await this.aiSignalModel.find({
        symbol: params.symbol,
        status: "COMPLETED",
        createdAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      }).sort({ positionClosedAt: -1 }).limit(5).lean();

      const coinHistory = recentCoinTrades.map(t => ({
        dir: (t as any).direction,
        pnl: ((t as any).pnlPercent || 0).toFixed(2) + "%",
        strategy: (t as any).strategy,
        close: (t as any).closeReason,
      }));

      const prompt = `You are an AI signal gate for a crypto futures trading bot. Evaluate this signal and decide whether to APPROVE, REJECT, or ADJUST it.

SIGNAL:
- ${params.symbol} ${params.direction} (strategy: ${params.strategy})
- Confidence: ${params.confidence}, Entry: $${params.entryPrice.toFixed(4)}
- SL: ${params.stopLossPercent.toFixed(1)}%, TP: ${params.takeProfitPercent.toFixed(1)}%

COIN CONTEXT:
- 4h change: ${coinChange4h !== null ? coinChange4h.toFixed(2) + "%" : "N/A"}
- 1h change: ${coinChange1h !== null ? coinChange1h.toFixed(2) + "%" : "N/A"}
- 4h RSI: ${coinRsi4h !== null ? coinRsi4h.toFixed(0) : "N/A"}
- 4h EMA trend: ${coinEmaAlign}
- Recent trades: ${coinHistory.length > 0 ? JSON.stringify(coinHistory) : "none"}

MARKET CONTEXT:
- AI regime: ${analysis?.regime || "UNKNOWN"}, bias: ${analysis?.directionBias || "NEUTRAL"}
- Alt pulse: ${altPulse ? `${altPulse.green4h}% green 4h, avg ${altPulse.avgChange4h.toFixed(1)}%, momentum: ${altPulse.momentum}` : "N/A"}
- Risk level: ${analysis?.riskLevel || "UNKNOWN"}

RULES:
- REJECT if signal direction opposes strong market trend (e.g. SHORT when 70%+ alts green and coin in uptrend)
- REJECT if coin has 2+ consecutive losses in same direction recently
- ADJUST if SL/TP doesn't match volatility (e.g. tight SL in volatile coin)
- APPROVE if signal aligns with market direction and has good setup
- When market is bullish, prefer LONG signals on pullbacks; only SHORT with very high confidence
- When market is bearish, prefer SHORT signals on bounces; only LONG with very high confidence

Return ONLY valid JSON (no markdown). "reason" MUST be in Vietnamese:
{"action":"APPROVE|REJECT|ADJUST","adjustedConfidence":75,"adjustedSL":3.0,"adjustedTP":5.0,"reason":"giải thích ngắn gọn bằng tiếng Việt"}

For APPROVE without changes, omit adjusted fields. For REJECT, omit adjusted fields.`;

      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content[0] as any)?.text || "";
      let result: SignalGateResult;
      try {
        result = JSON.parse(text);
      } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) result = JSON.parse(jsonMatch[0]);
        else {
          this.logger.warn(`[SignalGate] Failed to parse: ${text}`);
          return { action: "APPROVE", reason: "Parse error — pass-through" };
        }
      }

      // Validate
      if (!["APPROVE", "REJECT", "ADJUST"].includes(result.action)) {
        result.action = "APPROVE";
      }

      // Cache result
      await this.redisService.set(cacheKey, result, SIGNAL_GATE_TTL);

      this.logger.log(
        `[SignalGate] ${params.symbol} ${params.direction} → ${result.action}: ${result.reason}`,
      );

      return result;
    } catch (err) {
      this.logger.warn(`[SignalGate] Error for ${params.symbol}: ${err?.message}`);
      return { action: "APPROVE", reason: "Error — pass-through" };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: AI STRATEGY LEARNER (every 4h) — enhanced version
  // Already exists in strategy-auto-tuner.service.ts as aiReviewStrategies()
  // This adds dynamic SL/TP + strategy weight recommendations
  // ═══════════════════════════════════════════════════════════════════════════

  @Cron("0 45 */4 * * *") // every 4h at :45 (offset from other crons)
  async runStrategyLearner(): Promise<void> {
    if (!this.anthropic) return;

    try {
      const lookbackDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h only
      const signals = await this.aiSignalModel.find({
        status: "COMPLETED",
        positionClosedAt: { $gte: lookbackDate },
      }).sort({ positionClosedAt: -1 }).lean();

      if (signals.length < 5) {
        this.logger.log("[StrategyLearner] < 5 signals in 24h — skipping");
        return;
      }

      // Build stats
      const byStrategy: Record<string, { n: number; w: number; pnl: number; avgPeak: number; shorts: number; longs: number }> = {};
      const byDirection = { longN: 0, longW: 0, longPnl: 0, shortN: 0, shortW: 0, shortPnl: 0 };
      const avgSL: number[] = [];
      const avgTP: number[] = [];
      const peaks: number[] = [];

      for (const s of signals) {
        const st = (s as any).strategy || "?";
        if (!byStrategy[st]) byStrategy[st] = { n: 0, w: 0, pnl: 0, avgPeak: 0, shorts: 0, longs: 0 };
        byStrategy[st].n++;
        const pnl = (s as any).pnlUsdt || 0;
        byStrategy[st].pnl += pnl;
        if (pnl > 0) byStrategy[st].w++;
        if ((s as any).direction === "SHORT") byStrategy[st].shorts++;
        else byStrategy[st].longs++;
        byStrategy[st].avgPeak += (s as any).peakPnlPct || 0;

        if ((s as any).direction === "LONG") { byDirection.longN++; byDirection.longPnl += pnl; if (pnl > 0) byDirection.longW++; }
        else { byDirection.shortN++; byDirection.shortPnl += pnl; if (pnl > 0) byDirection.shortW++; }

        avgSL.push((s as any).stopLossPercent || 0);
        avgTP.push((s as any).takeProfitPercent || 0);
        peaks.push((s as any).peakPnlPct || 0);
      }

      for (const st of Object.keys(byStrategy)) {
        byStrategy[st].avgPeak = byStrategy[st].n > 0 ? byStrategy[st].avgPeak / byStrategy[st].n : 0;
      }

      const cfg = this.tradingConfig.get();
      const altPulse = await this.redisService.get<AltPulse>(ALT_PULSE_KEY);

      const prompt = `You are an AI trading system optimizer. Analyze 24h performance and recommend config changes.

PERFORMANCE (24h, ${signals.length} trades):
${Object.entries(byStrategy).map(([st, s]) => `${st}: ${s.n} trades (${s.longs}L/${s.shorts}S), WR=${Math.round(s.w / s.n * 100)}%, PnL=$${s.pnl.toFixed(0)}, avgPeak=${s.avgPeak.toFixed(2)}%`).join("\n")}

DIRECTION:
LONG: ${byDirection.longN} trades, WR=${byDirection.longN > 0 ? Math.round(byDirection.longW / byDirection.longN * 100) : 0}%, PnL=$${byDirection.longPnl.toFixed(0)}
SHORT: ${byDirection.shortN} trades, WR=${byDirection.shortN > 0 ? Math.round(byDirection.shortW / byDirection.shortN * 100) : 0}%, PnL=$${byDirection.shortPnl.toFixed(0)}

SL/TP ANALYSIS:
- Avg SL used: ${(avgSL.reduce((a, b) => a + b, 0) / avgSL.length).toFixed(1)}%
- Avg TP used: ${(avgTP.reduce((a, b) => a + b, 0) / avgTP.length).toFixed(1)}%
- Avg peak before close: ${(peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(2)}%
- Trades that peaked > 2%: ${peaks.filter(p => p > 2).length}/${peaks.length}
- Trades with peak = 0% (wrong entry): ${peaks.filter(p => p <= 0.01).length}/${peaks.length}

CURRENT CONFIG: slMin=${cfg.slMin}% slMax=${cfg.slMax}% tpMin=${cfg.tpMin}% tpMax=${cfg.tpMax}% confidenceFloor=${cfg.confidenceFloor}
ALT PULSE: ${altPulse ? `${altPulse.momentum}, ${altPulse.green4h}% green 4h` : "N/A"}

RECENT 5 TRADES:
${signals.slice(0, 5).map(s => `${(s as any).symbol} ${(s as any).direction} ${(s as any).strategy}: pnl=${((s as any).pnlPercent || 0).toFixed(2)}% peak=${((s as any).peakPnlPct || 0).toFixed(2)}% SL=${(s as any).stopLossPercent}% TP=${(s as any).takeProfitPercent}% ${(s as any).closeReason}`).join("\n")}

RULES:
- If many trades have peak=0% (wrong direction), the system is entering counter-trend. Recommend blocking that direction.
- If avgPeak > SL, the SL is too tight (getting stopped before profit). Recommend wider SL.
- If avgPeak < TP/3, the TP is unreachable. Recommend lower TP or use trailing.
- strategyWeights: 0.0=disable, 0.5=reduce signals, 1.0=normal, 1.5=boost priority
- Only recommend changes you're confident about. Don't change what's working.

Return ONLY valid JSON. "reasoning" MUST be in Vietnamese:
{"slMin":2.0,"slMax":4.0,"tpMin":3.0,"tpMax":6.0,"confidenceFloor":65,"strategyWeights":{"RSI_ZONE":0.5,"EMA_PULLBACK":1.0},"directionBias":"LONG","reasoning":"giải thích ngắn gọn bằng tiếng Việt"}`;

      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content[0] as any)?.text || "";
      let actions: any;
      try {
        actions = JSON.parse(text);
      } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) actions = JSON.parse(jsonMatch[0]);
        else throw new Error("No valid JSON");
      }

      const appliedChanges: string[] = [];

      // Apply SL/TP changes
      const configUpdate: any = {};
      if (actions.slMin && actions.slMax) {
        configUpdate.slMin = Math.max(1.0, Math.min(5.0, actions.slMin));
        configUpdate.slMax = Math.max(configUpdate.slMin, Math.min(6.0, actions.slMax));
        appliedChanges.push(`SL: ${cfg.slMin}-${cfg.slMax}% → ${configUpdate.slMin}-${configUpdate.slMax}%`);
      }
      if (actions.tpMin && actions.tpMax) {
        configUpdate.tpMin = Math.max(1.5, Math.min(8.0, actions.tpMin));
        configUpdate.tpMax = Math.max(configUpdate.tpMin, Math.min(10.0, actions.tpMax));
        appliedChanges.push(`TP: ${cfg.tpMin}-${cfg.tpMax}% → ${configUpdate.tpMin}-${configUpdate.tpMax}%`);
      }
      if (actions.confidenceFloor && actions.confidenceFloor !== cfg.confidenceFloor) {
        configUpdate.confidenceFloor = Math.max(55, Math.min(80, actions.confidenceFloor));
        appliedChanges.push(`Confidence floor: ${cfg.confidenceFloor} → ${configUpdate.confidenceFloor}`);
      }

      if (Object.keys(configUpdate).length > 0) {
        await this.tradingConfig.update(configUpdate);
      }

      // Save strategy weights
      if (actions.strategyWeights) {
        await this.redisService.set("cache:ai:strategy-weights", actions.strategyWeights, 5 * 60 * 60);
        const weightStr = Object.entries(actions.strategyWeights as Record<string, number>)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        appliedChanges.push(`Strategy weights: ${weightStr}`);
      }

      // Notify admin
      if (appliedChanges.length > 0) {
        const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || "").split(",").filter(Boolean);
        const msg =
          `🧠 *AI tự điều chỉnh*\n━━━━━━━━━━━━━━━━━━\n\n` +
          appliedChanges.join("\n") +
          `\n\n_${actions.reasoning || ""}_` +
          `\n_${signals.length} lệnh phân tích (24h)_`;
        for (const id of adminIds) {
          await this.telegramService.sendTelegramMessage(parseInt(id), msg).catch(() => {});
        }
      }

      this.logger.log(
        `[StrategyLearner] Applied ${appliedChanges.length} changes: ${appliedChanges.join("; ") || "none"}. Reasoning: ${actions.reasoning || "N/A"}`,
      );
    } catch (err) {
      this.logger.error(`[StrategyLearner] Error: ${err?.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Calculate alt market pulse from top coins */
  private async calculateAltPulse(): Promise<AltPulse> {
    const changes4h: { coin: string; pct: number }[] = [];
    const changes1h: { coin: string; pct: number }[] = [];

    for (const coin of PULSE_COINS) {
      try {
        const c4h = await this.getCoinChange(coin, "4h");
        if (c4h !== null) changes4h.push({ coin, pct: c4h });
        const c1h = await this.getCoinChange(coin, "1h");
        if (c1h !== null) changes1h.push({ coin, pct: c1h });
      } catch {}
    }

    const green4h = changes4h.length > 0 ? Math.round((changes4h.filter(c => c.pct > 0).length / changes4h.length) * 100) : 50;
    const green1h = changes1h.length > 0 ? Math.round((changes1h.filter(c => c.pct > 0).length / changes1h.length) * 100) : 50;
    const avgChange4h = changes4h.length > 0 ? changes4h.reduce((s, c) => s + c.pct, 0) / changes4h.length : 0;
    const avgChange1h = changes1h.length > 0 ? changes1h.reduce((s, c) => s + c.pct, 0) / changes1h.length : 0;

    const sorted4h = [...changes4h].sort((a, b) => b.pct - a.pct);
    const topMovers = sorted4h.slice(0, 3).map(c => `${c.coin} ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}%`);
    const topLosers = sorted4h.slice(-3).reverse().map(c => `${c.coin} ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}%`);

    const momentum: AltPulse["momentum"] =
      green4h >= 65 && avgChange4h > 0.5 ? "BULLISH" :
      green4h <= 35 && avgChange4h < -0.5 ? "BEARISH" : "NEUTRAL";

    return {
      green4h, green1h, avgChange4h, avgChange1h,
      topMovers, topLosers, momentum,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Get coin % change over interval */
  private async getCoinChange(coin: string, interval: string): Promise<number | null> {
    try {
      const closes = await this.indicatorService.getCloses(coin, interval);
      if (closes.length < 2) return null;
      const prev = closes[closes.length - 2];
      const curr = closes[closes.length - 1];
      return prev > 0 ? ((curr - prev) / prev) * 100 : null;
    } catch {
      return null;
    }
  }

  /** Get coin RSI */
  private async getCoinRsi(coin: string, interval: string): Promise<number | null> {
    try {
      const closes = await this.indicatorService.getCloses(coin, interval);
      if (closes.length < 20) return null;
      const rsi = this.indicatorService.getRsi(closes, 14);
      return rsi?.last ?? null;
    } catch {
      return null;
    }
  }

  /** Get coin EMA alignment description */
  private async getCoinEmaAlignment(coin: string): Promise<string> {
    try {
      const closes = await this.indicatorService.getCloses(coin, "4h");
      if (closes.length < 55) return "insufficient data";
      const ema21 = this.indicatorService.getEma(closes, 21);
      const ema50 = this.indicatorService.getEma(closes, 50);
      const spread = ((ema21.last - ema50.last) / ema50.last) * 100;
      if (spread > 1) return `UPTREND (EMA21>EMA50 by ${spread.toFixed(1)}%)`;
      if (spread < -1) return `DOWNTREND (EMA21<EMA50 by ${Math.abs(spread).toFixed(1)}%)`;
      return `NEUTRAL (spread ${spread.toFixed(1)}%)`;
    } catch {
      return "error";
    }
  }

  /** Get BTC context for AI prompt */
  private async getBtcContext(): Promise<{
    price: number; change4h: number; change24h: number;
    rsi: number; ema21vs50: string; funding: number;
  }> {
    const btcRaw = await this.redisService.get<string | number>("price:BTCUSDT");
    const btcPrice = btcRaw ? parseFloat(String(btcRaw)) : 0;

    const btc4hCloses = await this.redisService.get<number[]>("cache:candle:close:BTC:4h") || [];
    let change4h = 0, change24h = 0;
    if (btc4hCloses.length >= 2) {
      const prev = btc4hCloses[btc4hCloses.length - 2];
      change4h = prev > 0 ? ((btcPrice - prev) / prev) * 100 : 0;
    }
    if (btc4hCloses.length >= 7) {
      const prev24h = btc4hCloses[Math.max(0, btc4hCloses.length - 7)];
      change24h = prev24h > 0 ? ((btcPrice - prev24h) / prev24h) * 100 : 0;
    }

    const btcCtx = await this.redisService.get<any>("cache:ai:regime:btc-context");
    const rsi = btcCtx?.rsi ?? 50;
    const ema21vs50 = btcCtx?.priceVsEma200 > 0 ? "above" : "below";

    // Funding from futures analytics
    const analytics = await this.futuresAnalyticsService.getCachedAnalytics();
    const btcFa = analytics.get("BTCUSDT");
    const funding = btcFa?.fundingRate || 0;

    return { price: btcPrice, change4h, change24h, rsi, ema21vs50, funding };
  }

  /** Get recent signal performance */
  private async getRecentPerformance(): Promise<{
    last10: { wr: number; pnl: number; longWR: number; shortWR: number };
    last24h: { n: number; wr: number; pnl: number };
  }> {
    const recent = await this.aiSignalModel.find({ status: "COMPLETED" })
      .sort({ positionClosedAt: -1 }).limit(10).lean();

    let w = 0, longW = 0, longN = 0, shortW = 0, shortN = 0, totalPnl = 0;
    for (const s of recent) {
      const pnl = (s as any).pnlUsdt || 0;
      totalPnl += pnl;
      if (pnl > 0) w++;
      if ((s as any).direction === "LONG") { longN++; if (pnl > 0) longW++; }
      else { shortN++; if (pnl > 0) shortW++; }
    }

    const lookback24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent24h = await this.aiSignalModel.find({
      status: "COMPLETED",
      positionClosedAt: { $gte: lookback24h },
    }).lean();

    let w24 = 0, pnl24 = 0;
    for (const s of recent24h) {
      const pnl = (s as any).pnlUsdt || 0;
      pnl24 += pnl;
      if (pnl > 0) w24++;
    }

    return {
      last10: {
        wr: recent.length > 0 ? Math.round((w / recent.length) * 100) : 50,
        pnl: Math.round(totalPnl * 100) / 100,
        longWR: longN > 0 ? Math.round((longW / longN) * 100) : 50,
        shortWR: shortN > 0 ? Math.round((shortW / shortN) * 100) : 50,
      },
      last24h: {
        n: recent24h.length,
        wr: recent24h.length > 0 ? Math.round((w24 / recent24h.length) * 100) : 50,
        pnl: Math.round(pnl24 * 100) / 100,
      },
    };
  }

  /** Get active positions summary */
  private async getActivePositionsSummary(): Promise<{ longs: number; shorts: number; symbols: string[] }> {
    const actives = await this.aiSignalModel.find({ status: "ACTIVE" }).lean();
    let longs = 0, shorts = 0;
    const symbols: string[] = [];
    for (const s of actives) {
      if ((s as any).direction === "LONG") longs++;
      else shorts++;
      symbols.push((s as any).symbol);
    }
    return { longs, shorts, symbols };
  }

  /** Call AI for market analysis */
  private async callMarketAnalystAI(data: {
    btc: any;
    altPulse: AltPulse;
    recentPerformance: any;
    activePositions: any;
    currentConfig: any;
  }): Promise<AiMarketAnalysis | null> {
    const prompt = `You are an AI market analyst for a crypto futures trading bot. Analyze current market conditions and return trading parameters.

BTC:
- Price: $${data.btc.price.toLocaleString()} | 4h: ${data.btc.change4h > 0 ? "+" : ""}${data.btc.change4h.toFixed(2)}% | 24h: ${data.btc.change24h > 0 ? "+" : ""}${data.btc.change24h.toFixed(2)}%
- RSI: ${data.btc.rsi} | EMA200: ${data.btc.ema21vs50} | Funding: ${(data.btc.funding * 100).toFixed(3)}%

ALT MARKET PULSE:
- ${data.altPulse.green4h}% of top 25 alts are green in 4h (avg ${data.altPulse.avgChange4h > 0 ? "+" : ""}${data.altPulse.avgChange4h.toFixed(2)}%)
- 1h: ${data.altPulse.green1h}% green (avg ${data.altPulse.avgChange1h > 0 ? "+" : ""}${data.altPulse.avgChange1h.toFixed(2)}%)
- Top movers: ${data.altPulse.topMovers.join(", ")}
- Top losers: ${data.altPulse.topLosers.join(", ")}
- Momentum: ${data.altPulse.momentum}

RECENT PERFORMANCE:
- Last 10 trades: WR=${data.recentPerformance.last10.wr}%, PnL=$${data.recentPerformance.last10.pnl}
  LONG WR: ${data.recentPerformance.last10.longWR}% | SHORT WR: ${data.recentPerformance.last10.shortWR}%
- Last 24h: ${data.recentPerformance.last24h.n} trades, WR=${data.recentPerformance.last24h.wr}%, PnL=$${data.recentPerformance.last24h.pnl}

ACTIVE POSITIONS: ${data.activePositions.longs}L / ${data.activePositions.shorts}S
Current config: SL=${data.currentConfig.slMin}-${data.currentConfig.slMax}%, TP=${data.currentConfig.tpMin}-${data.currentConfig.tpMax}%, conf floor=${data.currentConfig.confidenceFloor}

DECISION FRAMEWORK:
1. REGIME: Determine market regime from BTC + alt data
2. DIRECTION BIAS: Which direction should the bot prefer?
   - If 65%+ alts green + avg > 1%: LONG bias (alt rally — find pullback entries)
   - If 65%+ alts red + avg < -1%: SHORT bias (alt dump — find bounce shorts)
   - Otherwise: NEUTRAL
3. CONFIDENCE: Set different min confidence for each direction
   - Favored direction: lower min (63-68) → more signals
   - Counter-trend: higher min (75-85) → only high-quality
4. SL/TP: Adjust based on volatility and peak performance
   - If avg peak > 2%: TP can be 4-6% (trend is giving room)
   - If avg peak < 1%: TP should be 2-3% (tight market)
   - SL should be 1.5× avg adverse move to avoid wick kills
5. RISK: LOW (trending clear), MODERATE (mixed), HIGH (choppy/uncertain), EXTREME (crash)
6. STRATEGY WEIGHTS: 0.0=skip, 0.5=reduce, 1.0=normal, 1.5=boost
   - In uptrend: boost EMA_PULLBACK/TREND_EMA (trend-following), reduce RSI_ZONE (mean-reversion)
   - In downtrend: boost RSI_ZONE SHORT, reduce TREND_EMA LONG
   - In range: RSI_ZONE/SMC_FVG normal, reduce trend strategies
7. blockLong/blockShort: Only true in extreme cases (BTC crash, alt dump >5%)
8. pauseAll: Only if BTC crashes -5%+ in 4h or market extremely uncertain

Return ONLY valid JSON. "reasoning" MUST be in Vietnamese:
{"regime":"RANGE_BOUND","directionBias":"LONG","blockLong":false,"blockShort":false,"pauseAll":false,"longConfidenceMin":63,"shortConfidenceMin":78,"slAdjust":{"min":2.0,"max":4.0},"tpAdjust":{"min":3.0,"max":6.0},"riskLevel":"MODERATE","strategyWeights":{"RSI_ZONE":0.5,"EMA_PULLBACK":1.2,"TREND_EMA":1.0,"SMC_FVG":0.8,"STOCH_EMA_KDJ":0.7,"RSI_CROSS":1.0,"STOCH_BB_PATTERN":0.8,"BB_SCALP":0.5},"reasoning":"giải thích ngắn gọn bằng tiếng Việt"}`;

    try {
      const response = await this.anthropic!.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content[0] as any)?.text || "";
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) result = JSON.parse(jsonMatch[0]);
        else throw new Error("No valid JSON");
      }

      // Validate and sanitize
      return {
        regime: result.regime || "MIXED",
        directionBias: ["LONG", "SHORT", "NEUTRAL"].includes(result.directionBias) ? result.directionBias : "NEUTRAL",
        blockLong: !!result.blockLong,
        blockShort: !!result.blockShort,
        pauseAll: !!result.pauseAll,
        longConfidenceMin: Math.max(55, Math.min(85, result.longConfidenceMin || 63)),
        shortConfidenceMin: Math.max(55, Math.min(85, result.shortConfidenceMin || 63)),
        slAdjust: {
          min: Math.max(1.0, Math.min(5.0, result.slAdjust?.min || 1.5)),
          max: Math.max(2.0, Math.min(6.0, result.slAdjust?.max || 3.0)),
        },
        tpAdjust: {
          min: Math.max(1.5, Math.min(8.0, result.tpAdjust?.min || 2.0)),
          max: Math.max(2.0, Math.min(10.0, result.tpAdjust?.max || 4.0)),
        },
        riskLevel: ["LOW", "MODERATE", "HIGH", "EXTREME"].includes(result.riskLevel) ? result.riskLevel : "MODERATE",
        strategyWeights: result.strategyWeights || {},
        reasoning: result.reasoning || "",
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.error(`[AIAnalyst] AI call error: ${err?.message}`);
      return null;
    }
  }

  /** Get cached analysis (for use by other services) */
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
