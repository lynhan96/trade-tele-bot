import { Injectable, Logger } from '@nestjs/common';
import { IndicatorService } from '../indicators/indicator.service';
import { TradingConfigService } from '../../ai-signal/trading-config';

/**
 * Singapore Strategy Filters — 5 element analysis:
 * 1. OP Line (Daily Open Price) — direction bias
 * 2. Smart Money Volume — institutional buying/selling
 * 3. Support/Resistance Levels — avoid bad entries
 *
 * Each filter can be toggled on/off via TradingConfig.
 */
@Injectable()
export class SingaporeFiltersService {
  private readonly logger = new Logger(SingaporeFiltersService.name);

  constructor(
    private readonly indicatorService: IndicatorService,
    private readonly tradingConfig: TradingConfigService,
  ) {}

  /**
   * 1. OP Line Filter — Daily Open Price bias
   * Price > daily open = bullish bias → only LONG
   * Price < daily open = bearish bias → only SHORT
   * Returns true if direction aligns with OP bias
   */
  async checkOpLine(coin: string, isLong: boolean): Promise<{ pass: boolean; reason: string }> {
    const cfg = this.tradingConfig.get();
    if (!cfg.opLineEnabled) return { pass: true, reason: 'OP line disabled' };

    try {
      const ohlc = await this.indicatorService.getOhlc(coin, '1d');
      if (!ohlc || !ohlc.opens?.length) return { pass: true, reason: 'No 1d data' };

      const dailyOpen = ohlc.opens[ohlc.opens.length - 1];
      const currentPrice = ohlc.closes[ohlc.closes.length - 1];
      const aboveOp = currentPrice > dailyOpen;
      const opDist = ((currentPrice - dailyOpen) / dailyOpen * 100);

      // LONG only if price above daily open (bullish bias)
      // SHORT only if price below daily open (bearish bias)
      if (isLong && !aboveOp) {
        return { pass: false, reason: `OP line: price below daily open (${opDist.toFixed(2)}%) → bearish bias` };
      }
      if (!isLong && aboveOp) {
        return { pass: false, reason: `OP line: price above daily open (+${opDist.toFixed(2)}%) → bullish bias` };
      }

      return { pass: true, reason: `OP line OK: ${aboveOp ? 'above' : 'below'} daily open (${opDist >= 0 ? '+' : ''}${opDist.toFixed(2)}%)` };
    } catch (err) {
      this.logger.debug(`[SingaporeFilters] OP line check failed for ${coin}: ${err?.message}`);
      return { pass: true, reason: 'OP line check failed, proceeding' };
    }
  }

  /**
   * 2. Volume Analysis — Smart Money vs Retail
   * Analyze trade sizes: large orders (>$10k) = smart money, small (<$1k) = retail
   * If smart money buying → LONG signal stronger
   * If smart money selling → SHORT signal stronger
   * If retail contra smart money → even better signal (retail usually wrong)
   */
  async checkVolumeAnalysis(coin: string, isLong: boolean): Promise<{ pass: boolean; reason: string; smartMoneyBias?: string }> {
    const cfg = this.tradingConfig.get();
    if (!cfg.volumeAnalysisEnabled) return { pass: true, reason: 'Volume analysis disabled' };

    try {
      const ohlc = await this.indicatorService.getOhlc(coin, '15m');
      if (!ohlc || ohlc.closes.length < 20) return { pass: true, reason: 'Not enough data' };

      const { opens, highs, lows, closes } = ohlc;
      const len = closes.length;

      // Use candle body size as volume proxy (big candles = big money)
      const bodySizes: number[] = [];
      for (let i = Math.max(0, len - 20); i < len; i++) {
        bodySizes.push(Math.abs(closes[i] - opens[i]) / (opens[i] || 1) * 100);
      }
      const avgBody = bodySizes.reduce((s, b) => s + b, 0) / bodySizes.length;
      const currentBody = bodySizes[bodySizes.length - 1];
      const bodyRatio = currentBody / (avgBody || 1);
      const hasBigCandle = bodyRatio > 2.0;

      // Direction of recent big candles
      const last5 = closes.slice(-5);
      const last5Opens = opens.slice(-5);
      let bullCandles = 0, bearCandles = 0;
      for (let i = 0; i < 5; i++) {
        const body = Math.abs(last5[i] - last5Opens[i]) / (last5Opens[i] || 1) * 100;
        if (body > avgBody * 1.5) { // only count big candles
          if (last5[i] > last5Opens[i]) bullCandles++;
          else bearCandles++;
        }
      }

      let smartMoneyBias: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
      if (bullCandles > bearCandles && bullCandles >= 2) smartMoneyBias = 'BUY';
      else if (bearCandles > bullCandles && bearCandles >= 2) smartMoneyBias = 'SELL';

      const contra = (isLong && smartMoneyBias === 'SELL') || (!isLong && smartMoneyBias === 'BUY');

      if (contra) {
        return {
          pass: false,
          reason: `Volume: smart money ${smartMoneyBias} (${bullCandles}bull/${bearCandles}bear big candles) contra ${isLong ? 'LONG' : 'SHORT'}`,
          smartMoneyBias,
        };
      }

      return {
        pass: true,
        reason: `Volume: ${smartMoneyBias} (${bullCandles}B/${bearCandles}S)${hasBigCandle ? ' 📊 BIG CANDLE' : ''}`,
        smartMoneyBias,
      };
    } catch (err) {
      this.logger.debug(`[SingaporeFilters] Volume analysis failed for ${coin}: ${err?.message}`);
      return { pass: true, reason: 'Volume analysis failed, proceeding' };
    }
  }

  /**
   * 3. S/R Level Filter — Support and Resistance
   * Don't LONG near resistance (likely rejection)
   * Don't SHORT near support (likely bounce)
   * Uses pivot points from daily OHLC
   */
  async checkSRLevel(coin: string, isLong: boolean): Promise<{ pass: boolean; reason: string; nearLevel?: string }> {
    const cfg = this.tradingConfig.get();
    if (!cfg.srLevelEnabled) return { pass: true, reason: 'S/R level disabled' };

    try {
      const ohlc = await this.indicatorService.getOhlc(coin, '1d');
      if (!ohlc || ohlc.closes.length < 2) return { pass: true, reason: 'Not enough data' };

      const len = ohlc.closes.length;
      // Yesterday's OHLC for pivot calculation
      const prevHigh = ohlc.highs[len - 2];
      const prevLow = ohlc.lows[len - 2];
      const prevClose = ohlc.closes[len - 2];
      const currentPrice = ohlc.closes[len - 1];

      // Classic Pivot Points
      const pivot = (prevHigh + prevLow + prevClose) / 3;
      const r1 = 2 * pivot - prevLow;    // Resistance 1
      const s1 = 2 * pivot - prevHigh;    // Support 1
      const r2 = pivot + (prevHigh - prevLow); // Resistance 2
      const s2 = pivot - (prevHigh - prevLow); // Support 2

      const proxPct = 0.5; // within 0.5% of level = "near"

      // Check proximity to levels
      const nearR1 = Math.abs((currentPrice - r1) / r1 * 100) < proxPct;
      const nearR2 = Math.abs((currentPrice - r2) / r2 * 100) < proxPct;
      const nearS1 = Math.abs((currentPrice - s1) / s1 * 100) < proxPct;
      const nearS2 = Math.abs((currentPrice - s2) / s2 * 100) < proxPct;

      // Don't LONG near resistance — likely rejection
      if (isLong && (nearR1 || nearR2)) {
        const level = nearR2 ? `R2 (${r2.toFixed(4)})` : `R1 (${r1.toFixed(4)})`;
        return { pass: false, reason: `S/R: near resistance ${level} — don't long the top`, nearLevel: level };
      }

      // Don't SHORT near support — likely bounce
      if (!isLong && (nearS1 || nearS2)) {
        const level = nearS2 ? `S2 (${s2.toFixed(4)})` : `S1 (${s1.toFixed(4)})`;
        return { pass: false, reason: `S/R: near support ${level} — don't short the bottom`, nearLevel: level };
      }

      // Bonus: LONG near support = good, SHORT near resistance = good
      const goodEntry = (isLong && (nearS1 || nearS2)) || (!isLong && (nearR1 || nearR2));

      return {
        pass: true,
        reason: `S/R OK: P=${pivot.toFixed(4)} S1=${s1.toFixed(4)} R1=${r1.toFixed(4)}${goodEntry ? ' ✨ near key level' : ''}`,
      };
    } catch (err) {
      this.logger.debug(`[SingaporeFilters] S/R check failed for ${coin}: ${err?.message}`);
      return { pass: true, reason: 'S/R check failed, proceeding' };
    }
  }

  /**
   * Run all Singapore filters — returns pass/fail with reasons
   */
  async checkAll(coin: string, isLong: boolean): Promise<{ pass: boolean; reasons: string[] }> {
    const [opResult, volResult, srResult] = await Promise.all([
      this.checkOpLine(coin, isLong),
      this.checkVolumeAnalysis(coin, isLong),
      this.checkSRLevel(coin, isLong),
    ]);

    const reasons: string[] = [];
    let pass = true;

    if (!opResult.pass) { pass = false; reasons.push(opResult.reason); }
    else reasons.push(opResult.reason);

    if (!volResult.pass) { pass = false; reasons.push(volResult.reason); }
    else reasons.push(volResult.reason);

    if (!srResult.pass) { pass = false; reasons.push(srResult.reason); }
    else reasons.push(srResult.reason);

    if (!pass) {
      this.logger.debug(`[SingaporeFilters] ${coin} ${isLong ? 'LONG' : 'SHORT'} BLOCKED: ${reasons.filter(r => r.includes('BLOCKED') || r.includes("don't") || r.includes('contra')).join(' | ')}`);
    }

    return { pass, reasons };
  }
}
