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
import { AiReview, AiReviewDocument } from '../schemas/ai-review.schema';
import { Order, OrderDocument } from '../schemas/order.schema';
import { OnChainSnapshot, OnChainSnapshotDocument } from '../schemas/onchain-snapshot.schema';
import { UserRealTradingService } from '../ai-signal/user-real-trading.service';
import { AdminGateway } from './admin.gateway';

/** Must match the key in SignalQueueService. */
const ACTIVE_KEY = (signalKey: string) => `cache:ai-signal:active:${signalKey}`;

import { DUAL_TIMEFRAME_COINS } from '../ai-signal/constants';

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
    @InjectModel(AiReview.name) private aiReviewModel: Model<AiReviewDocument>,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(OnChainSnapshot.name) private onChainSnapshotModel: Model<OnChainSnapshotDocument>,
    private readonly redisService: RedisService,
    private readonly userRealTradingService: UserRealTradingService,
    private readonly adminGateway: AdminGateway,
  ) {}

  async getOrders(query: {
    status?: string; type?: string; symbol?: string;
    page?: number; limit?: number; sortBy?: string;
    closedFrom?: string; closedTo?: string;
  }) {
    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;
    if (query.symbol) filter.symbol = { $regex: query.symbol, $options: 'i' };
    if (query.closedFrom || query.closedTo) {
      filter.closedAt = {};
      if (query.closedFrom) filter.closedAt.$gte = new Date(query.closedFrom);
      if (query.closedTo) filter.closedAt.$lte = new Date(query.closedTo);
    }

    const page = query.page || 1;
    const limit = query.limit || 50;
    const sortBy = query.sortBy || 'createdAt';

    const [data, total, statsAgg] = await Promise.all([
      this.orderModel.find(filter)
        .sort({ [sortBy]: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.orderModel.countDocuments(filter),
      // Aggregate stats across ALL matching orders (not just current page)
      this.orderModel.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalPnlUsdt: { $sum: { $ifNull: ['$pnlUsdt', 0] } },
            winPnlUsdt: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, '$pnlUsdt', 0] } },
            lossPnlUsdt: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, '$pnlUsdt', 0] } },
            wins: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const stats = statsAgg[0] || { totalPnlUsdt: 0, winPnlUsdt: 0, lossPnlUsdt: 0, wins: 0, losses: 0 };
    const winRate = stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0;

    return { data, total, page, limit, pages: Math.ceil(total / limit), stats: { ...stats, winRate } };
  }

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
      _completedSignalDocs,
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
      this.signalModel.find({ status: 'COMPLETED', pnlPercent: { $exists: true }, source: { $ne: 'hedge' } }).select('pnlPercent pnlUsdt').lean(),
      this.signalModel.aggregate([
        { $match: { status: 'COMPLETED', pnlPercent: { $exists: true }, source: { $ne: 'hedge' } } },
        {
          $group: {
            _id: '$strategy',
            count: { $sum: 1 },
            wins: { $sum: { $cond: [{ $gt: ['$pnlPercent', 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: ['$pnlPercent', 0] }, 1, 0] } },
            totalPnl: { $sum: '$pnlPercent' },
          },
        },
      ]),
      this.signalModel.aggregate([{ $group: { _id: '$regime', count: { $sum: 1 } } }]),
      this.signalModel.find().sort({ createdAt: -1 }).limit(10).lean(),
      // PnL by day — from orders (includes MAIN + DCA + HEDGE)
      this.orderModel.aggregate([
        { $match: { status: 'CLOSED', closedAt: { $exists: true } } },
        {
          $addFields: {
            dateStr: { $dateToString: { format: '%Y-%m-%d', date: '$closedAt' } },
          },
        },
        { $sort: { closedAt: -1 as 1 | -1 } },
        { $limit: 10000 },
        {
          $group: {
            _id: '$dateStr',
            totalPnl: { $sum: { $ifNull: ['$pnlPercent', 0] } },
            totalPnlUsdt: { $sum: { $ifNull: ['$pnlUsdt', 0] } },
            count: { $sum: 1 },
            wins: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$pnlUsdt', 0] }, 0] }, 1, 0] } },
          },
        },
        { $sort: { _id: -1 as 1 | -1 } },
        { $limit: 30 },
      ]),
    ]);

    // Use orders for PnL stats (includes hedge PnL)
    const closedOrders = await this.orderModel.find({ status: 'CLOSED' }).select('pnlUsdt pnlPercent').lean();
    const wins = closedOrders.filter((o) => (o.pnlUsdt ?? 0) > 0).length;
    const losses = closedOrders.filter((o) => (o.pnlUsdt ?? 0) <= 0).length;
    const winRate = closedOrders.length > 0 ? (wins / closedOrders.length) * 100 : 0;
    const totalPnlUsdt = closedOrders.reduce((sum, o) => sum + ((o as any).pnlUsdt ?? 0), 0);
    const totalPnl = closedOrders.reduce((sum, o) => sum + ((o as any).pnlPercent ?? 0), 0);
    const avgPnl = closedOrders.length > 0 ? totalPnl / closedOrders.length : 0;

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
      totalPnlUsdt: d.totalPnlUsdt ?? 0,
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
      totalPnlUsdt: Math.round(totalPnlUsdt * 100) / 100,
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
    let totalPnlUsdt: number | undefined;
    let winPnl: number | undefined;
    let lossPnl: number | undefined;
    let winPnlUsdt: number | undefined;
    let lossPnlUsdt: number | undefined;
    if (filter.status === "COMPLETED") {
      const pnlExpr = { $ifNull: ["$pnlUsdt", { $multiply: [{ $divide: [{ $ifNull: ["$pnlPercent", 0] }, 100] }, { $ifNull: ["$simNotional", 1000] }] }] };
      const agg = await this.signalModel.aggregate([
        { $match: { ...filter, pnlPercent: { $exists: true } } },
        {
          $group: {
            _id: null,
            wins: { $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lte: ["$pnlPercent", 0] }, 1, 0] } },
            totalPnl: { $sum: "$pnlPercent" },
            totalPnlUsdt: { $sum: pnlExpr },
            winPnl: { $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, "$pnlPercent", 0] } },
            lossPnl: { $sum: { $cond: [{ $lte: ["$pnlPercent", 0] }, "$pnlPercent", 0] } },
            winPnlUsdt: { $sum: { $cond: [{ $gt: ["$pnlPercent", 0] }, pnlExpr, 0] } },
            lossPnlUsdt: { $sum: { $cond: [{ $lte: ["$pnlPercent", 0] }, pnlExpr, 0] } },
          },
        },
      ]);
      wins = agg[0]?.wins ?? 0;
      losses = agg[0]?.losses ?? 0;
      totalPnl = agg[0]?.totalPnl ?? 0;
      totalPnlUsdt = Math.round((agg[0]?.totalPnlUsdt ?? 0) * 100) / 100;
      winPnl = agg[0]?.winPnl ?? 0;
      lossPnl = agg[0]?.lossPnl ?? 0;
      winPnlUsdt = Math.round((agg[0]?.winPnlUsdt ?? 0) * 100) / 100;
      lossPnlUsdt = Math.round((agg[0]?.lossPnlUsdt ?? 0) * 100) / 100;
    }

    // Enrich ACTIVE signals with order-based data (source of truth)
    const enrichedData = await Promise.all(data.map(async (sig: any) => {
      if (sig.status !== 'ACTIVE') return sig;
      try {
        const [mainOrders, hedgeOrder] = await Promise.all([
          this.orderModel.find({ signalId: sig._id, type: { $in: ['MAIN', 'FLIP_MAIN'] }, status: 'OPEN' }).lean(),
          this.orderModel.findOne({ signalId: sig._id, type: 'HEDGE', status: 'OPEN' }).lean(),
        ]);
        const totalMainNotional = mainOrders.reduce((s, o) => s + (o.notional || 0), 0);
        const avgEntry = totalMainNotional > 0
          ? mainOrders.reduce((s, o) => s + o.entryPrice * o.notional, 0) / totalMainNotional
          : sig.gridAvgEntry || sig.entryPrice;
        return {
          ...sig,
          _orderState: {
            direction: mainOrders[0]?.direction ?? sig.direction,
            avgEntry: +avgEntry.toFixed(6),
            totalNotional: +totalMainNotional.toFixed(2),
            mainOrderCount: mainOrders.length,
            mainOrderType: mainOrders[0]?.type ?? null, // 'MAIN' or 'FLIP_MAIN'
            hedgeActive: !!hedgeOrder,
            hedgeDirection: hedgeOrder?.direction ?? null,
            hedgeEntryPrice: hedgeOrder?.entryPrice ?? null,
            hedgeNotional: hedgeOrder?.notional ?? null,
            hedgeTpPrice: hedgeOrder?.takeProfitPrice ?? null,
            hedgeOpenedAt: hedgeOrder?.openedAt ?? null,
          },
        };
      } catch { return sig; }
    }));

    return { data: enrichedData, total, page, limit, totalPages: Math.ceil(total / limit), wins, losses, totalPnl, totalPnlUsdt, winPnl, lossPnl, winPnlUsdt, lossPnlUsdt };
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
    // When re-enabling real mode, reset cycle so it starts fresh
    if (dto.realModeEnabled === true) {
      $set.cycleResetAt = new Date();
      $set.cyclePeakPct = 0;
      $set.cycleFloorPct = 0;
      $set.cyclePaused = false;
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
  async closeSignal(id: string, source?: string): Promise<{ success: boolean; pnlPercent?: number; error?: string }> {
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

    // Use gridAvgEntry for grid signals (weighted avg of filled grids)
    const entryForPnl = (signal as any).gridAvgEntry || signal.entryPrice;
    const pnlPercent = signal.direction === 'LONG'
      ? ((exitPrice - entryForPnl) / entryForPnl) * 100
      : ((entryForPnl - exitPrice) / entryForPnl) * 100;

    // Calculate USDT PnL from grid volumes
    const grids: any[] = (signal as any).gridLevels || [];
    let pnlUsdt: number | undefined;
    if (grids.length > 0) {
      const simNotional = (signal as any).simNotional || 1000;
      let totalUsdt = 0;
      for (const g of grids) {
        if (g.status === 'FILLED') {
          const vol = g.simNotional || simNotional * (g.volumePct / 100);
          const gPnl = signal.direction === 'LONG'
            ? ((exitPrice - g.fillPrice) / g.fillPrice) * 100
            : ((g.fillPrice - exitPrice) / g.fillPrice) * 100;
          totalUsdt += (gPnl / 100) * vol;
        }
      }
      pnlUsdt = Math.round(totalUsdt * 100) / 100;
    } else {
      pnlUsdt = Math.round((pnlPercent / 100) * ((signal as any).simNotional || 1000) * 100) / 100;
    }

    // Close all grid levels
    const updatedGrids = grids.map((g: any) => ({
      ...g,
      status: g.status === 'FILLED' ? 'SL_CLOSED' : g.status === 'PENDING' ? 'CANCELLED' : g.status,
      ...(g.status === 'FILLED' ? { closedAt: new Date(), exitPrice, pnlPct: signal.direction === 'LONG' ? ((exitPrice - g.fillPrice) / g.fillPrice) * 100 : ((g.fillPrice - exitPrice) / g.fillPrice) * 100 } : {}),
    }));

    const gridClosedCount = updatedGrids.filter((g: any) => g.status === 'SL_CLOSED' || g.status === 'TP_CLOSED').length;
    await this.signalModel.findByIdAndUpdate(id, {
      status: 'COMPLETED',
      closeReason: 'ADMIN_CLOSE',
      exitPrice,
      pnlPercent,
      pnlUsdt,
      positionClosedAt: new Date(),
      ...(updatedGrids.length > 0 ? { gridLevels: updatedGrids, gridClosedCount } : {}),
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

    // Hedge trade → close hedge only (via forceCloseHedge on signal)
    if (trade.isHedge && trade.aiSignalId) {
      const result = await this.forceCloseHedge(trade.aiSignalId.toString());
      return result;
    }

    // Main trade → closeRealPosition (will FLIP if hedge exists)
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

  // ─── Coin Stats ───────────────────────────────────────────────────────────

  async getCoinStats(query: { days?: string }) {
    const days = Math.min(30, Math.max(1, parseInt(query.days || '7', 10)));
    const lookbackDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const signals = await this.signalModel.find({
      status: 'COMPLETED',
      createdAt: { $gte: lookbackDate },
    }).lean();

    // Aggregate per coin
    const byCoin: Record<string, {
      symbol: string;
      trades: number;
      wins: number;
      losses: number;
      pnlUsdt: number;
      strategies: Set<string>;
      lastTrade: Date;
    }> = {};

    for (const s of signals) {
      const sym = (s as any).symbol || '';
      const coin = sym.replace('USDT', '');
      if (!coin) continue;
      if (!byCoin[coin]) byCoin[coin] = { symbol: sym, trades: 0, wins: 0, losses: 0, pnlUsdt: 0, strategies: new Set(), lastTrade: new Date(0) };
      const pnl = (s as any).pnlPercent || 0;
      const usdt = (s as any).pnlUsdt || (pnl / 100 * ((s as any).simNotional || 1000));
      if (usdt > 0) byCoin[coin].wins++; else byCoin[coin].losses++;
      byCoin[coin].trades++;
      byCoin[coin].pnlUsdt += usdt;
      if ((s as any).strategy) byCoin[coin].strategies.add((s as any).strategy);
      const ts = new Date((s as any).createdAt || 0);
      if (ts > byCoin[coin].lastTrade) byCoin[coin].lastTrade = ts;
    }

    const coinRows = Object.entries(byCoin).map(([coin, d]) => ({
      coin,
      symbol: d.symbol,
      trades: d.trades,
      wins: d.wins,
      losses: d.losses,
      winRate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0,
      pnlUsdt: Math.round(d.pnlUsdt * 100) / 100,
      strategies: [...d.strategies],
      lastTrade: d.lastTrade.toISOString(),
    })).sort((a, b) => b.pnlUsdt - a.pnlUsdt);

    // Blacklist from Redis
    const blacklistRaw = await this.redisService.get<string[]>('cache:coin-blacklist');
    const blacklist = blacklistRaw || [];

    // Strategy gates from Redis (for context)
    const gates = await this.redisService.get<Record<string, any>>('cache:strategy-gates') || {};

    return { coins: coinRows, blacklist, gates, days };
  }

  async setCoinOverride(coin: string, action: 'blacklist' | 'whitelist' | 'clear') {
    const blacklistRaw = await this.redisService.get<string[]>('cache:coin-blacklist');
    const blacklist = new Set(blacklistRaw || []);
    const STRATEGY_GATES_TTL = 5 * 60 * 60;

    if (action === 'blacklist') {
      blacklist.add(coin.toUpperCase());
    } else if (action === 'whitelist' || action === 'clear') {
      blacklist.delete(coin.toUpperCase());
    }

    await this.redisService.set('cache:coin-blacklist', [...blacklist], STRATEGY_GATES_TTL);
    return { ok: true, coin: coin.toUpperCase(), action, blacklistSize: blacklist.size };
  }

  async getAiReviews(query: Record<string, string>) {
    const limit = parseInt(query.limit || '20', 10);
    const reviews = await this.aiReviewModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return reviews;
  }

  async getOnChainSnapshots(query: { symbol?: string; page?: number; limit?: number; passed?: string }) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const filter: any = {};
    if (query.symbol) filter.symbol = { $regex: query.symbol, $options: 'i' };
    if (query.passed === 'true') filter.filterPassed = true;
    if (query.passed === 'false') filter.filterPassed = false;

    const [data, total] = await Promise.all([
      this.onChainSnapshotModel
        .find(filter)
        .sort({ snapshotAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.onChainSnapshotModel.countDocuments(filter),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Force open hedge for an active signal.
   * Sets flags so PositionMonitor triggers hedge on next tick.
   */
  async forceOpenHedge(id: string): Promise<{ success: boolean; error?: string }> {
    const signal = await this.signalModel.findById(id);
    if (!signal) return { success: false, error: 'Signal not found' };
    if (signal.status !== 'ACTIVE') return { success: false, error: `Signal is ${signal.status}` };

    // Check OPEN HEDGE order in DB (source of truth, not signal.hedgeActive flag)
    const existingHedge = await this.orderModel.findOne({ signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN' });
    if (existingHedge) return { success: false, error: 'Hedge already active (OPEN HEDGE order exists)' };

    // Set hedgeForceOpen flag — PositionMonitor will open hedge on next tick
    await this.signalModel.findByIdAndUpdate(id, {
      $set: { hedgeForceOpen: true },
    });

    this.logger.log(`[Admin] Force hedge requested for ${signal.symbol} (${id})`);
    return { success: true };
  }

  /**
   * Force close MAIN position for a signal.
   * If hedge is active → sets TP to force trigger on next tick → FLIP.
   * If no hedge → closes the entire signal.
   */
  async forceCloseMain(id: string): Promise<{ success: boolean; error?: string }> {
    const signal = await this.signalModel.findById(id);
    if (!signal) return { success: false, error: 'Signal not found' };
    if (signal.status !== 'ACTIVE') return { success: false, error: `Signal is ${signal.status}` };

    const hedgeOrder = await this.orderModel.findOne({ signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN' }).lean();
    if (!hedgeOrder) {
      // No hedge → close entire signal
      return this.closeSignal(id);
    }

    // Force main TP to trigger FLIP on next tick
    const mainOrder = await this.orderModel.findOne({
      signalId: (signal as any)._id, type: { $in: ['MAIN', 'FLIP_MAIN'] }, status: 'OPEN',
    }).lean();
    if (!mainOrder) return { success: false, error: 'No OPEN main order found' };

    const dir = mainOrder.direction;
    const forceTP = dir === 'LONG' ? 0.0001 : 999999;
    await this.signalModel.findByIdAndUpdate(id, { $set: { takeProfitPrice: forceTP } });
    await this.orderModel.findByIdAndUpdate(mainOrder._id, { takeProfitPrice: forceTP });

    this.logger.log(`[Admin] Force close MAIN requested for ${signal.symbol} → FLIP to hedge ${hedgeOrder.direction} (${id})`);

    // Also trigger real close for all subscribers
    const subscribers = await this.subscriptionModel.find({ realModeEnabled: true }).lean();
    for (const sub of subscribers) {
      await this.userRealTradingService.closeRealPosition(
        sub.telegramId, sub.chatId || sub.telegramId, signal.symbol, 'ADMIN_CLOSE',
      ).catch((err) => this.logger.warn(`[Admin] Real close failed for ${sub.telegramId}: ${err?.message}`));
    }

    return { success: true };
  }

  /**
   * Force close hedge for an active signal.
   * Sets hedgeTpPrice to trigger immediate TP on next tick.
   */
  async forceCloseHedge(id: string, source?: string): Promise<{ success: boolean; error?: string }> {
    const signal = await this.signalModel.findById(id);
    if (!signal) return { success: false, error: 'Signal not found' };
    if (signal.status !== 'ACTIVE') return { success: false, error: `Signal is ${signal.status}` };

    // Read hedge state from OPEN HEDGE order (source of truth)
    const hedgeOrder = await this.orderModel.findOne({ signalId: (signal as any)._id, type: 'HEDGE', status: 'OPEN' }).lean();
    if (!hedgeOrder) return { success: false, error: 'No active hedge (no OPEN HEDGE order)' };

    const hedgeEntry = hedgeOrder.entryPrice;
    const hedgeDir = hedgeOrder.direction;


    // Force hedge TP by setting price to immediate trigger
    // SHORT hedge: set TP very high (any price triggers)
    // LONG hedge: set TP very low (any price triggers)
    const forceTP = hedgeDir === 'LONG' ? 0.0001 : 999999;
    await this.signalModel.findByIdAndUpdate(id, {
      $set: { hedgeTpPrice: forceTP, hedgeForceClose: true },
    });
    // Also update the HEDGE order takeProfitPrice (source of truth for checkHedgeExit)
    await this.orderModel.findByIdAndUpdate(hedgeOrder._id, { takeProfitPrice: forceTP });

    this.logger.log(`[Admin] Force hedge close requested for ${signal.symbol} (${id})`);
    return { success: true };
  }

  /** Get filter rejection funnel — counts of signals blocked at each filter stage (24h rolling). */
  async getFilterFunnel(): Promise<Record<string, number>> {
    const keys = [
      'regime_block',
      'funding_block',
      'confidence_block',
      'extreme_move',
      'ai_gate_reject',
      'cooldown',
    ];
    const result: Record<string, number> = {};
    for (const key of keys) {
      const val = await this.redisService.get<number>(`cache:ai:filter:${key}`);
      result[key] = val || 0;
    }
    return result;
  }

  /** Get all orders for a signal (for admin panel signal detail). */
  async getSignalOrders(signalId: string): Promise<any> {
    const { Types } = require('mongoose');
    const oid = Types.ObjectId.isValid(signalId) ? new Types.ObjectId(signalId) : signalId;
    const orders = await this.orderModel.find({ signalId: oid }).sort({ openedAt: -1 }).lean();

    // Build hedge waterfall summary from closed hedge orders
    const closedHedges = orders
      .filter((o: any) => o.type === 'HEDGE' && o.status === 'CLOSED')
      .sort((a: any, b: any) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());

    const cycles = closedHedges.map((h: any, idx: number) => {
      const openedAt = h.openedAt ? new Date(h.openedAt) : null;
      const closedAt = h.closedAt ? new Date(h.closedAt) : null;
      let duration = '';
      if (openedAt && closedAt) {
        const diffMs = closedAt.getTime() - openedAt.getTime();
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin < 60) duration = `${diffMin}m`;
        else if (diffMin < 1440) duration = `${Math.round(diffMin / 60)}h`;
        else duration = `${Math.round(diffMin / 1440)}d`;
      }
      return {
        cycle: idx + 1,
        direction: h.direction,
        entry: h.entryPrice || 0,
        exit: h.exitPrice || 0,
        pnl: Math.round((h.pnlUsdt || 0) * 100) / 100,
        duration,
        reason: h.closeReason || 'UNKNOWN',
      };
    });

    const totalBanked = Math.round(cycles.reduce((sum: number, c: any) => sum + c.pnl, 0) * 100) / 100;

    return {
      orders,
      hedgeWaterfall: {
        totalCycles: cycles.length,
        totalBanked,
        cycles,
      },
    };
  }
}
