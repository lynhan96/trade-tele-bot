import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import { FuturesAnalyticsService, CoinAnalytics } from '../market-data/futures-analytics.service';
import { OnChainSnapshot, OnChainSnapshotDocument } from '../schemas/onchain-snapshot.schema';
import { TelegramBotService } from '../telegram/telegram.service';
import { RedisService } from '../redis/redis.service';
import { TradingConfigService } from './trading-config';

export interface MarketPrediction {
  symbol: string;
  signal: 'STRONG_LONG' | 'LONG_BIAS' | 'NEUTRAL' | 'SHORT_BIAS' | 'STRONG_SHORT';
  score: number; // -100 to +100
  alerts: string[];
  analytics: CoinAnalytics;
}

// Top coins to scan (high liquidity, reliable data)
const SCAN_COINS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'NEARUSDT', 'SUIUSDT', 'APTUSDT', 'INJUSDT', 'FILUSDT',
  'ARBUSDT', 'OPUSDT', 'TIAUSDT', 'FETUSDT', 'RENDERUSDT',
  'WIFUSDT', 'PEPEUSDT', 'ONDOUSDT', 'TAOUSDT', 'HYPEUSDT',
  'AAVEUSDT', 'MKRUSDT', 'LTCUSDT', 'BCHUSDT', 'ETCUSDT',
];

const PREV_OI_KEY = 'cache:onchain:prev_oi';
const ALERT_COOLDOWN_KEY = 'cache:onchain:alert_cooldown';

@Injectable()
export class OnChainScannerService {
  private readonly logger = new Logger(OnChainScannerService.name);

  constructor(
    private readonly futuresAnalytics: FuturesAnalyticsService,
    private readonly telegramBot: TelegramBotService,
    private readonly redisService: RedisService,
    private readonly tradingConfig: TradingConfigService,
    @InjectModel(OnChainSnapshot.name) private snapshotModel: Model<OnChainSnapshotDocument>,
  ) {}

  /**
   * Cron: scan top coins every 15 minutes for on-chain anomalies.
   */
  @Cron('0 */15 * * * *')
  async scanMarket(): Promise<void> {
    const cfg = this.tradingConfig.get();
    if (!cfg.onChainFilterEnabled) return;

    try {
      const analytics = await this.futuresAnalytics.fetchAnalytics(SCAN_COINS);
      if (analytics.size === 0) return;

      const predictions: MarketPrediction[] = [];
      const prevOIMap = await this.getPrevOI();
      const newOIMap: Record<string, number> = {};

      for (const [symbol, data] of analytics) {
        const oiChangePct = prevOIMap[symbol]
          ? ((data.openInterest - prevOIMap[symbol]) / prevOIMap[symbol]) * 100
          : 0;
        newOIMap[symbol] = data.openInterest;

        const prediction = this.analyzeCoin(symbol, data, oiChangePct);
        predictions.push(prediction);

        // Save snapshot
        this.snapshotModel.create({
          symbol,
          direction: prediction.score > 0 ? 'LONG' : prediction.score < 0 ? 'SHORT' : 'NEUTRAL',
          fundingRate: data.fundingRate,
          fundingRatePct: data.fundingRate * 100,
          openInterest: data.openInterest,
          openInterestUsd: data.openInterestUsd,
          oiChangePct,
          longShortRatio: data.longShortRatio,
          longPercent: data.longPercent,
          shortPercent: data.shortPercent,
          takerBuyRatio: data.takerBuyRatio,
          filterPassed: true, // scanner snapshots always "pass" — they're observations
          filterReasons: prediction.alerts,
          blockedBy: [],
          snapshotAt: new Date(),
        }).catch(() => {});
      }

      // Save OI for next comparison
      await this.redisService.set(PREV_OI_KEY, newOIMap, 7200); // 2h TTL

      // Find anomalies and alert
      const anomalies = predictions.filter(p => p.alerts.length > 0);
      if (anomalies.length > 0) {
        await this.sendAlerts(anomalies);
      }

      // Log market overview
      const bullish = predictions.filter(p => p.score > 20).length;
      const bearish = predictions.filter(p => p.score < -20).length;
      const neutral = predictions.length - bullish - bearish;
      this.logger.log(
        `[OnChainScanner] Scanned ${analytics.size} coins | Bull: ${bullish} | Bear: ${bearish} | Neutral: ${neutral} | Anomalies: ${anomalies.length}`,
      );
    } catch (err) {
      this.logger.error(`[OnChainScanner] Scan failed: ${err.message}`);
    }
  }

  /**
   * Analyze a single coin — compute prediction score + detect anomalies.
   */
  private analyzeCoin(symbol: string, data: CoinAnalytics, oiChangePct: number): MarketPrediction {
    let score = 0;
    const alerts: string[] = [];
    const coin = symbol.replace('USDT', '');
    const fr = data.fundingRate * 100;
    const longPct = data.longPercent;
    const taker = data.takerBuyRatio;

    // ── 1. Funding Rate ──
    if (fr > 0.1) {
      score -= 30;
      alerts.push(`${coin} FR cực cao +${fr.toFixed(3)}% — rủi ro dump/squeeze`);
    } else if (fr > 0.05) {
      score -= 15;
    } else if (fr < -0.1) {
      score += 30;
      alerts.push(`${coin} FR cực thấp ${fr.toFixed(3)}% — XÁC SUẤT SHORT SQUEEZE CAO`);
    } else if (fr < -0.05) {
      score += 15;
      alerts.push(`${coin} FR âm ${fr.toFixed(3)}% — có thể short squeeze`);
    }

    // ── 2. Open Interest ──
    // Skip OI analysis if change is extreme (data error or first read)
    if (Math.abs(oiChangePct) < 90) {
      if (oiChangePct > 10) {
        alerts.push(`${coin} OI tăng mạnh +${oiChangePct.toFixed(1)}% — cá mập đang vào`);
        if (fr > 0.03) {
          score -= 20;
        } else if (fr < -0.03) {
          score += 20;
        }
      } else if (oiChangePct < -10) {
        alerts.push(`${coin} OI giảm ${oiChangePct.toFixed(1)}% — đóng vị thế, xu hướng có thể đảo`);
      }
    }

    // ── 3. Long/Short Ratio — Nghịch đám đông ──
    if (longPct > 65) {
      score -= 20;
      alerts.push(`${coin} Đám đông LONG ${longPct.toFixed(0)}% — tín hiệu nghịch SHORT`);
    } else if (longPct < 35) {
      score += 20;
      alerts.push(`${coin} Đám đông SHORT ${(100 - longPct).toFixed(0)}% — tín hiệu nghịch LONG`);
    }

    // ── 4. Taker Buy/Sell — Dòng tiền tổ chức ──
    if (taker > 1.5) {
      score += 25;
      alerts.push(`${coin} Cá mập MUA mạnh ${taker.toFixed(2)} — dòng tiền tổ chức vào`);
    } else if (taker > 1.2) {
      score += 10;
    } else if (taker < 0.6) {
      score -= 25;
      alerts.push(`${coin} Cá mập BÁN mạnh ${taker.toFixed(2)} — dòng tiền tổ chức rút`);
    } else if (taker < 0.8) {
      score -= 10;
    }

    // ── 5. Combo (độ tin cậy cao) ──
    if (fr > 0.08 && oiChangePct > 5 && longPct > 60) {
      score -= 40;
      alerts.push(`${coin} COMBO: FR+OI+Đám đông = XÁC SUẤT DUMP CAO`);
    }
    if (fr < -0.05 && oiChangePct > 5 && longPct < 40) {
      score += 40;
      alerts.push(`${coin} COMBO: FR+OI+Đám đông = XÁC SUẤT SQUEEZE CAO`);
    }
    if (taker > 1.3 && oiChangePct > 5 && fr < 0.02) {
      score += 30;
      alerts.push(`${coin} TÍCH LŨY: Cá mập mua + OI tăng + FR thấp = LONG mạnh`);
    }

    // Clamp score
    score = Math.max(-100, Math.min(100, score));

    const signal: MarketPrediction['signal'] =
      score > 40 ? 'STRONG_LONG' :
      score > 15 ? 'LONG_BIAS' :
      score < -40 ? 'STRONG_SHORT' :
      score < -15 ? 'SHORT_BIAS' :
      'NEUTRAL';

    return { symbol, signal, score, alerts, analytics: data };
  }

  /**
   * Send Telegram alerts for significant anomalies.
   */
  private async sendAlerts(anomalies: MarketPrediction[]): Promise<void> {
    // Cooldown: max 1 alert per coin per hour
    const cooldownMap = await this.redisService.get(ALERT_COOLDOWN_KEY) || {};
    const now = Date.now();
    const toAlert = anomalies.filter(a => {
      const lastAlert = cooldownMap[a.symbol] || 0;
      return now - lastAlert > 3600000; // 1 hour
    });

    if (toAlert.length === 0) return;

    const adminIds = (process.env.AI_ADMIN_TELEGRAM_ID || '').split(',').filter(Boolean);
    if (adminIds.length === 0) return;

    const signalVi: Record<string, string> = {
      'STRONG_LONG': 'MẠNH TĂNG', 'LONG_BIAS': 'Thiên TĂNG',
      'STRONG_SHORT': 'MẠNH GIẢM', 'SHORT_BIAS': 'Thiên GIẢM',
      'NEUTRAL': 'Trung lập',
    };

    const recVi: Record<string, string> = {
      'STRONG_LONG': '👉 Khuyến nghị: LONG mạnh',
      'LONG_BIAS': '👉 Khuyến nghị: Ưu tiên LONG',
      'STRONG_SHORT': '👉 Khuyến nghị: SHORT mạnh',
      'SHORT_BIAS': '👉 Khuyến nghị: Ưu tiên SHORT',
      'NEUTRAL': '👉 Khuyến nghị: Đứng ngoài, chờ tín hiệu rõ hơn',
    };

    let msg = '📊 *Phân Tích On-Chain*\n\n';

    // Market summary
    const bullCount = toAlert.filter(a => a.score > 15).length;
    const bearCount = toAlert.filter(a => a.score < -15).length;
    const neutralCount = toAlert.length - bullCount - bearCount;
    msg += `🌍 *Tổng quan:* ${bullCount} tăng | ${bearCount} giảm | ${neutralCount} trung lập\n\n`;

    for (const p of toAlert) {
      const coin = p.symbol.replace('USDT', '');
      const emoji = p.score > 30 ? '🟢' : p.score < -30 ? '🔴' : '🟡';
      const fr = p.analytics.fundingRate * 100;

      msg += `${emoji} *${coin}* — ${signalVi[p.signal] || p.signal} (${p.score > 0 ? '+' : ''}${p.score})\n`;
      msg += `FR: ${fr >= 0 ? '+' : ''}${fr.toFixed(4)}% | `;
      msg += `L/S: ${p.analytics.longPercent.toFixed(0)}%L | `;
      msg += `Taker: ${p.analytics.takerBuyRatio.toFixed(2)}\n`;
      for (const alert of p.alerts) {
        msg += `  ⚡ ${alert}\n`;
      }
      msg += `${recVi[p.signal] || ''}\n\n`;

      cooldownMap[p.symbol] = now;
    }

    msg += `_${new Date().toISOString().slice(11, 16)} UTC • On-Chain Scanner_`;

    // On-chain alerts disabled — data saved to MongoDB for analysis

    await this.redisService.set(ALERT_COOLDOWN_KEY, cooldownMap, 7200);
    this.logger.log(`[OnChainScanner] Sent ${toAlert.length} alerts`);
  }

  private async getPrevOI(): Promise<Record<string, number>> {
    return (await this.redisService.get(PREV_OI_KEY)) || {};
  }
}
