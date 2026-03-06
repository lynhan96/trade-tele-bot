import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiRegimeHistory, AiRegimeHistoryDocument } from "../schemas/ai-regime-history.schema";
import { MarketDataService } from "../market-data/market-data.service";

export interface StrategyStatRow {
  strategy: string;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number; // %
  avgPnl: number; // %
  totalPnl: number; // cumulative % across all signals
  avgDurationHours: number;
  testModeCount: number;
  liveCount: number;
}

export interface OverallStats {
  totalSignals: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnlUsd: number; // cumulative realized PnL assuming ASSUMED_BALANCE_USDT per trade
  byStrategy: StrategyStatRow[];
  aiCostUsd: number; // estimated monthly cost
}

export interface SignalHealthCheck {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number; // %
  stopLossPrice: number;
  distanceToSl: number; // % from currentPrice
  strategy: string;
  regime: string;
  aiConfidence: number;
  executedAt?: Date;
  hoursActive: number;
  isTestMode: boolean;
  status: string;
}

@Injectable()
export class AiSignalStatsService {
  private readonly logger = new Logger(AiSignalStatsService.name);

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    @InjectModel(AiRegimeHistory.name)
    private readonly regimeHistoryModel: Model<AiRegimeHistoryDocument>,
    private readonly marketDataService: MarketDataService,
  ) {}

  // ─── Strategy performance stats ──────────────────────────────────────────

  async getStats(daysBack = 30): Promise<OverallStats> {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const pipeline: any[] = [
      {
        $match: {
          status: "COMPLETED",
          pnlPercent: { $exists: true },
          generatedAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$strategy",
          totalSignals: { $sum: 1 },
          wins: {
            $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, 1, 0] },
          },
          avgPnl: { $avg: "$pnlPercent" },
          totalPnl: { $sum: "$pnlPercent" },
          avgDurationMs: {
            $avg: {
              $subtract: ["$positionClosedAt", "$executedAt"],
            },
          },
          testModeCount: {
            $sum: { $cond: ["$isTestMode", 1, 0] },
          },
          liveCount: {
            $sum: { $cond: [{ $not: "$isTestMode" }, 1, 0] },
          },
        },
      },
      { $sort: { avgPnl: -1 } },
    ];

    const rows = await this.aiSignalModel.aggregate(pipeline);

    const byStrategy: StrategyStatRow[] = rows.map((r) => ({
      strategy: r._id,
      totalSignals: r.totalSignals,
      wins: r.wins,
      losses: r.totalSignals - r.wins,
      winRate: r.totalSignals > 0 ? (r.wins / r.totalSignals) * 100 : 0,
      avgPnl: r.avgPnl || 0,
      totalPnl: r.totalPnl || 0,
      avgDurationHours: r.avgDurationMs ? r.avgDurationMs / 3600000 : 0,
      testModeCount: r.testModeCount,
      liveCount: r.liveCount,
    }));

    const ASSUMED_BALANCE_USDT = 1000;
    const totalSignals = byStrategy.reduce((s, r) => s + r.totalSignals, 0);
    const totalWins = byStrategy.reduce((s, r) => s + r.wins, 0);
    const avgPnl =
      totalSignals > 0
        ? byStrategy.reduce((s, r) => s + r.avgPnl * r.totalSignals, 0) / totalSignals
        : 0;
    const totalPnlPct = byStrategy.reduce((s, r) => s + r.totalPnl, 0);
    const totalPnlUsd = (totalPnlPct / 100) * ASSUMED_BALANCE_USDT;

    // Estimate AI cost from regime history
    const aiCostUsd = await this.estimateAiCost(since);

    return {
      totalSignals,
      wins: totalWins,
      winRate: totalSignals > 0 ? (totalWins / totalSignals) * 100 : 0,
      avgPnl,
      totalPnlUsd,
      byStrategy,
      aiCostUsd,
    };
  }

  // ─── Per-signal health check ──────────────────────────────────────────────

  /**
   * Check current price vs entry, SL for an active signal.
   * Used by /ai check command.
   */
  async checkSignalHealth(symbol: string): Promise<SignalHealthCheck | null> {
    const signal = await this.aiSignalModel.findOne({
      symbol: symbol.toUpperCase(),
      status: { $in: ["ACTIVE", "QUEUED"] },
    }).sort({ generatedAt: -1 });

    if (!signal) return null;

    const currentPrice = await this.getCurrentPrice(signal.symbol);
    if (currentPrice === 0) return null;

    const unrealizedPnl =
      signal.direction === "LONG"
        ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
        : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    const distanceToSl =
      signal.direction === "LONG"
        ? ((currentPrice - signal.stopLossPrice) / currentPrice) * 100
        : ((signal.stopLossPrice - currentPrice) / currentPrice) * 100;

    const hoursActive = signal.executedAt
      ? (Date.now() - signal.executedAt.getTime()) / 3600000
      : 0;

    return {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      currentPrice,
      unrealizedPnl,
      stopLossPrice: signal.stopLossPrice,
      distanceToSl,
      strategy: signal.strategy,
      regime: signal.regime,
      aiConfidence: signal.aiConfidence,
      executedAt: signal.executedAt,
      hoursActive,
      isTestMode: signal.isTestMode,
      status: signal.status,
    };
  }

  /**
   * Get health checks for all currently ACTIVE signals.
   */
  async checkAllActiveSignals(): Promise<SignalHealthCheck[]> {
    const activeSignals = await this.aiSignalModel.find({ status: "ACTIVE" });
    const results = await Promise.allSettled(
      activeSignals.map((s) => this.checkSignalHealth(s.symbol)),
    );
    return results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => (r as PromiseFulfilledResult<SignalHealthCheck>).value);
  }

  // ─── Format messages for Telegram ────────────────────────────────────────

  formatStatsMessage(stats: OverallStats, daysBack: number): string {
    const ASSUMED_BALANCE_USDT = 1000;
    const fmtUsd = (usd: number) => (usd >= 0 ? "+" : "-") + Math.abs(usd).toFixed(2) + " USDT";

    const pnlIcon = stats.totalPnlUsd >= 0 ? "📗" : "📕";
    const winRateStr = stats.winRate.toFixed(0);
    const avgPnlStr = stats.avgPnl >= 0 ? `+${stats.avgPnl.toFixed(1)}` : stats.avgPnl.toFixed(1);

    let msg = `📊 *AI Signal Stats (${daysBack} ngay)*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `${pnlIcon} Realized PnL: *${fmtUsd(stats.totalPnlUsd)}* tong | avg *${avgPnlStr}%* _(1000 USDT/lenh)_\n`;
    msg += `🏆 Win: *${stats.wins}/${stats.totalSignals}* (*${winRateStr}%*)\n`;
    msg += `🤖 Chi phi AI: ~${stats.aiCostUsd.toFixed(2)} USDT/thang\n`;

    if (stats.byStrategy.length === 0) {
      msg += "\n_Chua co tin hieu hoan thanh nao._";
      return msg;
    }

    msg += `━━━━━━━━━━━━━━━━━━\n`;
    for (const row of stats.byStrategy) {
      const rowUsd = (row.totalPnl / 100) * ASSUMED_BALANCE_USDT;
      const rowIcon = rowUsd >= 0 ? "📗" : "📕";
      const wr = row.winRate.toFixed(0);
      const pnl = row.avgPnl >= 0 ? `+${row.avgPnl.toFixed(1)}` : row.avgPnl.toFixed(1);
      const dur = row.avgDurationHours.toFixed(1);
      const testTag = row.testModeCount > 0 ? ` _(${row.testModeCount} test)_` : "";
      msg += `${rowIcon} *${row.strategy}*: ${row.wins}/${row.totalSignals} (${wr}%) | avg ${pnl}% | *${fmtUsd(rowUsd)}* | ${dur}h${testTag}\n`;
    }

    return msg;
  }

  formatHealthMessage(health: SignalHealthCheck): string {
    const ASSUMED_BALANCE_USDT = 1000;
    const dirEmoji = health.direction === "LONG" ? "📈" : "📉";
    const pnlSign = health.unrealizedPnl >= 0 ? "+" : "";
    const slSign = health.distanceToSl >= 0 ? "+" : "";
    const testTag = health.isTestMode ? " `[TEST]`" : "";
    const statusTag = health.status === "QUEUED" ? " ⏳ QUEUED" : "";
    const pnlUsd = (health.unrealizedPnl / 100) * ASSUMED_BALANCE_USDT;
    const pnlUsdStr = (pnlUsd >= 0 ? "+" : "-") + Math.abs(pnlUsd).toFixed(2) + " USDT";

    let msg = `🔍 *AI Check: ${health.symbol}*${testTag}${statusTag}\n\n`;
    msg += `${dirEmoji} *${health.direction}* vào $${health.entryPrice.toLocaleString()}\n`;
    msg += `├ Hiện tại: $${health.currentPrice.toLocaleString()} (${pnlSign}${health.unrealizedPnl.toFixed(2)}% / *${pnlUsdStr}*)\n`;
    msg += `├ Stop Loss: $${health.stopLossPrice.toLocaleString()} (${slSign}${health.distanceToSl.toFixed(2)}%)\n`;
    if (health.executedAt) {
      msg += `├ Đã chạy: ${health.hoursActive.toFixed(1)}h\n`;
    }
    msg += `├ Strategy: ${health.strategy}\n`;
    msg += `├ Regime: ${health.regime} (${health.aiConfidence}%)\n`;
    msg += `└ _${health.unrealizedPnl >= 0 ? "Đang lãi" : "Đang lỗ"}_`;

    return msg;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getCurrentPrice(symbol: string): Promise<number> {
    return (await this.marketDataService.getPrice(symbol)) ?? 0;
  }

  private async estimateAiCost(since: Date): Promise<number> {
    const daysDiff = (Date.now() - since.getTime()) / (24 * 60 * 60 * 1000);
    const scaleFactor = 30 / daysDiff; // scale to monthly

    const regimeRecords = await this.regimeHistoryModel.find({
      assessedAt: { $gte: since },
    });

    const totalCost = regimeRecords.reduce((sum, r) => sum + (r.costUsd || 0), 0);
    return totalCost * scaleFactor;
  }
}
