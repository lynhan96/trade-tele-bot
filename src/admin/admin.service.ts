import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisService } from '../redis/redis.service';
import { AiSignal, AiSignalDocument } from '../schemas/ai-signal.schema';
import { UserSignalSubscription, UserSignalSubscriptionDocument } from '../schemas/user-signal-subscription.schema';
import { UserTrade, UserTradeDocument } from '../schemas/user-trade.schema';
import { AiCoinProfile, AiCoinProfileDocument } from '../schemas/ai-coin-profile.schema';
import { AiMarketConfig, AiMarketConfigDocument } from '../schemas/ai-market-config.schema';
import { AiRegimeHistory, AiRegimeHistoryDocument } from '../schemas/ai-regime-history.schema';
import { DailyMarketSnapshot, DailyMarketSnapshotDocument } from '../schemas/daily-market-snapshot.schema';
import { UserSettings, UserSettingsDocument } from '../schemas/user-settings.schema';

/** Must match the key in SignalQueueService. */
const ACTIVE_KEY = (signalKey: string) => `cache:ai-signal:active:${signalKey}`;

/** Coins that run BOTH INTRADAY and SWING strategies simultaneously. */
const DUAL_TIMEFRAME_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectModel(AiSignal.name) private signalModel: Model<AiSignalDocument>,
    @InjectModel(UserSignalSubscription.name) private subscriptionModel: Model<UserSignalSubscriptionDocument>,
    @InjectModel(UserTrade.name) private tradeModel: Model<UserTradeDocument>,
    @InjectModel(AiCoinProfile.name) private coinProfileModel: Model<AiCoinProfileDocument>,
    @InjectModel(AiMarketConfig.name) private marketConfigModel: Model<AiMarketConfigDocument>,
    @InjectModel(AiRegimeHistory.name) private regimeHistoryModel: Model<AiRegimeHistoryDocument>,
    @InjectModel(DailyMarketSnapshot.name) private snapshotModel: Model<DailyMarketSnapshotDocument>,
    @InjectModel(UserSettings.name) private userSettingsModel: Model<UserSettingsDocument>,
    private readonly redisService: RedisService,
  ) {}

  async getDashboardStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalSignals,
      activeSignals,
      completedSignals,
      cancelledSignals,
      totalUsers,
      activeUsers,
      realModeUsers,
      totalTrades,
      openTrades,
      closedTrades,
      todaySignals,
      longSignals,
      shortSignals,
      completedSignalDocs,
      strategyAgg,
      regimeAgg,
      recentSignals,
      pnlByDayAgg,
    ] = await Promise.all([
      this.signalModel.countDocuments(),
      this.signalModel.countDocuments({ status: 'ACTIVE' }),
      this.signalModel.countDocuments({ status: 'COMPLETED' }),
      this.signalModel.countDocuments({ status: 'CANCELLED' }),
      this.subscriptionModel.countDocuments(),
      this.subscriptionModel.countDocuments({ isActive: true }),
      this.subscriptionModel.countDocuments({ realModeEnabled: true }),
      this.tradeModel.countDocuments(),
      this.tradeModel.countDocuments({ status: 'OPEN' }),
      this.tradeModel.countDocuments({ status: 'CLOSED' }),
      this.signalModel.countDocuments({ createdAt: { $gte: todayStart } }),
      this.signalModel.countDocuments({ direction: 'LONG' }),
      this.signalModel.countDocuments({ direction: 'SHORT' }),
      this.signalModel.find({ status: 'COMPLETED', pnlPercent: { $exists: true } }).select('pnlPercent').lean(),
      this.signalModel.aggregate([
        {
          $group: {
            _id: '$strategy',
            count: { $sum: 1 },
            wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'COMPLETED'] }, { $gt: ['$pnlPercent', 0] }] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'COMPLETED'] }, { $lte: ['$pnlPercent', 0] }, { $ne: [{ $type: '$pnlPercent' }, 'missing'] }] }, 1, 0] } },
            totalPnl: { $sum: { $cond: [{ $ne: [{ $type: '$pnlPercent' }, 'missing'] }, '$pnlPercent', 0] } },
          },
        },
      ]),
      this.signalModel.aggregate([{ $group: { _id: '$regime', count: { $sum: 1 } } }]),
      this.signalModel.find().sort({ createdAt: -1 }).limit(10).lean(),
      this.signalModel.aggregate([
        { $match: { status: 'COMPLETED', pnlPercent: { $exists: true }, positionClosedAt: { $exists: true } } },
        {
          $addFields: {
            dateStr: { $dateToString: { format: '%Y-%m-%d', date: '$positionClosedAt' } },
          },
        },
        { $sort: { positionClosedAt: -1 as 1 | -1 } },
        { $limit: 10000 },
        {
          $group: {
            _id: '$dateStr',
            totalPnl: { $sum: '$pnlPercent' },
            count: { $sum: 1 },
            wins: { $sum: { $cond: [{ $gt: ['$pnlPercent', 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: ['$pnlPercent', 0] }, 1, 0] } },
          },
        },
        { $sort: { _id: -1 as 1 | -1 } },
        { $limit: 30 },
      ]),
    ]);

    const wins = completedSignalDocs.filter((s) => s.pnlPercent > 0).length;
    const winRate = completedSignalDocs.length > 0 ? (wins / completedSignalDocs.length) * 100 : 0;
    const avgPnl =
      completedSignalDocs.length > 0
        ? completedSignalDocs.reduce((sum, s) => sum + s.pnlPercent, 0) / completedSignalDocs.length
        : 0;
    const totalPnl =
      completedSignalDocs.length > 0
        ? completedSignalDocs.reduce((sum, s) => sum + s.pnlPercent, 0)
        : 0;

    const signalsByStrategy: Record<string, { count: number; wins: number; losses: number; totalPnl: number }> = {};
    for (const s of strategyAgg) {
      signalsByStrategy[s._id || 'unknown'] = {
        count: s.count,
        wins: s.wins,
        losses: s.losses,
        totalPnl: Math.round((s.totalPnl || 0) * 100) / 100,
      };
    }

    const signalsByRegime: Record<string, number> = {};
    for (const r of regimeAgg) {
      signalsByRegime[r._id || 'unknown'] = r.count;
    }

    const pnlByDay = pnlByDayAgg.map((d) => ({
      date: d._id,
      totalPnl: d.totalPnl,
      count: d.count,
      wins: d.wins,
      losses: d.losses,
    }));

    return {
      totalSignals,
      activeSignals,
      completedSignals,
      cancelledSignals,
      winRate: Math.round(winRate * 100) / 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalUsers,
      activeUsers,
      realModeUsers,
      totalTrades,
      openTrades,
      closedTrades,
      todaySignals,
      signalsByDirection: { long: longSignals, short: shortSignals },
      signalsByStrategy,
      signalsByRegime,
      pnlByDay,
      recentSignals,
    };
  }

  async getSignals(query: {
    page?: number;
    limit?: number;
    status?: string;
    direction?: string;
    symbol?: string;
    strategy?: string;
    regime?: string;
    timeframeProfile?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};

    if (query.status) filter.status = query.status;
    if (query.direction) filter.direction = query.direction;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.strategy) filter.strategy = query.strategy;
    if (query.regime) filter.regime = query.regime;
    if (query.timeframeProfile) filter.timeframeProfile = query.timeframeProfile;
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const [data, total] = await Promise.all([
      this.signalModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.signalModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getSignalStats(query: { status?: string; direction?: string }) {
    // Tab counts — always global (unfiltered)
    const [total, active, completed, cancelled, queued, expired] = await Promise.all([
      this.signalModel.countDocuments(),
      this.signalModel.countDocuments({ status: 'ACTIVE' }),
      this.signalModel.countDocuments({ status: 'COMPLETED' }),
      this.signalModel.countDocuments({ status: 'CANCELLED' }),
      this.signalModel.countDocuments({ status: 'QUEUED' }),
      this.signalModel.countDocuments({ status: { $in: ['EXPIRED', 'SKIPPED'] } }),
    ]);

    // Filtered counts for cards (L/S, PnL stats)
    const dirFilter: any = {};
    if (query.direction) dirFilter.direction = query.direction;

    // PnL stats from completed signals (optionally filtered by direction)
    const pnlFilter: any = { pnlPercent: { $exists: true }, ...dirFilter };
    pnlFilter.status = query.status || 'COMPLETED';

    const [longCount, shortCount, pnlDocs] = await Promise.all([
      this.signalModel.countDocuments({ ...(query.status ? { status: query.status } : {}), direction: 'LONG' }),
      this.signalModel.countDocuments({ ...(query.status ? { status: query.status } : {}), direction: 'SHORT' }),
      this.signalModel.find(pnlFilter).select('pnlPercent closeReason').lean(),
    ]);

    const wins = pnlDocs.filter((s) => s.pnlPercent > 0).length;
    const losses = pnlDocs.filter((s) => s.pnlPercent <= 0).length;
    const winRate = pnlDocs.length > 0 ? (wins / pnlDocs.length) * 100 : 0;
    const avgPnl = pnlDocs.length > 0
      ? pnlDocs.reduce((sum, s) => sum + s.pnlPercent, 0) / pnlDocs.length
      : 0;
    const totalPnl = pnlDocs.reduce((sum, s) => sum + s.pnlPercent, 0);
    const tpCount = pnlDocs.filter((s) => s.closeReason === 'TAKE_PROFIT').length;
    const slCount = pnlDocs.filter((s) => s.closeReason === 'STOP_LOSS').length;

    return {
      total, active, completed, cancelled, queued, expired,
      long: longCount, short: shortCount,
      wins, losses, winRate: Math.round(winRate * 100) / 100,
      avgPnl: Math.round(avgPnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      tpCount, slCount,
    };
  }

  async getSignalById(id: string) {
    return this.signalModel.findById(id).lean();
  }

  async updateSignal(id: string, dto: { status?: string; closeReason?: string }) {
    return this.signalModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).lean();
  }

  async getUsers(query: {
    page?: number;
    limit?: number;
    isActive?: string;
    realModeEnabled?: string;
    search?: string;
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};

    if (query.isActive !== undefined && query.isActive !== '') filter.isActive = query.isActive === 'true';
    if (query.realModeEnabled !== undefined && query.realModeEnabled !== '') filter.realModeEnabled = query.realModeEnabled === 'true';
    if (query.search) {
      const searchNum = parseInt(query.search, 10);
      if (!isNaN(searchNum)) {
        filter.$or = [
          { username: { $regex: query.search, $options: 'i' } },
          { telegramId: searchNum },
        ];
      } else {
        filter.username = { $regex: query.search, $options: 'i' };
      }
    }

    const [data, total] = await Promise.all([
      this.subscriptionModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.subscriptionModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getUserById(telegramId: number) {
    const [subscription, settings, trades] = await Promise.all([
      this.subscriptionModel.findOne({ telegramId }).lean(),
      this.userSettingsModel.findOne({ telegramId }).lean(),
      this.tradeModel.find({ telegramId }).sort({ createdAt: -1 }).lean(),
    ]);

    const openTrades = trades.filter((t) => t.status === 'OPEN').length;
    const closedTrades = trades.filter((t) => t.status === 'CLOSED');
    const tradesWithPnl = closedTrades.filter((t) => t.pnlPercent !== undefined);
    const totalPnl = tradesWithPnl.reduce((sum, t) => sum + t.pnlPercent, 0);
    const totalPnlUsdt = tradesWithPnl.reduce((sum, t) => sum + (t.pnlUsdt ?? 0), 0);
    const wins = tradesWithPnl.filter((t) => t.pnlPercent > 0).length;
    const losses = tradesWithPnl.filter((t) => t.pnlPercent <= 0).length;
    const winRate = tradesWithPnl.length > 0 ? (wins / tradesWithPnl.length) * 100 : 0;
    const avgPnl = tradesWithPnl.length > 0 ? totalPnl / tradesWithPnl.length : 0;

    return {
      subscription,
      settings: settings ? { telegramId: settings.telegramId, chatId: settings.chatId, hasBinanceKeys: !!settings.binance, hasOkxKeys: !!settings.okx } : null,
      trades,
      tradesSummary: {
        total: trades.length,
        open: openTrades,
        closed: closedTrades.length,
        wins,
        losses,
        winRate: Math.round(winRate * 100) / 100,
        avgPnl: Math.round(avgPnl * 100) / 100,
        totalPnlPercent: Math.round(totalPnl * 100) / 100,
        totalPnlUsdt: Math.round(totalPnlUsdt * 100) / 100,
      },
    };
  }

  async updateUser(
    telegramId: number,
    dto: {
      isActive?: boolean;
      realModeEnabled?: boolean;
      maxOpenPositions?: number;
      tradingBalance?: number;
      realModeDailyTargetPct?: number | null;
      realModeDailyStopLossPct?: number | null;
    },
  ) {
    const $set: any = {};
    const $unset: any = {};
    for (const [key, val] of Object.entries(dto)) {
      if (val === null || val === undefined) {
        $unset[key] = 1;
      } else {
        $set[key] = val;
      }
    }
    const update: any = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return this.subscriptionModel
      .findOneAndUpdate({ telegramId }, update, { new: true })
      .lean();
  }

  async getTrades(query: {
    page?: number;
    limit?: number;
    status?: string;
    symbol?: string;
    telegramId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};

    if (query.status) filter.status = query.status;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.telegramId) filter.telegramId = parseInt(query.telegramId, 10);
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const [data, total] = await Promise.all([
      this.tradeModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.tradeModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getCoinProfiles(query: { page?: number; limit?: number; isActive?: string; search?: string }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};

    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
    if (query.search) filter.symbol = { $regex: query.search.toUpperCase(), $options: 'i' };

    const [data, total] = await Promise.all([
      this.coinProfileModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.coinProfileModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateCoinProfile(id: string, dto: { isActive?: boolean; strategyStats?: Record<string, any> }) {
    return this.coinProfileModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).lean();
  }

  async getMarketConfigs(query: { page?: number; limit?: number }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    const [data, total] = await Promise.all([
      this.marketConfigModel
        .find()
        .sort({ assessedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.marketConfigModel.countDocuments(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getRegimeHistory(query: { page?: number; limit?: number; scope?: string }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};

    if (query.scope) filter.scope = query.scope;

    const [data, total] = await Promise.all([
      this.regimeHistoryModel
        .find(filter)
        .sort({ assessedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.regimeHistoryModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getSnapshots(query: { page?: number; limit?: number }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    const [data, total] = await Promise.all([
      this.snapshotModel
        .find()
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.snapshotModel.countDocuments(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Signal close (admin) ────────────────────────────────────────────────

  /**
   * Close a single active signal from admin panel.
   * - Fetches current price from Binance public API
   * - Marks signal as COMPLETED with PnL
   * - Removes Redis active key so PositionMonitorService detects the close
   *   and handles real Binance position closes + Telegram notifications
   */
  async closeSignal(id: string): Promise<{ success: boolean; pnlPercent?: number; error?: string }> {
    const signal = await this.signalModel.findById(id);
    if (!signal) return { success: false, error: 'Signal not found' };
    if (signal.status !== 'ACTIVE' && signal.status !== 'QUEUED') {
      return { success: false, error: `Signal is ${signal.status}, not ACTIVE/QUEUED` };
    }

    // For QUEUED signals, just cancel them
    if (signal.status === 'QUEUED') {
      await this.signalModel.findByIdAndUpdate(id, {
        status: 'CANCELLED',
        closeReason: 'ADMIN_CLOSE',
        positionClosedAt: new Date(),
      });
      const signalKey = this.getSignalKey(signal);
      await this.redisService.delete(`cache:ai-signal:queued:${signalKey}`);
      this.logger.log(`[Admin] Cancelled QUEUED signal ${signal.symbol} (${id})`);
      return { success: true, pnlPercent: 0 };
    }

    // For ACTIVE signals, resolve with current price
    const exitPrice = await this.fetchBinancePrice(signal.symbol);
    if (!exitPrice) return { success: false, error: 'Failed to fetch current price' };

    const pnlPercent = signal.direction === 'LONG'
      ? ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;

    await this.signalModel.findByIdAndUpdate(id, {
      status: 'COMPLETED',
      closeReason: 'ADMIN_CLOSE',
      exitPrice,
      pnlPercent,
      positionClosedAt: new Date(),
    });

    // Remove from Redis — PositionMonitorService will detect the close
    // and handle real Binance positions + Telegram notifications on next poll
    const signalKey = this.getSignalKey(signal);
    await this.redisService.delete(ACTIVE_KEY(signalKey));

    this.logger.log(
      `[Admin] Closed signal ${signal.symbol} ${signal.direction} — exit=${exitPrice} pnl=${pnlPercent.toFixed(2)}% (${id})`,
    );
    return { success: true, pnlPercent: Math.round(pnlPercent * 100) / 100 };
  }

  /**
   * Close all active signals from admin panel.
   */
  async closeAllSignals(): Promise<{ closed: number; errors: string[] }> {
    const activeSignals = await this.signalModel.find({ status: 'ACTIVE' }).lean();
    let closed = 0;
    const errors: string[] = [];

    for (const signal of activeSignals) {
      const result = await this.closeSignal((signal as any)._id.toString());
      if (result.success) {
        closed++;
      } else {
        errors.push(`${signal.symbol}: ${result.error}`);
      }
    }

    // Also cancel all QUEUED
    const queuedSignals = await this.signalModel.find({ status: 'QUEUED' }).lean();
    for (const signal of queuedSignals) {
      const result = await this.closeSignal((signal as any)._id.toString());
      if (result.success) closed++;
    }

    this.logger.log(`[Admin] Close all: ${closed} signals closed, ${errors.length} errors`);
    return { closed, errors };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getSignalKey(signal: { symbol: string; coin?: string; timeframeProfile?: string } & any): string {
    const coin = (signal.coin || signal.symbol.replace('USDT', '')).toUpperCase();
    const profile = signal.timeframeProfile;
    if (DUAL_TIMEFRAME_COINS.includes(coin) && profile) {
      return `${signal.symbol}:${profile}`;
    }
    return signal.symbol;
  }

  private async fetchBinancePrice(symbol: string): Promise<number | null> {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
      const data = await res.json();
      return parseFloat(data.price) || null;
    } catch {
      return null;
    }
  }
}
