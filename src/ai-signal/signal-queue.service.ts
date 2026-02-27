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

const ACTIVE_KEY = (symbol: string) => `cache:ai-signal:active:${symbol}`;
const QUEUED_KEY = (symbol: string) => `cache:ai-signal:queued:${symbol}`;

// TTLs per timeframe profile
const INTRADAY_ACTIVE_TTL = 8 * 60 * 60; // 8h
const INTRADAY_QUEUED_TTL = 4 * 60 * 60; // 4h
const SWING_ACTIVE_TTL = 72 * 60 * 60; // 72h
const SWING_QUEUED_TTL = 48 * 60 * 60; // 48h

function getActiveTtl(profile?: string): number {
  return profile === "SWING" ? SWING_ACTIVE_TTL : INTRADAY_ACTIVE_TTL;
}
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
  ): Promise<SignalHandleResult> {
    const symbol = `${coin.toUpperCase()}${currency.toUpperCase()}`;

    const active = await this.getActiveSignal(symbol);

    if (!active) {
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
        ACTIVE_KEY(symbol),
        doc._id.toString(),
        getActiveTtl(params.timeframeProfile),
      );
      this.logger.log(
        `[SignalQueue] ${symbol} ${signalResult.isLong ? "LONG" : "SHORT"} → ACTIVE [${params.timeframeProfile || "INTRADAY"}] (id: ${doc._id})${isTestMode ? " [TEST]" : ""}`,
      );
      return { action: "EXECUTED", signalId: doc._id.toString() };
    }

    const isSameDirection =
      (active.direction === "LONG") === signalResult.isLong;

    if (isSameDirection) {
      // Same direction as active — skip silently
      await this.saveSignal(
        coin,
        currency,
        signalResult,
        params,
        regime,
        "SKIPPED",
        isTestMode,
      );
      this.logger.debug(
        `[SignalQueue] ${symbol} SKIPPED — same direction as active`,
      );
      return { action: "SKIPPED" };
    }

    // Opposite direction — queue it (replacing existing queue if any)
    const existingQueued = await this.getQueuedSignal(symbol);
    if (existingQueued) {
      await this.aiSignalModel.findByIdAndUpdate(existingQueued._id, {
        status: "CANCELLED",
        closeReason: "REPLACED_BY_NEW",
      });
      await this.redisService.delete(QUEUED_KEY(symbol));
      this.logger.log(
        `[SignalQueue] ${symbol} replaced existing queued signal`,
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
      QUEUED_KEY(symbol),
      doc._id.toString(),
      queuedTtl,
    );
    this.logger.log(
      `[SignalQueue] ${symbol} ${signalResult.isLong ? "LONG" : "SHORT"} → QUEUED [${params.timeframeProfile || "INTRADAY"}] (id: ${doc._id}, expires in ${queuedTtlHours}h)${isTestMode ? " [TEST]" : ""}`,
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
    reason: "POSITION_CLOSED" | "MANUAL" = "POSITION_CLOSED",
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
      getActiveTtl((queued as any).timeframeProfile),
    );

    const updated = await this.aiSignalModel.findById(queuedId);
    this.logger.log(
      `[SignalQueue] ${symbol} QUEUED → ACTIVE (id: ${queuedId})`,
    );
    return updated;
  }

  // ─── TTL cleanup ──────────────────────────────────────────────────────────

  /**
   * Cancel all QUEUED signals that have passed their expiresAt.
   * Called every 5 minutes.
   */
  async cleanupExpiredQueued(): Promise<number> {
    const expired = await this.aiSignalModel.find({
      status: "QUEUED",
      expiresAt: { $lt: new Date() },
    });

    for (const doc of expired) {
      await this.aiSignalModel.findByIdAndUpdate(doc._id, {
        status: "CANCELLED",
        closeReason: "TTL_EXPIRED",
      });
      await this.redisService.delete(QUEUED_KEY(doc.symbol));
      this.logger.log(
        `[SignalQueue] Expired QUEUED signal for ${doc.symbol} (id: ${doc._id})`,
      );
    }

    return expired.length;
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

  async getAllActiveSignals(): Promise<AiSignalDocument[]> {
    return this.aiSignalModel.find({ status: "ACTIVE" });
  }

  async getAllQueuedSignals(): Promise<AiSignalDocument[]> {
    return this.aiSignalModel.find({ status: "QUEUED" });
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
    const stopLossPercent = params.stopLossPercent;
    const entryPrice = signalResult.entryPrice;

    const stopLossPrice = signalResult.isLong
      ? entryPrice * (1 - stopLossPercent / 100)
      : entryPrice * (1 + stopLossPercent / 100);

    const profile = params.timeframeProfile || "INTRADAY";
    const ttl =
      status === "QUEUED" ? getQueuedTtl(profile) : getActiveTtl(profile);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

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
