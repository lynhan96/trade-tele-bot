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
import { UserSettings, UserSettingsDocument } from '../schemas/user-settings.schema';
import { AiSignalValidation, AiSignalValidationDocument } from '../schemas/ai-signal-validation.schema';
import { DailyLimitHistory, DailyLimitHistoryDocument } from '../schemas/daily-limit-history.schema';
import { UserRealTradingService } from '../ai-signal/user-real-trading.service';

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
    @InjectModel(UserSettings.name) private userSettingsModel: Model<UserSettingsDocument>,
    @InjectModel(AiSignalValidation.name) private validationModel: Model<AiSignalValidationDocument>,
    @InjectModel(DailyLimitHistory.name) private dailyLimitHistoryModel: Model<DailyLimitHistoryDocument>,
    private readonly redisService: RedisService,
    private readonly userRealTradingService: UserRealTradingService,
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
    closedFrom?: string;
    closedTo?: string;
    sortBy?: string;
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
    if (query.closedFrom || query.closedTo) {
      filter.positionClosedAt = {};
      if (query.closedFrom) filter.positionClosedAt.$gte = new Date(query.closedFrom);
      if (query.closedTo) filter.positionClosedAt.$lte = new Date(query.closedTo + 'T23:59:59.999Z');
    }

    const allowedSortFields = ['createdAt', 'positionClosedAt', 'pnlPercent'];
    const sortField = allowedSortFields.includes(query.sortBy) ? query.sortBy : 'createdAt';

    const [data, total] = await Promise.all([
      this.signalModel
        .find(filter)
        .sort({ [sortField]: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.signalModel.countDocuments(filter),
    ]);

    // Include win/loss counts for COMPLETED signals (across ALL matching, not just current page)
    let wins: number | undefined;
    let losses: number | undefined;
    let totalPnl: number | undefined;
    let winPnl: number | undefined;
    let lossPnl: number | undefined;
    if (filter.status === "COMPLETED") {
      const agg = await this.signalModel.aggregate([
        { $match: { ...filter, pnlPercent: { $exists: true } } },
        {
          $group: {
            _id: null,
            wins: { $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: ["$pnlPercent", 0] }, 1, 0] } },
            totalPnl: { $sum: "$pnlPercent" },
            winPnl: { $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, "$pnlPercent", 0] } },
            lossPnl: { $sum: { $cond: [{ $lte: ["$pnlPercent", 0] }, "$pnlPercent", 0] } },
          },
        },
      ]);
      wins = agg[0]?.wins ?? 0;
      losses = agg[0]?.losses ?? 0;
      totalPnl = agg[0]?.totalPnl ?? 0;
      winPnl = agg[0]?.winPnl ?? 0;
      lossPnl = agg[0]?.lossPnl ?? 0;
    }

    return { data, total, page, limit, totalPages: Math.ceil(total / limit), wins, losses, totalPnl, winPnl, lossPnl };
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

  async getUserRanking(query: {
    limit?: number;
    sortBy?: string;
  }) {
    const limit = Math.min(50, Math.max(1, query.limit || 20));
    const sortField = query.sortBy === 'monthlyPnlUsdt' ? 'monthlyPnlUsdt' : 'totalPnlUsdt';

    // Current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Aggregate all-time stats from trades
    const allTimeStats = await this.tradeModel.aggregate([
      { $match: { status: 'CLOSED', pnlPercent: { $exists: true } } },
      {
        $group: {
          _id: '$telegramId',
          totalPnlUsdt: { $sum: { $ifNull: ['$pnlUsdt', 0] } },
          totalPnlPercent: { $sum: { $ifNull: ['$pnlPercent', 0] } },
          wins: { $sum: { $cond: [{ $gt: ['$pnlPercent', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lte: ['$pnlPercent', 0] }, 1, 0] } },
          totalTrades: { $sum: 1 },
        },
      },
    ]);

    // Aggregate monthly stats from trades
    const monthlyStats = await this.tradeModel.aggregate([
      { $match: { status: 'CLOSED', pnlPercent: { $exists: true }, closedAt: { $gte: monthStart } } },
      {
        $group: {
          _id: '$telegramId',
          monthlyPnlUsdt: { $sum: { $ifNull: ['$pnlUsdt', 0] } },
          monthlyPnlPercent: { $sum: { $ifNull: ['$pnlPercent', 0] } },
          monthlyWins: { $sum: { $cond: [{ $gt: ['$pnlPercent', 0] }, 1, 0] } },
          monthlyLosses: { $sum: { $cond: [{ $lte: ['$pnlPercent', 0] }, 1, 0] } },
        },
      },
    ]);

    // Get all active users + open trades
    const [users, openTrades] = await Promise.all([
      this.subscriptionModel.find({ isActive: true })
        .select('telegramId username tradingBalance totalPnlUsdt totalWins totalLosses')
        .lean(),
      this.tradeModel.find({ status: 'OPEN' })
        .select('telegramId symbol direction entryPrice notionalUsdt leverage')
        .lean(),
    ]);

    // Group open trades by telegramId
    const openTradesMap = new Map<number, typeof openTrades>();
    for (const t of openTrades) {
      const arr = openTradesMap.get(t.telegramId) || [];
      arr.push(t);
      openTradesMap.set(t.telegramId, arr);
    }

    const allTimeMap = new Map(allTimeStats.map((s) => [s._id, s]));
    const monthlyMap = new Map(monthlyStats.map((s) => [s._id, s]));

    const ranked = users.map((u) => {
      const at = allTimeMap.get(u.telegramId) || { totalPnlUsdt: 0, totalPnlPercent: 0, wins: 0, losses: 0, totalTrades: 0 };
      const mo = monthlyMap.get(u.telegramId) || { monthlyPnlUsdt: 0, monthlyPnlPercent: 0, monthlyWins: 0, monthlyLosses: 0 };
      const userOpenTrades = openTradesMap.get(u.telegramId) || [];
      const totalTrades = at.wins + at.losses;
      const winRate = totalTrades > 0 ? (at.wins / totalTrades) * 100 : 0;
      return {
        telegramId: u.telegramId,
        username: u.username || `User ${u.telegramId}`,
        tradingBalance: u.tradingBalance ?? 1000,
        totalPnlUsdt: Math.round(at.totalPnlUsdt * 100) / 100,
        totalPnlPercent: Math.round(at.totalPnlPercent * 100) / 100,
        monthlyPnlUsdt: Math.round(mo.monthlyPnlUsdt * 100) / 100,
        monthlyPnlPercent: Math.round(mo.monthlyPnlPercent * 100) / 100,
        wins: at.wins,
        losses: at.losses,
        monthlyWins: mo.monthlyWins,
        monthlyLosses: mo.monthlyLosses,
        winRate: Math.round(winRate * 10) / 10,
        totalTrades,
        openOrders: userOpenTrades.length,
        openPositions: userOpenTrades.map((t) => ({
          symbol: t.symbol,
          direction: t.direction,
          entryPrice: t.entryPrice,
          notionalUsdt: t.notionalUsdt,
          leverage: t.leverage,
        })),
      };
    });

    ranked.sort((a, b) => b[sortField] - a[sortField]);

    return ranked.slice(0, limit).map((u, i) => ({ ...u, rank: i + 1 }));
  }

  async getUsers(query: {
    page?: number;
    limit?: number;
    isActive?: string;
    realModeEnabled?: string;
    search?: string;
  }): Promise<{ data: any[]; total: number; page: number; limit: number; totalPages: number }> {
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

    // Compute W/L and PnL from actual user_trades (CLOSED) for accuracy
    const telegramIds = data.map((u) => u.telegramId);
    const tradeStats = await this.tradeModel.aggregate([
      { $match: { telegramId: { $in: telegramIds }, status: 'CLOSED', pnlUsdt: { $ne: null } } },
      {
        $group: {
          _id: '$telegramId',
          totalPnlUsdt: { $sum: '$pnlUsdt' },
          totalWins: { $sum: { $cond: [{ $gt: ['$pnlUsdt', 0] }, 1, 0] } },
          totalLosses: { $sum: { $cond: [{ $lte: ['$pnlUsdt', 0] }, 1, 0] } },
        },
      },
    ]);

    const statsMap = new Map(tradeStats.map((s) => [s._id, s]));
    const enriched = data.map((u) => {
      const s = statsMap.get(u.telegramId);
      return {
        ...u,
        totalWins: s?.totalWins ?? 0,
        totalLosses: s?.totalLosses ?? 0,
        totalPnlUsdt: s ? Math.round(s.totalPnlUsdt * 100) / 100 : 0,
      };
    });

    return { data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
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
      realModeLeverageMode?: string | null;
      realModeLeverage?: number | null;
      coinVolumes?: Record<string, number> | null;
      cycleTargetMode?: string;
      // Grid Recovery
      gridEnabled?: boolean;
      gridLevelCount?: number | null;
      gridDeviationStep?: number | null;
      gridTpPct?: number | null;
      gridGlobalSlPct?: number | null;
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

  async setUserApiKeys(
    telegramId: number,
    exchange: 'binance' | 'okx',
    dto: { apiKey: string; apiSecret: string; passphrase?: string },
  ) {
    const exchangeData: any = {
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      createdAt: new Date(),
    };
    if (dto.passphrase) exchangeData.passphrase = dto.passphrase;

    await this.userSettingsModel.updateOne(
      { telegramId },
      { $set: { [exchange]: exchangeData, telegramId } },
      { upsert: true },
    );
    return { success: true };
  }

  async removeUserApiKeys(telegramId: number, exchange: 'binance' | 'okx') {
    await this.userSettingsModel.updateOne(
      { telegramId },
      { $unset: { [exchange]: 1 } },
    );
    return { success: true };
  }

  async getTradeStats(query: { status?: string; symbol?: string; telegramId?: string; dateFrom?: string; dateTo?: string }) {
    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.telegramId) filter.telegramId = parseInt(query.telegramId, 10);
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
    }

    const [total, pnlDocs] = await Promise.all([
      this.tradeModel.countDocuments(filter),
      this.tradeModel.find({ ...filter, pnlPercent: { $exists: true }, status: 'CLOSED' }).select('pnlPercent').lean(),
    ]);

    const wins = pnlDocs.filter((t) => t.pnlPercent > 0).length;
    const losses = pnlDocs.filter((t) => t.pnlPercent <= 0).length;
    const winRate = pnlDocs.length > 0 ? (wins / pnlDocs.length) * 100 : 0;
    const totalPnl = pnlDocs.reduce((sum, t) => sum + t.pnlPercent, 0);
    const avgPnl = pnlDocs.length > 0 ? totalPnl / pnlDocs.length : 0;

    return {
      total,
      wins,
      losses,
      winRate: Math.round(winRate * 10) / 10,
      avgPnl: Math.round(avgPnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
    };
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

  // ─── Trade Close ─────────────────────────────────────────────────────────────

  async closeTrade(tradeId: string): Promise<{ success: boolean; error?: string; pnlPct?: number }> {
    const trade = await this.tradeModel.findById(tradeId).lean();
    if (!trade) return { success: false, error: "Trade not found" };
    if (trade.status !== "OPEN") return { success: false, error: "Trade is not open" };

    const result = await this.userRealTradingService.closeRealPosition(
      trade.telegramId, trade.telegramId, trade.symbol, "ADMIN_CLOSE",
    );
    if (!result.success) return { success: false, error: "Failed to close position on Binance" };
    return { success: true, pnlPct: result.pnlPct };
  }

  async closeAllTrades(telegramId: number): Promise<{ success: boolean; closed: number; error?: string }> {
    const count = await this.userRealTradingService.closeAllRealPositions(
      telegramId, telegramId, "ADMIN_CLOSE",
    );

    // Reset cycle and start a new one
    const resetAt = new Date(Date.now() + 1000);
    await this.subscriptionModel.findOneAndUpdate(
      { telegramId },
      { $set: { cycleResetAt: resetAt, cyclePeakPct: 0, cyclePaused: false } },
    );

    return { success: true, closed: count };
  }

  // ─── Signal Validations ─────────────────────────────────────────────────────

  async getValidations(query: {
    page?: number; limit?: number;
    approved?: string; symbol?: string; direction?: string;
    dateFrom?: string; dateTo?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const filter: any = {};

    if (query.approved === 'true') filter.approved = true;
    else if (query.approved === 'false') filter.approved = false;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.direction) filter.direction = query.direction;
    if (query.dateFrom || query.dateTo) {
      filter.createdAt = {};
      if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }

    const [data, total] = await Promise.all([
      this.validationModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.validationModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getValidationStats() {
    const [total, approved, rejected] = await Promise.all([
      this.validationModel.countDocuments(),
      this.validationModel.countDocuments({ approved: true }),
      this.validationModel.countDocuments({ approved: false }),
    ]);
    const approvalRate = total > 0 ? Math.round((approved / total) * 10000) / 100 : 0;
    return { total, approved, rejected, approvalRate };
  }

  // ─── Cycle limit history ──────────────────────────────────────────────────

  async getCycleHistory(query: {
    page?: number;
    limit?: number;
    telegramId?: string;
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const filter: any = {};
    if (query.telegramId) filter.telegramId = parseInt(query.telegramId, 10);

    const [data, total] = await Promise.all([
      this.dailyLimitHistoryModel
        .find(filter)
        .sort({ triggeredAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.dailyLimitHistoryModel.countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
