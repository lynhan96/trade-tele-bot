import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { RedisService } from "../redis/redis.service";
import { AiSignal, AiSignalDocument } from "../schemas/ai-signal.schema";
import { AiTunedParams } from "../strategy/ai-optimizer/ai-tuned-params.interface";
import { SignalResult } from "../strategy/rules/rule-engine.service";

export interface SignalHandleResult {
  action: "EXECUTED" | "QUEUED" | "SKIPPED";
  signalId?: string;
}

const ACTIVE_KEY = (signalKey: string) => `cache:ai-signal:active:${signalKey}`;
const QUEUED_KEY = (signalKey: string) => `cache:ai-signal:queued:${signalKey}`;

/** Coins that run BOTH INTRADAY and SWING strategies simultaneously. */
const DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

// TTLs per timeframe profile
const INTRADAY_QUEUED_TTL = 4 * 60 * 60; // 4h
const SWING_QUEUED_TTL = 48 * 60 * 60; // 48h
function getQueuedTtl(profile?: string): number {
  return profile === "SWING" ? SWING_QUEUED_TTL : INTRADAY_QUEUED_TTL;
}

@Injectable()
export class SignalQueueService {
  private readonly logger = new Logger(SignalQueueService.name);

  constructor(
    @InjectModel(AiSignal.name)
    private readonly aiSignalModel: Model<AiSignalDocument>,
    private readonly redisService: RedisService,
  ) {}

  // ─── Main entry point ────────────────────────────────────────────────────

  /**
   * Handle a new signal result from the rule engine.
   * Decides whether to execute immediately (ACTIVE), queue it (QUEUED), or skip (SKIPPED).
   */
  async handleNewSignal(
    coin: string,
    currency: string,
    signalResult: SignalResult,
    params: AiTunedParams,
    regime: string,
    isTestMode = false,
    forceProfile?: string,
  ): Promise<SignalHandleResult> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    // Only dual-timeframe coins use profile-aware Redis key (must match processCoin + docSignalKey)
    const isDual = DUAL_TIMEFRAME_COINS.includes(coin.toUpperCase());
    const signalKey = isDual && forceProfile ? `${symbol}:${forceProfile}` : symbol;

    const active = await this.getActiveSignal(signalKey);

    // For dual-timeframe coins: if ANY signal already active in another profile, skip
    if (!active && DUAL_TIMEFRAME_COINS.includes(coin.toUpperCase()) && forceProfile) {
      const otherProfile = forceProfile === "INTRADAY" ? "SWING" : "INTRADAY";
      const otherActive = await this.getActiveSignal(`${symbol}:${otherProfile}`);
      if (otherActive) {
        this.logger.debug(
          `[SignalQueue] ${signalKey} skip — already active in ${otherProfile} (${otherActive.direction})`,
        );
        return { action: "SKIPPED" };
      }
    }

    if (!active) {
      // No Redis key — but there might be orphaned ACTIVE docs in MongoDB
      // (happens when Redis TTL expires before signal is resolved)
      await this.restoreOrphanedActives(symbol, signalKey);

      // No active signal — execute immediately
      const doc = await this.saveSignal(
        coin,
        currency,
        signalResult,
        params,
        regime,
        "ACTIVE",
        isTestMode,
      );
      await this.redisService.set(
        ACTIVE_KEY(signalKey),
        doc._id.toString(),
        0, // no TTL — active signals managed by age-based cron
      );
      this.logger.log(
        `[SignalQueue] ${signalKey} ${signalResult.isLong ? "LONG" : "SHORT"} → ACTIVE [${params.timeframeProfile || "INTRADAY"}] (id: ${doc._id})${isTestMode ? " [TEST]" : ""}`,
      );
      return { action: "EXECUTED", signalId: doc._id.toString() };
    }

    const isSameDirection =
      (active.direction === "LONG") === signalResult.isLong;

    if (isSameDirection) {
      // Same direction as active — skip without saving to DB (avoids junk records)
      return { action: "SKIPPED" };
    }

    // Opposite direction — queue it (replacing existing queue if any)
    const existingQueued = await this.getQueuedSignal(signalKey);
    if (existingQueued) {
      await this.aiSignalModel.findByIdAndUpdate(existingQueued._id, {
        status: "CANCELLED",
        closeReason: "REPLACED_BY_NEW",
      });
      await this.redisService.delete(QUEUED_KEY(signalKey));
      this.logger.log(
        `[SignalQueue] ${signalKey} replaced existing queued signal`,
      );
    }

    const queuedTtl = getQueuedTtl(params.timeframeProfile);
    const queuedTtlHours = queuedTtl / 3600;
    const doc = await this.saveSignal(
      coin,
      currency,
      signalResult,
      params,
      regime,
      "QUEUED",
      isTestMode,
    );
    await this.redisService.set(
      QUEUED_KEY(signalKey),
      doc._id.toString(),
      queuedTtl,
    );
    this.logger.log(
      `[SignalQueue] ${signalKey} ${signalResult.isLong ? "LONG" : "SHORT"} → QUEUED [${params.timeframeProfile || "INTRADAY"}] (id: ${doc._id}, expires in ${queuedTtlHours}h)${isTestMode ? " [TEST]" : ""}`,
    );
    return { action: "QUEUED", signalId: doc._id.toString() };
  }

  // ─── Position resolution ─────────────────────────────────────────────────

  /**
   * Called by PositionMonitorService when a position closes.
   * Marks the active signal as COMPLETED and promotes any queued signal.
   */
  async resolveActiveSignal(
    symbol: string,
    exitPrice: number,
    reason: "POSITION_CLOSED" | "TAKE_PROFIT" | "STOP_LOSS" | "AUTO_TAKE_PROFIT" | "MANUAL" = "POSITION_CLOSED",
  ): Promise<AiSignalDocument | null> {
    const activeId = await this.redisService.get<string>(ACTIVE_KEY(symbol));
    if (!activeId) return null;

    const active = await this.aiSignalModel.findById(activeId);
    if (!active) {
      await this.redisService.delete(ACTIVE_KEY(symbol));
      return null;
    }

    const pnlPercent =
      active.direction === "LONG"
        ? ((exitPrice - active.entryPrice) / active.entryPrice) * 100
        : ((active.entryPrice - exitPrice) / active.entryPrice) * 100;

    await this.aiSignalModel.findByIdAndUpdate(activeId, {
      status: "COMPLETED",
      closeReason: reason,
      exitPrice,
      pnlPercent,
      positionClosedAt: new Date(),
    });

    await this.redisService.delete(ACTIVE_KEY(symbol));
    this.logger.log(
      `[SignalQueue] ${symbol} COMPLETED — exitPrice=${exitPrice} pnl=${pnlPercent.toFixed(2)}%`,
    );

    return active;
  }

  /**
   * Promote a QUEUED signal to ACTIVE and return it (so caller can execute it).
   */
  async activateQueuedSignal(symbol: string): Promise<AiSignalDocument | null> {
    const queuedId = await this.redisService.get<string>(QUEUED_KEY(symbol));
    if (!queuedId) return null;

    const queued = await this.aiSignalModel.findById(queuedId);
    if (!queued) {
      await this.redisService.delete(QUEUED_KEY(symbol));
      return null;
    }

    // Check TTL — if expiresAt has passed, cancel it instead
    if (queued.expiresAt < new Date()) {
      await this.aiSignalModel.findByIdAndUpdate(queuedId, {
        status: "CANCELLED",
        closeReason: "TTL_EXPIRED",
      });
      await this.redisService.delete(QUEUED_KEY(symbol));
      this.logger.log(
        `[SignalQueue] ${symbol} queued signal expired — not activating`,
      );
      return null;
    }

    await this.aiSignalModel.findByIdAndUpdate(queuedId, {
      status: "ACTIVE",
      executedAt: new Date(),
    });
    await this.redisService.delete(QUEUED_KEY(symbol));
    await this.redisService.set(
      ACTIVE_KEY(symbol),
      queuedId,
      0, // no TTL — active signals managed by age-based cron
    );

    const updated = await this.aiSignalModel.findById(queuedId);
    this.logger.log(
      `[SignalQueue] ${symbol} QUEUED → ACTIVE (id: ${queuedId})`,
    );
    return updated;
  }

  /**
   * Move stop loss to entry price (break-even protection).
   * Called when unrealized PnL reaches the threshold.
   */
  async moveStopLossToEntry(signalId: string): Promise<void> {
    const signal = await this.aiSignalModel.findById(signalId);
    if (!signal || signal.status !== "ACTIVE") return;

    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      stopLossPrice: signal.entryPrice,
      slMovedToEntry: true,
    });
    this.logger.log(
      `[SignalQueue] ${signal.symbol} SL moved to entry ${signal.entryPrice} (break-even)`,
    );
  }

  /**
   * Raise trailing stop loss + persist peak PnL to DB.
   */
  async raiseStopLoss(signalId: string, newStopLoss: number, peakPnlPct?: number): Promise<void> {
    const signal = await this.aiSignalModel.findById(signalId);
    if (!signal || signal.status !== "ACTIVE") return;

    const update: any = { stopLossPrice: newStopLoss };
    if (peakPnlPct != null) update.peakPnlPct = peakPnlPct;

    await this.aiSignalModel.findByIdAndUpdate(signalId, update);
    this.logger.log(
      `[SignalQueue] ${signal.symbol} trailing SL → ${newStopLoss.toFixed(4)}${peakPnlPct ? ` (peak: ${peakPnlPct.toFixed(1)}%)` : ""}`,
    );
  }

  /**
   * Extend take profit price (dynamic TP boost on momentum).
   * Called when strong volume/price momentum is detected.
   */
  async extendTakeProfit(signalId: string, newTpPrice: number, newTpPct: number): Promise<void> {
    const signal = await this.aiSignalModel.findById(signalId);
    if (!signal || signal.status !== "ACTIVE") return;

    await this.aiSignalModel.findByIdAndUpdate(signalId, {
      takeProfitPrice: newTpPrice,
      takeProfitPercent: newTpPct,
      tpBoosted: true,
    });
    this.logger.log(
      `[SignalQueue] ${signal.symbol} TP extended to ${newTpPrice.toFixed(4)} (${newTpPct.toFixed(1)}%) — momentum boost`,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Get the profile-aware signal key from a document. */
  private docSignalKey(doc: AiSignalDocument): string {
    const coin = doc.coin.toUpperCase();
    const profile = (doc as any).timeframeProfile;
    if (DUAL_TIMEFRAME_COINS.includes(coin) && profile) {
      return `${doc.symbol}:${profile}`;
    }
    return doc.symbol;
  }

  // ─── TTL cleanup ──────────────────────────────────────────────────────────

  /**
   * Cancel all QUEUED signals that have passed their expiresAt.
   * Returns count of cancelled queued signals.
   */
  async cleanupExpiredQueued(): Promise<{ count: number }> {
    let count = 0;

    // Clean expired QUEUED
    const expiredQueued = await this.aiSignalModel.find({
      status: "QUEUED",
      expiresAt: { $lt: new Date() },
    });

    for (const doc of expiredQueued) {
      const sigKey = this.docSignalKey(doc);
      await this.aiSignalModel.findByIdAndUpdate(doc._id, {
        status: "CANCELLED",
        closeReason: "TTL_EXPIRED",
      });
      await this.redisService.delete(QUEUED_KEY(sigKey));
      this.logger.log(
        `[SignalQueue] Expired QUEUED signal for ${sigKey} (id: ${doc._id})`,
      );
    }
    count += expiredQueued.length;

    return { count };
  }

  /**
   * Find ACTIVE signals older than the given age (in ms).
   * Returns docs so the caller can check PnL and decide to close or keep.
   */
  async findOldActiveSignals(maxAgeMs: number): Promise<AiSignalDocument[]> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return this.aiSignalModel.find({
      status: "ACTIVE",
      executedAt: { $lt: cutoff },
    });
  }

  /**
   * Close an active signal as COMPLETED with exit price and PnL.
   */
  async closeActiveSignalWithPnl(
    doc: AiSignalDocument,
    exitPrice: number,
    reason: string = "AUTO_CLOSE_PROFIT",
  ): Promise<void> {
    const sigKey = this.docSignalKey(doc);
    const pnlPercent =
      doc.direction === "LONG"
        ? ((exitPrice - doc.entryPrice) / doc.entryPrice) * 100
        : ((doc.entryPrice - exitPrice) / doc.entryPrice) * 100;

    await this.aiSignalModel.findByIdAndUpdate(doc._id, {
      status: "COMPLETED",
      closeReason: reason,
      exitPrice,
      pnlPercent,
      positionClosedAt: new Date(),
    });
    await this.redisService.delete(ACTIVE_KEY(sigKey));
    this.logger.log(
      `[SignalQueue] ${sigKey} COMPLETED (${reason}) — exitPrice=${exitPrice} pnl=${pnlPercent.toFixed(2)}%`,
    );
  }

  /**
   * Restore ACTIVE signals on startup.
   * Re-creates Redis keys for any ACTIVE doc missing one.
   * If multiple docs exist for the same symbol, keeps the newest and cancels the rest.
   */
  async cleanupOrphanedActives(): Promise<number> {
    let count = 0;
    const allActives = await this.aiSignalModel.find({ status: "ACTIVE" });

    // Group by signal key to find duplicates
    const byKey = new Map<string, AiSignalDocument[]>();
    for (const doc of allActives) {
      const sigKey = this.docSignalKey(doc);
      if (!byKey.has(sigKey)) byKey.set(sigKey, []);
      byKey.get(sigKey)!.push(doc);
    }

    for (const [sigKey, docs] of byKey) {
      if (docs.length <= 1) {
        // Single doc — ensure Redis key exists
        const doc = docs[0];
        const redisId = await this.redisService.get<string>(ACTIVE_KEY(sigKey));
        if (!redisId) {
          await this.redisService.set(ACTIVE_KEY(sigKey), doc._id.toString());
          this.logger.log(`[SignalQueue] Startup: restored Redis key for ${sigKey} (id: ${doc._id})`);
          count++;
        }
        continue;
      }

      // Multiple docs for same key — keep newest, cancel rest
      docs.sort((a, b) => new Date(b.executedAt || (b as any).createdAt).getTime() - new Date(a.executedAt || (a as any).createdAt).getTime());
      const keep = docs[0];
      await this.redisService.set(ACTIVE_KEY(sigKey), keep._id.toString());
      this.logger.log(`[SignalQueue] Startup: kept newest ${sigKey} (id: ${keep._id})`);

      for (let i = 1; i < docs.length; i++) {
        await this.aiSignalModel.findByIdAndUpdate(docs[i]._id, {
          status: "CANCELLED",
          closeReason: "DUPLICATE",
        });
        this.logger.log(`[SignalQueue] Startup: cancelled duplicate ${sigKey} (id: ${docs[i]._id})`);
      }
      count++;
    }

    return count;
  }

  /**
   * Restore Redis keys for any ACTIVE documents in MongoDB for a symbol
   * that are missing their Redis key.
   */
  private async restoreOrphanedActives(symbol: string, signalKey: string): Promise<void> {
    const orphans = await this.aiSignalModel.find({ symbol, status: "ACTIVE" });
    for (const doc of orphans) {
      const docKey = this.docSignalKey(doc);
      const redisId = await this.redisService.get<string>(ACTIVE_KEY(docKey));
      if (!redisId) {
        await this.redisService.set(ACTIVE_KEY(docKey), doc._id.toString());
        this.logger.log(
          `[SignalQueue] Restored orphaned ACTIVE: ${docKey} (id: ${doc._id})`,
        );
      }
    }
  }

  // ─── Read helpers ─────────────────────────────────────────────────────────

  async getActiveSignal(symbol: string): Promise<AiSignalDocument | null> {
    const id = await this.redisService.get<string>(ACTIVE_KEY(symbol));
    if (!id) return null;
    return this.aiSignalModel.findById(id);
  }

  async getQueuedSignal(symbol: string): Promise<AiSignalDocument | null> {
    const id = await this.redisService.get<string>(QUEUED_KEY(symbol));
    if (!id) return null;
    return this.aiSignalModel.findById(id);
  }

  /**
   * Update signal entry price to current market price and recalculate SL/TP proportionally.
   * Called at activation to ensure prices match reality (candle close can be stale).
   */
  async refreshEntryPrice(signal: AiSignalDocument, currentPrice: number): Promise<AiSignalDocument> {
    const oldEntry = signal.entryPrice;
    if (!currentPrice || currentPrice <= 0 || Math.abs(currentPrice - oldEntry) / oldEntry < 0.001) {
      return signal; // no meaningful change
    }

    const isLong = signal.direction === "LONG";
    const slPct = signal.stopLossPercent;
    const tpPct = signal.takeProfitPercent;

    const newSl = isLong
      ? currentPrice * (1 - slPct / 100)
      : currentPrice * (1 + slPct / 100);
    const newTp = isLong
      ? currentPrice * (1 + tpPct / 100)
      : currentPrice * (1 - tpPct / 100);

    await this.aiSignalModel.findByIdAndUpdate((signal as any)._id, {
      entryPrice: currentPrice,
      stopLossPrice: parseFloat(newSl.toFixed(8)),
      takeProfitPrice: parseFloat(newTp.toFixed(8)),
    });

    this.logger.log(
      `[SignalQueue] ${signal.symbol} entry refreshed: $${oldEntry.toFixed(4)} → $${currentPrice.toFixed(4)} (SL/TP recalculated)`,
    );

    return this.aiSignalModel.findById((signal as any)._id);
  }

  async getAllActiveSignals(): Promise<AiSignalDocument[]> {
    return this.aiSignalModel.find({ status: "ACTIVE" });
  }

  async getAllQueuedSignals(): Promise<AiSignalDocument[]> {
    return this.aiSignalModel.find({ status: "QUEUED" });
  }

  /**
   * Cancel ALL active and queued signals (admin reset).
   * Also clears all Redis signal state keys.
   * Returns count of cancelled documents.
   */
  async cancelAllSignals(): Promise<number> {
    // Cancel in MongoDB
    const result = await this.aiSignalModel.updateMany(
      { status: { $in: ["ACTIVE", "QUEUED"] } },
      { status: "CANCELLED", closeReason: "ADMIN_RESET" },
    );
    // Clear all Redis signal keys
    const keys = await this.redisService.keys("cache:ai-signal:*");
    const prefix = "binance-bot:";
    await Promise.all(
      keys.map((k) => {
        const unprefixed = k.startsWith(prefix) ? k.slice(prefix.length) : k;
        return this.redisService.delete(unprefixed);
      }),
    );
    this.logger.log(`[SignalQueue] Admin reset: cancelled ${result.modifiedCount} signals, cleared ${keys.length} Redis keys`);
    return result.modifiedCount;
  }

  /**
   * Full reset: delete ALL signal documents + clear all Redis signal/params/cooldown keys.
   * Returns count of deleted signal documents.
   */
  async fullReset(): Promise<number> {
    const result = await this.aiSignalModel.deleteMany({});
    const patterns = ["cache:ai-signal:*", "cache:ai:params:*", "cache:ai:cooldown:*"];
    const prefix = "binance-bot:";
    let keysCleared = 0;
    for (const pattern of patterns) {
      const keys = await this.redisService.keys(pattern);
      await Promise.all(
        keys.map((k) => {
          const unprefixed = k.startsWith(prefix) ? k.slice(prefix.length) : k;
          return this.redisService.delete(unprefixed);
        }),
      );
      keysCleared += keys.length;
    }
    this.logger.log(`[SignalQueue] Full reset: deleted ${result.deletedCount} signals, cleared ${keysCleared} Redis keys`);
    return result.deletedCount;
  }

  // ─── Duplicate cleanup (for accurate stats) ─────────────────────────────

  /**
   * Find and clean duplicate COMPLETED signals — keeps the earliest signal in
   * each (symbol, direction, timeframeProfile) group where generatedAt is within
   * 5 minutes.  Duplicates are set to CANCELLED with closeReason "REPLACED_BY_NEW".
   * Returns the number of duplicates cancelled.
   */
  async cleanupDuplicateCompletedSignals(): Promise<number> {
    let cancelled = 0;

    // Find all COMPLETED signals with pnlPercent (the ones used for stats)
    const completed = await this.aiSignalModel
      .find({ status: "COMPLETED", pnlPercent: { $exists: true } })
      .sort({ generatedAt: 1 })
      .lean();

    // Group by symbol + direction + timeframeProfile
    const groups = new Map<string, typeof completed>();
    for (const doc of completed) {
      const key = `${doc.symbol}|${doc.direction}|${(doc as any).timeframeProfile || "INTRADAY"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(doc);
    }

    const dupIds: string[] = [];

    for (const [, docs] of groups) {
      if (docs.length <= 1) continue;

      // Walk through sorted docs and cluster by 5-min windows
      let anchor = docs[0];
      for (let i = 1; i < docs.length; i++) {
        const curr = docs[i];
        const diffMs =
          new Date(curr.generatedAt).getTime() -
          new Date(anchor.generatedAt).getTime();

        if (diffMs < 5 * 60 * 1000) {
          // Same cluster — curr is a duplicate, keep anchor
          dupIds.push((curr as any)._id.toString());
        } else {
          // New cluster
          anchor = curr;
        }
      }
    }

    if (dupIds.length > 0) {
      const result = await this.aiSignalModel.updateMany(
        { _id: { $in: dupIds } },
        { status: "CANCELLED", closeReason: "REPLACED_BY_NEW" },
      );
      cancelled = result.modifiedCount;
      this.logger.warn(
        `[SignalQueue] Cleaned ${cancelled} duplicate COMPLETED signals from DB`,
      );
    }

    return cancelled;
  }

  // ─── Internal: save a signal to MongoDB ──────────────────────────────────

  private async saveSignal(
    coin: string,
    currency: string,
    signalResult: SignalResult,
    params: AiTunedParams,
    regime: string,
    status: "ACTIVE" | "QUEUED" | "SKIPPED",
    isTestMode = false,
  ): Promise<AiSignalDocument> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;
    const MIN_SL = 2.5;  // tighter SL — cut losses faster
    // Regime-based TP floor: ranging markets need quick exits; trending markets can run further.
    // Data shows signals peak at 2–3% avg — 5% TP was unreachable for most signals.
    const MIN_TP_BY_REGIME: Record<string, number> = {
      STRONG_BULL: 4.0, STRONG_BEAR: 4.0,  // trend can sustain 4%
      RANGE_BOUND: 3.0, SIDEWAYS: 3.0,     // mean-reversion: take profits quickly
      VOLATILE: 4.0,                         // wider swings, target more
      MIXED: 3.5, BTC_CORRELATION: 3.5,    // uncertain — moderate target
    };
    const MIN_TP = MIN_TP_BY_REGIME[regime] ?? 3.5;
    const stopLossPercent = Math.max(params.stopLossPercent, MIN_SL);
    const takeProfitPercent = Math.max(params.takeProfitPercent ?? stopLossPercent * 1.5, MIN_TP);
    const entryPrice = signalResult.entryPrice;

    const stopLossPrice = signalResult.isLong
      ? entryPrice * (1 - stopLossPercent / 100)
      : entryPrice * (1 + stopLossPercent / 100);

    const takeProfitPrice = signalResult.isLong
      ? entryPrice * (1 + takeProfitPercent / 100)
      : entryPrice * (1 - takeProfitPercent / 100);

    const profile = params.timeframeProfile || "INTRADAY";
    const now = new Date();
    // QUEUED signals have a TTL expiry; ACTIVE signals have no expiry (managed by age-based cron)
    const expiresAt = status === "QUEUED"
      ? new Date(now.getTime() + getQueuedTtl(profile) * 1000)
      : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // far future

    const primaryKline =
      params.rsiCross?.primaryKline ||
      params.rsiZone?.primaryKline ||
      (profile === "SWING" ? "4h" : "15m");

    const doc = await this.aiSignalModel.create({
      symbol,
      coin: coin.toLowerCase(),
      currency: currency.toLowerCase(),
      direction: signalResult.isLong ? "LONG" : "SHORT",
      entryPrice,
      stopLossPrice: parseFloat(stopLossPrice.toFixed(8)),
      stopLossPercent,
      takeProfitPrice: parseFloat(takeProfitPrice.toFixed(8)),
      takeProfitPercent,
      strategy: signalResult.strategy,
      regime,
      aiConfidence: params.confidence,
      aiParams: params,
      status,
      expiresAt,
      executedAt: status === "ACTIVE" ? now : undefined,
      sentToUsers: 0,
      isTestMode,
      generatedAt: now,
      primaryKline,
      timeframeProfile: profile,
      indicatorSnapshot: { reason: signalResult.reason },
    });

    return doc;
  }
}
