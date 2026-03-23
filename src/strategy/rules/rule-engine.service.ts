import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../redis/redis.service";
import { IndicatorService } from "../indicators/indicator.service";
import { SingaporeFiltersService } from "../filters/singapore-filters.service";
import { OnChainFilterService } from "../filters/onchain-filters.service";
import { TradingConfigService } from "../../ai-signal/trading-config";
import { AiTunedParams } from "../ai-optimizer/ai-tuned-params.interface";

export interface SignalResult {
  isLong: boolean; // true = LONG, false = SHORT
  entryPrice: number; // current close price
  strategy: string;
  reason: string; // human-readable
  sgFilters?: string[]; // Singapore filter results
  onChainFilters?: string[]; // On-chain filter results
}

// Redis TTL for 2-stage pattern state
const PATTERN_STATE_TTL = 4 * 60 * 60; // 4 hours

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    private readonly indicatorService: IndicatorService,
    private readonly redisService: RedisService,
    private readonly singaporeFilters: SingaporeFiltersService,
    private readonly onChainFilters: OnChainFilterService,
    private readonly tradingConfig: TradingConfigService,
  ) {}

  /**
   * Main entry point — confluence-based evaluation.
   * Runs ALL configured strategies, collects results, and requires
   * multiple strategies to agree on direction before firing a signal.
   *
   * Confluence rules:
   * - 3+ strategies configured → need 2+ to agree (strong confluence)
   * - 2 strategies configured  → need 2 to agree (both must confirm)
   * - 1 strategy configured    → single strategy is enough (legacy/fallback)
   *
   * Benefits: fewer false signals, higher quality entries, strategy diversity visible.
   */
  async evaluate(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    // Cap confidence threshold — hedge manages risk, let signals flow
    const maxConfThreshold = 68;
    const confThreshold = Math.min(params.minConfidenceToTrade || 60, maxConfThreshold);
    if (params.confidence < confThreshold) {
      this.logger.debug(
        `[RuleEngine] ${coin} skipped — AI confidence ${params.confidence} < threshold ${confThreshold}`,
      );
      return null;
    }

    // Always evaluate ALL active strategies for confluence — not just AI-assigned ones.
    // Individual strategies have their own regime gates (BB_SCALP only in SIDEWAYS/RANGE_BOUND,
    // EMA_PULLBACK only in STRONG_BEAR/BULL, etc.) which naturally filter invalid combos.
    // This fixes: 0/58 confluence signals because AI assigned incompatible strategy combos.
    // TREND_EMA & EMA_PULLBACK re-enabled (2026-03-10) with improvements:
    // TREND_EMA: +RSI exhaustion check + trend freshness (max 1.5% from cross)
    // EMA_PULLBACK: direction from 1h EMA slope (not regime) + 2-candle confirmation + stricter RSI
    const allStrategies = [
      "RSI_CROSS", "TREND_EMA", "EMA_PULLBACK",
      "STOCH_EMA_KDJ", "SMC_FVG", "OP_ONCHAIN",
    ];

    // ── Filter out auto-disabled strategies (StrategyAutoTuner) ──
    const gatesRaw = await this.redisService.get<Record<string, { enabled: boolean }>>("cache:strategy-gates");
    const strategies = allStrategies.filter((s) => {
      if (!gatesRaw || !gatesRaw[s]) return true; // no gate = enabled
      if (!gatesRaw[s].enabled) {
        this.logger.debug(`[RuleEngine] ${coin} ${s} auto-disabled by StrategyAutoTuner`);
        return false;
      }
      return true;
    });

    if (strategies.length === 0) {
      this.logger.debug(`[RuleEngine] ${coin} all strategies disabled — skipping`);
      return null;
    }

    // ── Multi-strategy confluence mode ──
    this.logger.debug(`[RuleEngine] ${coin} confluence check: ${strategies.join(" + ")}`);

    // Run all strategies in parallel and collect results
    const results = await Promise.all(
      strategies.map(async (strategy) => {
        const result = await this.evalStrategy(strategy, coin, currency, params);
        return result ? { strategy, result } : null;
      }),
    );

    const fired = results.filter((r): r is { strategy: string; result: SignalResult } => r !== null);

    if (fired.length === 0) return null;

    // Group by direction
    const longs = fired.filter(f => f.result.isLong);
    const shorts = fired.filter(f => !f.result.isLong);

    // ── Confluence scoring ──
    // 2+ agree on same direction = strong signal (confluence)
    // 1 fires alone = weaker signal, still allowed but noted as "single"
    // Strategies disagree on direction = conflict, skip

    // Check for direction conflict (some say LONG, some say SHORT)
    if (longs.length > 0 && shorts.length > 0) {
      const summary = fired.map(f => `${f.strategy}=${f.result.isLong ? "L" : "S"}`).join(", ");
      this.logger.debug(
        `[RuleEngine] ${coin} ✗ direction conflict: ${summary} — skipped`,
      );
      return null;
    }

    // All fired strategies agree on direction
    const winners = longs.length > 0 ? longs : shorts;
    const isLong = longs.length > 0;
    const primary = winners[0].result;

    // ── Price Position Filter — prevent shorting bottoms & longing tops ──
    // Check where price sits in recent 1h range (20 candles = ~20h)
    // SHORT blocked if price in bottom 30% (shorting the floor)
    // LONG blocked if price in top 30% (longing the ceiling)
    const pricePos = await this.getPricePosition(coin, "1h", 20);
    if (pricePos !== null) {
      if (!isLong && pricePos < 30) {
        this.logger.log(
          `[RuleEngine] ${coin} SHORT blocked: price at ${pricePos.toFixed(0)}% of range (bottom 30%) — don't short the bottom`,
        );
        return null;
      }
      if (isLong && pricePos > 70) {
        this.logger.log(
          `[RuleEngine] ${coin} LONG blocked: price at ${pricePos.toFixed(0)}% of range (top 30%) — don't long the top`,
        );
        return null;
      }
      this.logger.debug(`[RuleEngine] ${coin} price position: ${pricePos.toFixed(0)}% (${isLong ? "LONG" : "SHORT"} OK)`);
    }

    // ── Move Exhaustion Filter — don't chase moves that already happened ──
    // Use 1h candles, 3-candle lookback (3h window) — short enough to not block during sustained trends
    // Threshold: 3% (was 2% on 24h window — too strict, blocked everything after market drops)
    const ohlc1hExhaust = await this.indicatorService.getOhlc(coin, "1h");
    if (ohlc1hExhaust.closes.length >= 3) {
      const recentHighs = ohlc1hExhaust.highs.slice(-3);
      const recentLows = ohlc1hExhaust.lows.slice(-3);
      const recentHigh = Math.max(...recentHighs);
      const recentLow = Math.min(...recentLows);
      const currentPrice = ohlc1hExhaust.closes[ohlc1hExhaust.closes.length - 1];
      const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
      const riseFromLow = ((currentPrice - recentLow) / recentLow) * 100;

      if (!isLong && dropFromHigh > 3) {
        this.logger.log(
          `[RuleEngine] ${coin} SHORT blocked: price dropped ${dropFromHigh.toFixed(1)}% from 3h high — move exhaustion`,
        );
        return null;
      }
      if (isLong && riseFromLow > 3) {
        this.logger.log(
          `[RuleEngine] ${coin} LONG blocked: price rallied ${riseFromLow.toFixed(1)}% from 3h low — move exhaustion`,
        );
        return null;
      }
    }

    // ── Candle Momentum Confirmation — require recent candles to confirm direction ──
    // At least 2 of last 3 candles must align with signal direction
    // LONG: green candles (close > open), SHORT: red candles (close < open)
    const momentumOk = await this.checkCandleMomentum(coin, "15m", isLong);
    if (!momentumOk) {
      this.logger.log(
        `[RuleEngine] ${coin} ${isLong ? "LONG" : "SHORT"} blocked: candle momentum doesn't confirm (need 2/3 candles aligned)`,
      );
      return null;
    }

    // ── RSI Divergence Filter — block signals that go against divergence ──
    // NOTE: RSI divergence filter REMOVED (2026-03-15) — rarely triggers, adds latency (extra OHLC fetch)
    // Divergence detection kept as method for future use if needed.

    // ── Rejection Wick Quality — boost confidence when candle confirms reversal ──
    // For SHORT: upper wick ≥ 40% of candle range = sellers rejected higher prices (top signal)
    // For LONG: lower wick ≥ 40% of candle range = buyers rejected lower prices (bottom signal)
    // Not a hard block — signals can still fire without wick, but wick presence is logged for tracking
    const ohlc15mWick = await this.indicatorService.getOhlc(coin, "15m");
    if (ohlc15mWick.closes.length >= 2) {
      // Check last 2 completed candles for rejection wicks
      for (let i = 1; i <= 2; i++) {
        const idx = ohlc15mWick.closes.length - i;
        const h = ohlc15mWick.highs[idx];
        const l = ohlc15mWick.lows[idx];
        const o = ohlc15mWick.opens[idx];
        const c = ohlc15mWick.closes[idx];
        const candleRange = h - l;
        if (candleRange <= 0) continue;

        const upperWick = h - Math.max(o, c);
        const lowerWick = Math.min(o, c) - l;

        if (!isLong && upperWick / candleRange >= 0.4) {
          this.logger.debug(`[RuleEngine] ${coin} SHORT: rejection wick found (upper=${(upperWick/candleRange*100).toFixed(0)}%) — good reversal signal`);
          break;
        }
        if (isLong && lowerWick / candleRange >= 0.4) {
          this.logger.debug(`[RuleEngine] ${coin} LONG: rejection wick found (lower=${(lowerWick/candleRange*100).toFixed(0)}%) — good reversal signal`);
          break;
        }
      }
    }

    // ── Singapore Strategy Filters — OP Line + Volume + S/R ──
    const sgResult = await this.singaporeFilters.checkAll(coin, isLong);
    if (!sgResult.pass) {
      const failReasons = sgResult.reasons.filter(r => !r.includes('OK') && !r.includes('disabled'));
      this.logger.log(
        `[RuleEngine] ${coin} ${isLong ? "LONG" : "SHORT"} blocked by Singapore filter: ${failReasons.join(' | ')}`,
      );
      return null;
    }

    // ── On-Chain Filters — FR, L/S ratio, Taker flow, OI ──
    // On-chain only BLOCKS for OP_ONCHAIN strategy (has its own built-in on-chain logic)
    // For other strategies: info-only (log but don't block)
    const ocResult = await this.onChainFilters.checkAll(coin, isLong);
    if (!ocResult.pass) {
      const failReasons = ocResult.reasons.filter(r => !r.includes('OK') && !r.includes('disabled') && !r.includes('skip'));
      this.logger.debug(
        `[RuleEngine] ${coin} ${isLong ? "LONG" : "SHORT"} on-chain warning (info-only): ${failReasons.join(' | ')}`,
      );
      // Don't block — on-chain is advisory for non-OP_ONCHAIN strategies
    }

    if (winners.length >= 2) {
      const names = winners.map(w => w.strategy).join("+");
      const reasons = winners.map(w => w.result.reason).join(" | ");
      const ocInfo = ocResult.reasons.filter(r => r.includes('OK') || r.includes('SURGE') || r.includes('BUY') || r.includes('SELL')).join(', ');
      this.logger.log(
        `[RuleEngine] ${coin} ✓ ${isLong ? "LONG" : "SHORT"} confluence (${winners.length}/${strategies.length}): ${names} | SG: ${sgResult.reasons.filter(r => r.includes('OK') || r.includes('SPIKE')).join(', ')} | OC: ${ocInfo}`,
      );
      return {
        isLong,
        entryPrice: primary.entryPrice,
        strategy: names,
        reason: `Confluence ${names}: ${reasons}`,
        sgFilters: sgResult.reasons,
        onChainFilters: ocResult.reasons,
      };
    }

    // Single strategy fired — still valid
    this.logger.debug(
      `[RuleEngine] ${coin} △ ${winners[0].strategy} fired alone (1/${strategies.length}) — allowed as single`,
    );
    return { ...primary, sgFilters: sgResult.reasons, onChainFilters: ocResult.reasons };
  }

  /**
   * RSI Divergence Detection — classic reversal signal for catching tops/bottoms.
   * Bearish divergence: price makes higher high but RSI makes lower high → SHORT (top signal)
   * Bullish divergence: price makes lower low but RSI makes higher low → LONG (bottom signal)
   * Scans last `lookback` candles on given timeframe.
   * Returns "BEARISH" | "BULLISH" | null.
   */
  private async detectRsiDivergence(
    coin: string,
    kline: string,
    lookback = 10,
    rsiPeriod = 14,
  ): Promise<"BEARISH" | "BULLISH" | null> {
    const ohlc = await this.indicatorService.getOhlc(coin, kline);
    if (ohlc.closes.length < rsiPeriod + lookback + 5) return null;

    const closes = ohlc.closes;
    const highs = ohlc.highs;
    const lows = ohlc.lows;
    const rsiArr = this.indicatorService.getRsiArray(closes, rsiPeriod);

    // RSI array is shorter than closes by (rsiPeriod) elements
    // Align: rsiArr[i] corresponds to closes[rsiPeriod + i]
    const offset = closes.length - rsiArr.length;
    const len = rsiArr.length;
    if (len < lookback + 2) return null;

    // Find two most recent swing highs in price (for bearish div)
    // Find two most recent swing lows in price (for bullish div)
    const swingHighs: { idx: number; price: number; rsi: number }[] = [];
    const swingLows: { idx: number; price: number; rsi: number }[] = [];

    // Scan from recent to old, find local extremes (simple: higher than both neighbors)
    for (let i = len - 2; i >= len - lookback && i >= 1; i--) {
      const priceIdx = i + offset;
      if (highs[priceIdx] > highs[priceIdx - 1] && highs[priceIdx] > highs[priceIdx + 1]) {
        swingHighs.push({ idx: i, price: highs[priceIdx], rsi: rsiArr[i] });
      }
      if (lows[priceIdx] < lows[priceIdx - 1] && lows[priceIdx] < lows[priceIdx + 1]) {
        swingLows.push({ idx: i, price: lows[priceIdx], rsi: rsiArr[i] });
      }
    }

    // Bearish divergence: 2 swing highs where later price is higher but RSI is lower
    if (swingHighs.length >= 2) {
      const [recent, prev] = swingHighs; // already sorted recent→old
      if (recent.price > prev.price && recent.rsi < prev.rsi) {
        // Additional: RSI should be in overbought zone (> 55) for relevance
        if (recent.rsi > 55) {
          this.logger.log(
            `[RuleEngine] ${coin} BEARISH RSI divergence on ${kline}: price ${prev.price.toFixed(4)}→${recent.price.toFixed(4)} (↑) but RSI ${prev.rsi.toFixed(1)}→${recent.rsi.toFixed(1)} (↓)`,
          );
          return "BEARISH";
        }
      }
    }

    // Bullish divergence: 2 swing lows where later price is lower but RSI is higher
    if (swingLows.length >= 2) {
      const [recent, prev] = swingLows;
      if (recent.price < prev.price && recent.rsi > prev.rsi) {
        // Additional: RSI should be in oversold zone (< 45) for relevance
        if (recent.rsi < 45) {
          this.logger.log(
            `[RuleEngine] ${coin} BULLISH RSI divergence on ${kline}: price ${prev.price.toFixed(4)}→${recent.price.toFixed(4)} (↓) but RSI ${prev.rsi.toFixed(1)}→${recent.rsi.toFixed(1)} (↑)`,
          );
          return "BULLISH";
        }
      }
    }

    return null;
  }

  /**
   * Price Position Filter — prevent shorting bottoms and longing tops.
   * Checks where current price sits in the recent high-low range.
   * Returns position 0-100 (0 = bottom, 100 = top).
   */
  private async getPricePosition(coin: string, kline: string, lookback = 20): Promise<number | null> {
    const ohlc = await this.indicatorService.getOhlc(coin, kline);
    if (ohlc.highs.length < lookback) return null;

    const recentHighs = ohlc.highs.slice(-lookback);
    const recentLows = ohlc.lows.slice(-lookback);
    const high = Math.max(...recentHighs);
    const low = Math.min(...recentLows);
    const range = high - low;
    if (range <= 0) return null;

    const currentPrice = ohlc.closes[ohlc.closes.length - 1];
    return ((currentPrice - low) / range) * 100;
  }

  /**
   * Candle Momentum Confirmation — checks if recent candles confirm signal direction.
   * LONG: at least 2 of last 3 candles must be green (close > open)
   * SHORT: at least 2 of last 3 candles must be red (close < open)
   */
  private async checkCandleMomentum(coin: string, kline: string, isLong: boolean): Promise<boolean> {
    const ohlc = await this.indicatorService.getOhlc(coin, kline);
    if (ohlc.closes.length < 4) return true; // not enough data, skip check

    let aligned = 0;
    for (let i = 1; i <= 3; i++) {
      const idx = ohlc.closes.length - 1 - i; // check candles before current (completed candles)
      const close = ohlc.closes[idx];
      const open = ohlc.opens[idx];
      if (isLong && close > open) aligned++;
      if (!isLong && close < open) aligned++;
    }
    return aligned >= 2;
  }

  private async evalStrategy(
    strategy: string,
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    // Per-strategy confidence gates (from TradingConfig)
    const cfg = this.tradingConfig.get();
    const gates: Record<string, number> = {
      EMA_PULLBACK: cfg.gateEMAPullback || 78,
      TREND_EMA: Math.min(cfg.gateTrendEMA || 68, 68),
      STOCH_EMA_KDJ: Math.min(cfg.gateStochEMAKDJ || 68, 68),
      RSI_CROSS: Math.min(cfg.gateRSICross || 65, 68),
      SMC_FVG: Math.min((cfg as any).gateSMCFVG || 68, 68),
      OP_ONCHAIN: Math.min((cfg as any).gateOpOnchain || 60, 68),
    };
    const gate = gates[strategy];
    if (gate && params.confidence < gate) {
      this.logger.debug(
        `[RuleEngine] ${coin} ${strategy} gated: confidence ${params.confidence} < ${gate}`,
      );
      return null;
    }

    switch (strategy) {
      case "RSI_CROSS":
        return this.evalRsiCross(coin, currency, params);
      case "TREND_EMA":
        return this.evalTrendEma(coin, currency, params);
      case "STOCH_EMA_KDJ":
        return this.evalStochEmaKdj(coin, currency, params);
      case "EMA_PULLBACK":
        return this.evalEmaPullback(coin, currency, params);
      case "SMC_FVG":
        return this.evalSmcFvg(coin, currency, params);
      case "OP_ONCHAIN":
        return this.evalOpOnchain(coin, currency, params);
      default:
        return null;
    }
  }

  // ─── RSI_CROSS (ported from F8 Config 2) ────────────────────────────────

  async evalRsiCross(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.rsiCross;
    if (!cfg) return null;

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < 50) return null;

    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const rsiEma = this.indicatorService.getRsiEma(closes, cfg.rsiPeriod, cfg.rsiEmaPeriod);

    // Skip coins with degenerate RSI (all-up or all-down — no cross possible)
    if (rsi.last >= 99.9 && rsiEma.last >= 99.9) return null;
    if (rsi.last <= 0.1 && rsiEma.last <= 0.1) return null;

    const isCrossAbove = this.indicatorService.crossedAbove(rsi, rsiEma);
    const isCrossBelow = this.indicatorService.crossedBelow(rsi, rsiEma);

    if (!isCrossAbove && !isCrossBelow) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS: no cross (RSI=${rsi.last.toFixed(1)} EMA=${rsiEma.last.toFixed(1)} prev RSI=${rsi.secondLast?.toFixed(1)} EMA=${rsiEma.secondLast?.toFixed(1)})`);
      return null;
    }

    const isLong = isCrossAbove;

    // RSI threshold gate — tighter thresholds to avoid peak entries
    if (cfg.enableThreshold) {
      const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
      const isBull = params.regime === "STRONG_BULL";
      const isBear = params.regime === "STRONG_BEAR";
      const isMixed = params.regime === "MIXED" || params.regime === "VOLATILE" || params.regime === "BTC_CORRELATION";
      // Symmetric thresholds: equal opportunity for LONG and SHORT
      // RANGE_BOUND: only extreme RSI bounces (oversold for LONG, overbought for SHORT)
      // RSI cross at 50 in a range = whipsaw, not a real signal
      const threshold = isRanging
        ? isLong ? 40 : 60   // ranging: LONG only if RSI<40 (bouncing from oversold), SHORT only if RSI>60 (selling overbought)
        : isBull
          ? isLong ? 65 : 50  // bull: LONG OK up to 65, SHORT needs RSI > 50 (relaxed from 40)
          : isBear
            ? isLong ? 40 : 65  // bear: LONG needs RSI < 40, SHORT OK up to 65
            : isMixed
              ? isLong ? 60 : 50  // mixed/volatile: LONG < 60, SHORT > 50 (was 55/45)
              : cfg.rsiThreshold;  // fallback (50)

      if (isLong && rsi.last >= threshold) {
        this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: RSI=${rsi.last.toFixed(1)} >= threshold ${threshold}`);
        return null;
      }
      if (!isLong && rsi.last <= threshold) {
        this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: RSI=${rsi.last.toFixed(1)} <= threshold ${threshold}`);
        return null;
      }
    }

    // Overbought/oversold absolute protection — never enter at extremes
    if (isLong && rsi.last > 70) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: RSI=${rsi.last.toFixed(1)} overbought (>70)`);
      return null;
    }
    if (!isLong && rsi.last < 30) {
      this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: RSI=${rsi.last.toFixed(1)} oversold (<30)`);
      return null;
    }

    // HTF RSI confirmation + overbought/oversold check
    // In ranging regimes (RANGE_BOUND/SIDEWAYS), skip HTF direction check because
    // daily trends don't dictate short-term range trades — only check overbought/oversold.
    if (cfg.enableHtfRsi) {
      const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline);
      if (htfCloses.length >= 50) {
        const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
        const htfRsiEma = this.indicatorService.getRsiEma(htfCloses, cfg.rsiPeriod, cfg.rsiEmaPeriod);
        const htfIsBullish = htfRsi.last > htfRsiEma.last;

        const isRangingRegime = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS" || params.regime === "MIXED";

        // In trending regimes, HTF direction must align (hard block)
        // In ranging regimes, HTF direction is a soft filter — block counter-trend
        // signals to prevent systematic SHORT bias in uptrending markets
        if (isRangingRegime) {
          // Soft filter: block counter-trend signals when HTF has clear direction
          // This prevents shorting in uptrends and longing in downtrends within ranges
          const htfSpread = Math.abs(htfRsi.last - htfRsiEma.last);
          if (htfSpread > 5) { // only block when HTF has clear momentum (>5 RSI spread)
            if (isLong && !htfIsBullish) {
              this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bearish (spread=${htfSpread.toFixed(1)})`);
              return null;
            }
            if (!isLong && htfIsBullish) {
              this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bullish in range (spread=${htfSpread.toFixed(1)})`);
              return null;
            }
          }
        } else {
          if (isLong && !htfIsBullish) {
            this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bearish (< EMA ${htfRsiEma.last.toFixed(1)})`);
            return null;
          }
          if (!isLong && htfIsBullish) {
            this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: HTF(${cfg.htfKline}) RSI=${htfRsi.last.toFixed(1)} bullish (> EMA ${htfRsiEma.last.toFixed(1)})`);
            return null;
          }
        }
        // Block LONG if HTF RSI overbought, SHORT if oversold (all regimes)
        if (isLong && htfRsi.last > 70) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: HTF RSI=${htfRsi.last.toFixed(1)} overbought (>70)`);
          return null;
        }
        if (!isLong && htfRsi.last < 30) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: HTF RSI=${htfRsi.last.toFixed(1)} oversold (<30)`);
          return null;
        }
      }
    }

    // Initial candle direction gate
    if (cfg.enableCandleDir) {
      const ohlc = await this.indicatorService.getLastNClosedCandles(coin, cfg.candleKline, 1);
      if (ohlc.closes.length > 0) {
        const lastClose = ohlc.closes[ohlc.closes.length - 1];
        const lastOpen = ohlc.opens[ohlc.opens.length - 1];
        const isGreen = lastClose > lastOpen;
        if (isLong && !isGreen) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS LONG blocked: candle is RED`);
          return null;
        }
        if (!isLong && isGreen) {
          this.logger.debug(`[RuleEngine] ${coin} RSI_CROSS SHORT blocked: candle is GREEN`);
          return null;
        }
      }
    }

    const entryPrice = closes[closes.length - 1];
    const direction = isLong ? "LONG" : "SHORT";
    const rsiLabel = isLong ? "crosses above" : "crosses below";

    return {
      isLong,
      entryPrice,
      strategy: "RSI_CROSS",
      reason: `RSI(${cfg.rsiPeriod}) ${rsiLabel} RSI-EMA(${cfg.rsiEmaPeriod}) on ${cfg.primaryKline}. RSI=${rsi.last.toFixed(1)}`,
    };
  }

  // ─── TREND_EMA (ported from F1) ──────────────────────────────────────────

  async evalTrendEma(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.trendEma;
    if (!cfg) return null;

    // TREND_EMA is a trend-following strategy — EMA crosses in ranging markets are whipsaws
    const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
    if (isRanging) {
      this.logger.debug(`[RuleEngine] ${coin} TREND_EMA blocked: ranging regime (${params.regime})`);
      return null;
    }

    const closes = await this.indicatorService.getCloses(coin, cfg.primaryKline);
    if (closes.length < Math.max(cfg.slowPeriod, 50) + 5) return null;

    const fastEma = this.indicatorService.getEma(closes, cfg.fastPeriod);
    const slowEma = this.indicatorService.getEma(closes, cfg.slowPeriod);

    const isCrossAbove = this.indicatorService.crossedAbove(fastEma, slowEma);
    const isCrossBelow = this.indicatorService.crossedBelow(fastEma, slowEma);

    if (!isCrossAbove && !isCrossBelow) {
      this.logger.debug(
        `[RuleEngine] ${coin} TREND_EMA miss: no EMA${cfg.fastPeriod}/${cfg.slowPeriod} cross on ${cfg.primaryKline}`,
      );
      return null;
    }

    const isLong = isCrossAbove;

    // TREND_EMA SHORT: re-enabled with regime filter (needs bearish/volatile context)
    if (!isLong && !["STRONG_BEAR", "VOLATILE", "MIXED"].includes(params.regime)) {
      this.logger.debug(`[RuleEngine] ${coin} TREND_EMA SHORT skipped: ${params.regime} regime not suitable for SHORT trend`);
      return null;
    }

    // Trend gate: price must be near the trend EMA (EMA200 on higher TF)
    // Regime-aware: widen trendRange in strong trends (coins can be further from EMA200)
    if (cfg.enableTrendGate) {
      const trendCloses = await this.indicatorService.getCloses(coin, cfg.trendKline);
      if (trendCloses.length >= cfg.trendEmaPeriod) {
        const trendEma = this.indicatorService.getEma(trendCloses, cfg.trendEmaPeriod);
        const currentPrice = closes[closes.length - 1];
        const distPct =
          (Math.abs(currentPrice - trendEma.last) / trendEma.last) * 100;

        const isTrendRegime = params.regime === "STRONG_BULL" || params.regime === "STRONG_BEAR";
        const effectiveTrendRange = isTrendRegime ? Math.max(cfg.trendRange, 8) : cfg.trendRange;

        if (distPct > effectiveTrendRange) return null; // price too far from trend EMA
        if (isLong && currentPrice < trendEma.last) return null; // price below trend = no LONG
        if (!isLong && currentPrice > trendEma.last) return null; // price above trend = no SHORT
      }
    }

    // ADX trend strength gate — skip EMA crossovers in choppy/weak trend conditions
    // Regime-aware: lower threshold in strong trends (macro trend already confirmed)
    const baseAdxMin = cfg.adxMin ?? 20;
    const isTrendRegime = params.regime === "STRONG_BULL" || params.regime === "STRONG_BEAR";
    const adxMin = isTrendRegime ? Math.max(baseAdxMin - 5, 12) : baseAdxMin;
    if (adxMin > 0) {
      const adxOhlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
      const { adx } = this.indicatorService.getAdx(adxOhlc.highs, adxOhlc.lows, adxOhlc.closes, 14);
      if (adx < adxMin) {
        this.logger.debug(
          `[RuleEngine] ${coin} TREND_EMA blocked — ADX=${adx.toFixed(1)} < ${adxMin} (trend too weak)`,
        );
        return null;
      }
    }

    const entryPrice = closes[closes.length - 1];
    const crossType = isLong ? "crosses above" : "crosses below";

    // ── RSI exhaustion check — don't enter if momentum already exhausted ──
    const rsi = this.indicatorService.getRsi(closes, 14);
    if (isLong && rsi.last > 60) {
      this.logger.debug(`[RuleEngine] ${coin} TREND_EMA LONG blocked: RSI=${rsi.last.toFixed(1)} > 60 (momentum exhausted)`);
      return null;
    }
    if (!isLong && rsi.last < 40) {
      this.logger.debug(`[RuleEngine] ${coin} TREND_EMA SHORT blocked: RSI=${rsi.last.toFixed(1)} < 40 (oversold, bounce likely)`);
      return null;
    }

    // ── Trend freshness — price must not have moved too far from cross point ──
    // If price already moved >1.5% from EMA cross, the move is done — don't chase
    const crossPrice = (fastEma.last + slowEma.last) / 2;
    const moveFromCross = Math.abs(entryPrice - crossPrice) / crossPrice * 100;
    if (moveFromCross > 1.5) {
      this.logger.debug(`[RuleEngine] ${coin} TREND_EMA blocked: price ${moveFromCross.toFixed(1)}% from cross (>1.5%, too late)`);
      return null;
    }

    return {
      isLong,
      entryPrice,
      strategy: "TREND_EMA",
      reason: `EMA(${cfg.fastPeriod}) ${crossType} EMA(${cfg.slowPeriod}), RSI=${rsi.last.toFixed(1)}, dist=${moveFromCross.toFixed(1)}% on ${cfg.primaryKline}`,
    };
  }

  // ─── STOCH_EMA_KDJ (ported from F5) — 2-stage ────────────────────────────

  async evalStochEmaKdj(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.stochEmaKdj;
    if (!cfg) return null;

    const stateKey = `cache:ai-signal:state:${coin}:STOCH_EMA`;
    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, highs, lows, closes } = ohlc;

    if (closes.length < 100) return null;

    const stochResult = this.indicatorService.getStochastic(
      highs,
      lows,
      closes,
      cfg.stochK,
      cfg.stochSmoothK,
      cfg.stochSmoothD,
    );

    const stochK = {
      last: stochResult.smoothedK[stochResult.smoothedK.length - 1],
      secondLast: stochResult.smoothedK[stochResult.smoothedK.length - 2],
    };
    const stochD = {
      last: stochResult.smoothedD[stochResult.smoothedD.length - 1],
      secondLast: stochResult.smoothedD[stochResult.smoothedD.length - 2],
    };

    let patternState = await this.redisService.get<{
      isLong: boolean;
      count: number;
    }>(stateKey);

    // Stage 1: Stochastic cross in extreme zone
    if (!patternState) {
      const isCrossAbove = this.indicatorService.crossedAbove(stochK, stochD);
      const isCrossBelow = this.indicatorService.crossedBelow(stochK, stochD);

      if (!isCrossAbove && !isCrossBelow) return null;

      const isLong = isCrossAbove;
      const stochInZone = isLong
        ? stochD.last < cfg.stochLong
        : stochD.last > cfg.stochShort;

      if (!stochInZone) return null;

      await this.redisService.set(
        stateKey,
        { isLong, count: 1 },
        PATTERN_STATE_TTL,
      );
      this.logger.debug(`[RuleEngine] ${coin} STOCH_EMA Stage 1 triggered (${isLong ? "LONG" : "SHORT"})`);
      return null;
    }

    // Stage 2: EMA body pierce + optional KDJ confirmation
    patternState = { ...patternState, count: patternState.count + 1 };

    const ema = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const n = closes.length;
    const lastClose = closes[n - 1];
    const lastOpen = opens[n - 1];

    // Candle body must straddle the EMA
    const bodyTop = Math.max(lastClose, lastOpen);
    const bodyBottom = Math.min(lastClose, lastOpen);
    const emaNearBody =
      ema.last >= bodyBottom &&
      ema.last <= bodyTop;

    // The candle must be moving in the signal direction
    const isGreen = lastClose > lastOpen;
    const directionOk = patternState.isLong ? isGreen : !isGreen;

    if (!emaNearBody || !directionOk) {
      if (patternState.count >= 5) {
        await this.redisService.delete(stateKey);
      } else {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
      }
      return null;
    }

    // Optional KDJ confirmation
    if (cfg.enableKdj) {
      const kdj = this.indicatorService.getKdj(highs, lows, closes, {
        rangeLength: cfg.kdjRangeLength,
      });
      if (kdj.K.length < 2 || kdj.D.length < 2) {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
        return null;
      }
      const kLast = kdj.K[kdj.K.length - 1];
      const dLast = kdj.D[kdj.D.length - 1];
      const kPrev = kdj.K[kdj.K.length - 2];
      const dPrev = kdj.D[kdj.D.length - 2];

      const kCrossAbove = kLast > dLast && kPrev <= dPrev;
      const kCrossBelow = kLast < dLast && kPrev >= dPrev;

      if (patternState.isLong && !kCrossAbove) {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
        return null;
      }
      if (!patternState.isLong && !kCrossBelow) {
        await this.redisService.set(stateKey, patternState, PATTERN_STATE_TTL);
        return null;
      }
    }

    // Regime gate: block in ranging regimes (0% TP rate — momentum fades before TP reached)
    // Also block counter-trend in extreme regimes
    if (params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS") {
      this.logger.debug(`[RuleEngine] ${coin} STOCH_EMA_KDJ blocked: ranging regime (${params.regime})`);
      await this.redisService.delete(stateKey);
      return null;
    }
    if (patternState.isLong && params.regime === "STRONG_BEAR") {
      this.logger.debug(`[RuleEngine] ${coin} STOCH_EMA_KDJ LONG blocked: STRONG_BEAR regime`);
      await this.redisService.delete(stateKey);
      return null;
    }
    // Allow SHORT in STRONG_BULL — hedge system manages risk
    // Diversification: need SHORT signals to balance portfolio

    await this.redisService.delete(stateKey);

    return {
      isLong: patternState.isLong,
      entryPrice: lastClose,
      strategy: "STOCH_EMA_KDJ",
      reason: `Stoch cross in ${patternState.isLong ? "oversold" : "overbought"} zone + EMA(${cfg.emaPeriod}) body pierce on ${cfg.primaryKline}`,
    };
  }

  // ─── EMA_PULLBACK (buy dips to EMA in trending markets) ─────────────────
  // Improved 2026-03-10: was -17.36% PnL — shorting bottoms in STRONG_BEAR
  // Fixes: allow all regimes + consecutive bounce confirmation + RSI exhaustion check +
  // HTF trend direction must align (use 1h EMA slope, not just regime label)

  async evalEmaPullback(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.emaPullback;
    if (!cfg) return null;

    // EMA_PULLBACK buys dips to EMA in trending markets — invalid in ranging markets
    const isRanging = params.regime === "RANGE_BOUND" || params.regime === "SIDEWAYS";
    if (isRanging) {
      this.logger.debug(`[RuleEngine] ${coin} EMA_PULLBACK blocked: ranging regime (${params.regime})`);
      return null;
    }

    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, closes } = ohlc;
    if (closes.length < cfg.emaSupportPeriod + 10) return null;

    const ema = this.indicatorService.getEma(closes, cfg.emaPeriod);
    const emaSupport = this.indicatorService.getEma(closes, cfg.emaSupportPeriod);
    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const prev2Price = closes[closes.length - 3];
    const currentOpen = opens[opens.length - 1];
    const prevOpen = opens[opens.length - 2];

    // ── Determine direction from 1h EMA slope (not regime) ──
    // Use actual price structure instead of stale regime label
    const htfCloses = await this.indicatorService.getCloses(coin, cfg.htfKline || "1h");
    if (htfCloses.length < 50) return null;
    const htfEma = this.indicatorService.getEma(htfCloses, 21);

    // HTF EMA must have clear slope — use consecutive EMA values (last vs secondLast)
    if (!htfEma.secondLast) return null;
    const htfSlope = ((htfEma.last - htfEma.secondLast) / htfEma.secondLast) * 100;
    const isUptrend = htfSlope > 0.05;  // 1h EMA rising > 0.05%
    const isDowntrend = htfSlope < -0.05; // 1h EMA falling > 0.05%
    if (!isUptrend && !isDowntrend) return null; // flat — skip

    // LONG: uptrend + price pulled back to EMA21, consecutive bounce
    if (isUptrend) {
      const touchedEma = prevPrice <= ema.last * 1.01 || currentPrice <= ema.last * 1.01;
      const isGreen = currentPrice > currentOpen;
      const prevIsGreen = prevPrice > prevOpen;
      const consecutiveBounce = isGreen && prevIsGreen; // 2 green candles = confirmed bounce
      const aboveSupport = currentPrice > emaSupport.last;
      const rsiOk = rsi.last >= 30 && rsi.last <= 55; // not overbought (was <=62, too loose)

      if (!touchedEma || !consecutiveBounce || !aboveSupport || !rsiOk) {
        this.logger.debug(
          `[RuleEngine] ${coin} EMA_PULLBACK LONG miss: touch=${touchedEma} 2green=${consecutiveBounce} support=${aboveSupport} rsi=${rsi.last.toFixed(1)}(30-55)`,
        );
        return null;
      }

      // HTF RSI not overbought (1h)
      const htfRsi = this.indicatorService.getRsi(htfCloses, cfg.rsiPeriod);
      if (htfRsi.last > 65) {
        this.logger.debug(`[RuleEngine] ${coin} EMA_PULLBACK LONG blocked: 1h RSI=${htfRsi.last.toFixed(1)} overbought (>65)`);
        return null;
      }

      // 4h RSI must confirm LONG direction (> 40) — prevents dead cat bounce entries
      // Data: PLAY/AVNT/1000SATS all peak=0.0% → entered into declining 4h trend
      const closes4h = await this.indicatorService.getCloses(coin, "4h");
      if (closes4h.length >= 20) {
        const rsi4h = this.indicatorService.getRsi(closes4h, 14);
        if (rsi4h.last < 40) {
          this.logger.debug(`[RuleEngine] ${coin} EMA_PULLBACK LONG blocked: 4h RSI=${rsi4h.last.toFixed(1)} bearish (<40) — dead cat bounce risk`);
          return null;
        }
      }

      return {
        isLong: true,
        entryPrice: currentPrice,
        strategy: "EMA_PULLBACK",
        reason: `Pullback to EMA(${cfg.emaPeriod})=${ema.last.toFixed(2)}, 2-candle bounce, RSI=${rsi.last.toFixed(1)}, htfSlope=+${htfSlope.toFixed(2)}%`,
      };
    }

    // EMA_PULLBACK SHORT: price pulled back UP to EMA in downtrend, then resumes down
    if (!["STRONG_BEAR", "VOLATILE"].includes(params.regime)) {
      this.logger.debug(`[RuleEngine] ${coin} EMA_PULLBACK SHORT skipped: ${params.regime} not suitable`);
      return null;
    }
    // Mirror of LONG: 2 red candles after touching EMA from below, RSI 45-70
    const touchedEmaShort = prevPrice >= ema.last * 0.99 || currentPrice >= ema.last * 0.99;
    const isRed = currentPrice < currentOpen;
    const prevIsRed = prevPrice < prevOpen;
    const consecutiveDrop = isRed && prevIsRed;
    const belowResistance = currentPrice < emaSupport.last;
    const rsiOkShort = rsi.last >= 45 && rsi.last <= 70;

    if (!touchedEmaShort || !consecutiveDrop || !belowResistance || !rsiOkShort) {
      this.logger.debug(
        `[RuleEngine] ${coin} EMA_PULLBACK SHORT miss: touch=${touchedEmaShort} 2red=${consecutiveDrop} resistance=${belowResistance} rsi=${rsi.last.toFixed(1)}(45-70)`,
      );
      return null;
    }

    return {
      isLong: false,
      entryPrice: currentPrice,
      strategy: "EMA_PULLBACK",
      reason: `SHORT pullback to EMA(${cfg.emaPeriod}), 2-candle drop, RSI=${rsi.last.toFixed(1)}`,
    };
  }

  // ─── SMC_FVG (Smart Money Concepts: Fair Value Gap + Order Block) ──────
  // Entry: price enters an unfilled FVG zone near an Order Block,
  // with BOS/CHoCH structure break confirmation on HTF.
  // Best in: RANGE_BOUND, SIDEWAYS, MIXED regimes (price respects structure)

  private async evalSmcFvg(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = params.smcFvg ?? {
      primaryKline: "15m",
      htfKline: "1h",
      fvgTolerance: 0.3,     // tighter: price must be within 0.3% of FVG zone
      obMinMove: 2.0,        // stronger OB: require 2% move (was 1.5%)
      rsiPeriod: 14,
      rsiLongMax: 55,        // LONG only below RSI 55 (not overbought)
      rsiShortMin: 45,       // SHORT only above RSI 45 (symmetric with LONG)
      requireBos: true,
      maxFvgAge: 20,         // fresher FVGs only: 20 candles (was 30)
    };

    const ohlc = await this.indicatorService.getOhlc(coin, cfg.primaryKline);
    const { opens, highs, lows, closes } = ohlc;
    if (closes.length < 60) return null;

    const currentPrice = closes[closes.length - 1];

    // 1. Detect unfilled FVGs near current price
    const nearFvgs = this.indicatorService.getUnfilledFVGsNearPrice(
      highs, lows, closes, cfg.fvgTolerance,
    );
    if (nearFvgs.length === 0) return null;

    // 2. Find nearby Order Blocks for confluence
    const orderBlocks = this.indicatorService.detectOrderBlocks(
      opens, highs, lows, closes, cfg.obMinMove, cfg.maxFvgAge,
    );

    // 3. Determine direction from FVG type
    // Prioritize bullish FVG (price dipping into demand) or bearish FVG (price rallying into supply)
    const bullishFvg = nearFvgs.find(f => f.type === "bullish");
    const bearishFvg = nearFvgs.find(f => f.type === "bearish");

    let isLong: boolean | null = null;
    let selectedFvg: typeof nearFvgs[0] | null = null;

    if (bullishFvg) {
      // Price is near a bullish FVG (demand zone) → potential LONG
      // OB must be near the FVG zone (within 2% of FVG bottom) for real confluence
      const bullishOb = orderBlocks.find(ob =>
        ob.type === "bullish" && !ob.mitigated &&
        Math.abs(ob.low - bullishFvg.bottom) / bullishFvg.bottom < 0.02,
      );
      if (bullishOb) {
        isLong = true;
        selectedFvg = bullishFvg;
      }
    }

    if (bearishFvg && isLong === null) {
      // Price is near a bearish FVG (supply zone) → potential SHORT
      // OB must be near the FVG zone (within 2% of FVG top) for real confluence
      const bearishOb = orderBlocks.find(ob =>
        ob.type === "bearish" && !ob.mitigated &&
        Math.abs(ob.high - bearishFvg.top) / bearishFvg.top < 0.02,
      );
      if (bearishOb) {
        isLong = false;
        selectedFvg = bearishFvg;
      }
    }

    if (isLong === null || !selectedFvg) return null;

    // Regime gate: block counter-trend in extreme regimes
    // FVG LONG in STRONG_BEAR = catching falling knife; SHORT in STRONG_BULL = short squeeze
    if (isLong && params.regime === "STRONG_BEAR") {
      this.logger.debug(`[RuleEngine] ${coin} SMC_FVG LONG blocked: STRONG_BEAR`);
      return null;
    }
    // Allow SHORT in STRONG_BULL for SMC_FVG — FVG structure overrides regime
    // Hedge system manages risk if SHORT is wrong

    // 4. RSI filter — avoid extreme RSI entries
    const rsi = this.indicatorService.getRsi(closes, cfg.rsiPeriod);
    if (isLong && rsi.last > cfg.rsiLongMax) {
      this.logger.debug(`[RuleEngine] ${coin} SMC_FVG LONG blocked: RSI=${rsi.last.toFixed(1)} > ${cfg.rsiLongMax}`);
      return null;
    }
    if (!isLong && rsi.last < cfg.rsiShortMin) {
      this.logger.debug(`[RuleEngine] ${coin} SMC_FVG SHORT blocked: RSI=${rsi.last.toFixed(1)} < ${cfg.rsiShortMin}`);
      return null;
    }

    // 5. HTF structure break confirmation (BOS or CHoCH)
    if (cfg.requireBos) {
      const htfOhlc = await this.indicatorService.getOhlc(coin, cfg.htfKline);
      if (htfOhlc.closes.length >= 30) {
        const recentBreak = this.indicatorService.getRecentStructureBreak(
          htfOhlc.highs, htfOhlc.lows, htfOhlc.closes, 5, 10,
        );

        if (!recentBreak) {
          this.logger.debug(`[RuleEngine] ${coin} SMC_FVG blocked: no recent BOS/CHoCH on ${cfg.htfKline}`);
          return null;
        }

        // Structure break must align with signal direction
        if (isLong && recentBreak.direction !== "bullish") {
          this.logger.debug(`[RuleEngine] ${coin} SMC_FVG LONG blocked: HTF structure is ${recentBreak.direction}`);
          return null;
        }
        if (!isLong && recentBreak.direction !== "bearish") {
          this.logger.debug(`[RuleEngine] ${coin} SMC_FVG SHORT blocked: HTF structure is ${recentBreak.direction}`);
          return null;
        }
      }
    }

    // 6. Candle direction confirmation
    const lastOpen = opens[opens.length - 1];
    const isGreen = currentPrice > lastOpen;
    if (isLong && !isGreen) {
      this.logger.debug(`[RuleEngine] ${coin} SMC_FVG LONG blocked: red candle (no demand reaction)`);
      return null;
    }
    if (!isLong && isGreen) {
      this.logger.debug(`[RuleEngine] ${coin} SMC_FVG SHORT blocked: green candle (no supply reaction)`);
      return null;
    }

    const direction = isLong ? "LONG" : "SHORT";
    const fvgZone = `${selectedFvg.bottom.toFixed(4)}-${selectedFvg.top.toFixed(4)}`;
    const obCount = orderBlocks.filter(ob => ob.type === (isLong ? "bullish" : "bearish") && !ob.mitigated).length;

    return {
      isLong,
      entryPrice: currentPrice,
      strategy: "SMC_FVG",
      reason: `${direction} at ${isLong ? "bullish" : "bearish"} FVG zone [${fvgZone}], ${obCount} OB(s) confluence, RSI=${rsi.last.toFixed(1)} on ${cfg.primaryKline}`,
    };
  }

  // ─── OP_ONCHAIN: Pure on-chain + daily open price strategy ──────────────
  // No traditional indicators — uses OP line direction + on-chain data
  private async evalOpOnchain(
    coin: string,
    currency: string,
    params: AiTunedParams,
  ): Promise<SignalResult | null> {
    const cfg = this.tradingConfig.get();
    if (!(cfg as any).opOnchainEnabled) return null;

    const symbol = `${coin}USDT`;

    // 1. Get daily open price from Redis candle cache (more reliable than MongoDB)
    const dailyOpenStr = await this.redisService.get(`cache:candle:open:${coin}:1d`);
    const currentPriceStr = await this.redisService.get(`cache:candle:close:${coin}:1d`);
    // Fallback: try MongoDB candle history
    let dailyOpen = dailyOpenStr ? parseFloat(String(dailyOpenStr)) : 0;
    let currentPrice = currentPriceStr ? parseFloat(String(currentPriceStr)) : 0;
    if (!dailyOpen || !currentPrice) {
      const closes1d = await this.indicatorService.getCloses(coin, "1d");
      if (!closes1d || closes1d.length < 2) {
        this.logger.debug(`[RuleEngine] ${coin} OP_ONCHAIN: no daily data (Redis + MongoDB empty)`);
        return null;
      }
      dailyOpen = closes1d[closes1d.length - 2];
      currentPrice = closes1d[closes1d.length - 1];
    }
    const opPct = ((currentPrice - dailyOpen) / dailyOpen) * 100;

    // Need meaningful move from OP (at least 0.3%)
    if (Math.abs(opPct) < 0.3) return null;

    const isLong = opPct > 0; // above OP = bullish bias

    // 2. Get on-chain data from scanner cache
    const cached = await this.redisService.get('cache:futures:analytics');
    if (!cached || typeof cached !== 'object') return null;
    const analytics = (cached as Record<string, any>)[symbol];
    if (!analytics) return null;

    const fr = (analytics.fundingRate || 0) * 100;
    const longPct = analytics.longPercent || 50;
    const taker = analytics.takerBuyRatio || 1;

    // 3. On-chain confirmation score
    let score = 0;
    const reasons: string[] = [];

    // OP direction (base signal)
    score += isLong ? 20 : -20;
    reasons.push(`OP: ${opPct >= 0 ? '+' : ''}${opPct.toFixed(2)}%`);

    // Taker flow — bonus (not blocking)
    if (isLong && taker > 1.05) { score += 15; reasons.push(`Taker BUY ${taker.toFixed(2)}`); }
    else if (!isLong && taker < 0.95) { score += 15; reasons.push(`Taker SELL ${taker.toFixed(2)}`); }
    // Only block on strong contradicting flow
    else if (isLong && taker < 0.8) { return null; }
    else if (!isLong && taker > 1.2) { return null; }

    // L/S ratio — contrarian bonus
    if (isLong && longPct < 55) { score += 10; reasons.push(`L/S contrarian ${longPct.toFixed(0)}%L`); }
    else if (!isLong && longPct > 50) { score += 10; reasons.push(`L/S contrarian ${longPct.toFixed(0)}%L`); }
    // Only block on extreme crowd (>70%)
    else if (isLong && longPct > 70) { return null; }
    else if (!isLong && longPct < 30) { return null; }

    // FR — bonus (not blocking unless extreme)
    if (isLong && fr > 0.1) { return null; }
    if (!isLong && fr < -0.1) { return null; }
    if (isLong && fr <= 0) { score += 10; reasons.push(`FR negative ${fr.toFixed(3)}%`); }
    if (!isLong && fr >= 0) { score += 10; reasons.push(`FR positive +${fr.toFixed(3)}%`); }

    // Need minimum score: OP(20) + at least 1 small confirmation(10)
    if (Math.abs(score) < 30) return null;

    const direction = isLong ? "LONG" : "SHORT";
    this.logger.log(
      `[RuleEngine] ${coin} OP_ONCHAIN ${direction} | score=${score} | ${reasons.join(', ')}`,
    );

    return {
      isLong,
      entryPrice: currentPrice,
      strategy: "OP_ONCHAIN",
      reason: `${direction} OP ${opPct >= 0 ? '+' : ''}${opPct.toFixed(2)}% + ${reasons.slice(1).join(', ')}`,
    };
  }
}
