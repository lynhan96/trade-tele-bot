import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";
import { BinanceService } from "../binance/binance.service";
import { SignalQueueService } from "./signal-queue.service";

export interface ResolvedSignalInfo {
  symbol: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  queuedSignalActivated: boolean;
}

const MONITOR_POSITIONS_KEY = "cache:ai:monitor:positions";
const MONITOR_POSITIONS_TTL = 60; // 60s

@Injectable()
export class PositionMonitorService {
  private readonly logger = new Logger(PositionMonitorService.name);

  private monitorApiKey: string;
  private monitorApiSecret: string;
  private isConfigured = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly binanceService: BinanceService,
    private readonly signalQueueService: SignalQueueService,
  ) {
    this.monitorApiKey = configService.get<string>("AI_MONITOR_BINANCE_API_KEY", "");
    this.monitorApiSecret = configService.get<string>("AI_MONITOR_BINANCE_API_SECRET", "");
    this.isConfigured = !!(this.monitorApiKey && this.monitorApiSecret);

    if (!this.isConfigured) {
      this.logger.warn(
        "[PositionMonitor] AI_MONITOR_BINANCE_API_KEY/SECRET not set — position monitoring disabled",
      );
    }
  }

  /**
   * Check for closed positions and resolve/activate queued signals.
   * Called every 30 seconds by AiSignalService.
   */
  async checkAndResolve(): Promise<ResolvedSignalInfo[]> {
    if (!this.isConfigured) return [];

    const resolved: ResolvedSignalInfo[] = [];

    try {
      const activeSignals = await this.signalQueueService.getAllActiveSignals();
      if (activeSignals.length === 0) return [];

      // Get current open positions for monitor account
      const openPositions = await this.getOpenPositionSymbols();

      for (const signal of activeSignals) {
        const symbol = signal.symbol;

        // If position for this symbol is no longer open → it closed
        if (openPositions.has(symbol)) continue;

        // Get current price to record exit
        const exitPrice = await this.getCurrentPrice(symbol);
        if (!exitPrice || exitPrice <= 0) {
          this.logger.warn(`[PositionMonitor] ${symbol} price fetch returned 0 — skipping resolution`);
          continue;
        }

        // Resolve the active signal
        await this.signalQueueService.resolveActiveSignal(symbol, exitPrice, "POSITION_CLOSED");

        // Try to activate queued signal
        const queuedSignal = await this.signalQueueService.activateQueuedSignal(symbol);
        const queuedActivated = !!queuedSignal;

        const pnlPercent =
          signal.direction === "LONG"
            ? ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100
            : ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;

        resolved.push({
          symbol,
          direction: signal.direction,
          entryPrice: signal.entryPrice,
          exitPrice,
          pnlPercent,
          queuedSignalActivated: queuedActivated,
        });

        if (queuedActivated) {
          this.logger.log(
            `[PositionMonitor] ${symbol} position closed — queued signal now ACTIVE`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[PositionMonitor] checkAndResolve error: ${err?.message}`);
    }

    return resolved;
  }

  // ─── Private: fetch open positions ───────────────────────────────────────

  private async getOpenPositionSymbols(): Promise<Set<string>> {
    try {
      const positions = await this.binanceService.getOpenPositions(
        this.monitorApiKey,
        this.monitorApiSecret,
      );
      return new Set(positions.map((p) => p.symbol));
    } catch (err) {
      this.logger.warn(`[PositionMonitor] Failed to fetch positions: ${err?.message}`);
      // Return all symbols as "open" to avoid false positives
      const activeSignals = await this.signalQueueService.getAllActiveSignals();
      return new Set(activeSignals.map((s) => s.symbol));
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const axios = require("axios");
      const res = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
        { timeout: 5000 },
      );
      return parseFloat(res.data.price);
    } catch {
      return 0;
    }
  }
}
