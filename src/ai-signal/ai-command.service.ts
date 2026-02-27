import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TelegramBotService } from "../telegram/telegram.service";
import { AiSignalService } from "./ai-signal.service";
import { AiSignalStatsService } from "./ai-signal-stats.service";
import { SignalQueueService } from "./signal-queue.service";
import { UserSignalSubscriptionService } from "./user-signal-subscription.service";

@Injectable()
export class AiCommandService implements OnModuleInit {
  private readonly logger = new Logger(AiCommandService.name);
  private readonly adminIds: number[];

  constructor(
    private readonly telegramService: TelegramBotService,
    private readonly aiSignalService: AiSignalService,
    private readonly statsService: AiSignalStatsService,
    private readonly signalQueueService: SignalQueueService,
    private readonly subscriptionService: UserSignalSubscriptionService,
    private readonly configService: ConfigService,
  ) {
    const adminIdStr = this.configService.get<string>("AI_ADMIN_TELEGRAM_ID", "");
    this.adminIds = adminIdStr
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));
  }

  async onModuleInit() {
    // Small delay to ensure TelegramBotService has initialized its bot
    setTimeout(() => this.registerCommands(), 3000);
  }

  private registerCommands() {
    // /ai — show subcommand help
    this.telegramService.registerBotCommand(/^\/ai$/, async (msg) => {
      const chatId = msg.chat.id;
      const isAdmin = this.isAdmin(msg.from?.id);
      let text =
        `🤖 *AI Signal Commands*\n\n` +
        `/ai subscribe — Đăng ký nhận tín hiệu AI\n` +
        `/ai unsubscribe — Hủy đăng ký tín hiệu AI\n` +
        `/ai status — Trạng thái tín hiệu hiện tại\n` +
        `/ai check \\<SYMBOL\\> — Kiểm tra tín hiệu đang chạy\n`;
      if (isAdmin) {
        text +=
          `\n*Admin:*\n` +
          `/ai stats — Thống kê hiệu suất theo chiến lược\n` +
          `/ai params \\<SYMBOL\\> — Xem tham số AI của coin\n` +
          `/ai test on|off — Bật/tắt chế độ test\n` +
          `/ai pause — Tạm dừng sinh tín hiệu\n` +
          `/ai resume — Tiếp tục sinh tín hiệu`;
      }
      await this.telegramService.sendTelegramMessage(chatId, text);
    });

    // /ai subscribe — any user can subscribe
    this.telegramService.registerBotCommand(/^\/ai subscribe/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const subscribed = await this.subscriptionService.subscribe(
          telegramId,
          chatId,
          msg.from?.username,
        );
        if (subscribed) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `✅ *Đăng ký thành công!*\n\nBạn sẽ nhận được thông báo khi có tín hiệu AI mới.\nDùng /ai unsubscribe để hủy bất cứ lúc nào.`,
          );
        } else {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `ℹ️ Bạn đã đăng ký nhận tín hiệu AI rồi.\nDùng /ai unsubscribe để hủy.`,
          );
        }
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai unsubscribe — any user can unsubscribe
    this.telegramService.registerBotCommand(/^\/ai unsubscribe/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const unsubscribed = await this.subscriptionService.unsubscribe(telegramId);
        if (unsubscribed) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `✅ *Hủy đăng ký thành công.*\n\nBạn sẽ không còn nhận tín hiệu AI.\nDùng /ai subscribe để đăng ký lại.`,
          );
        } else {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `ℹ️ Bạn chưa đăng ký nhận tín hiệu AI.`,
          );
        }
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai status
    this.telegramService.registerBotCommand(/^\/ai status/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      try {
        const status = await this.aiSignalService.getStatus();
        const actives = await this.signalQueueService.getAllActiveSignals();
        const queued = await this.signalQueueService.getAllQueuedSignals();
        const isTestMode = await this.aiSignalService.isTestModeEnabled();
        const subscriberCount = await this.subscriptionService.countActive();

        let text = `🤖 *AI Signal Status*\n\n`;
        text += `Trạng thái: ${status.paused ? "⏸ TẠM DỪNG" : isTestMode ? "🧪 TEST MODE" : "✅ ĐANG CHẠY"}\n`;
        text += `Regime: *${status.globalRegime}*\n`;
        text += `Người đăng ký: *${subscriberCount}* users\n`;
        text += `Coins theo dõi: ${status.shortlist.join(", ") || "_(trống)_"}\n\n`;

        if (actives.length > 0) {
          text += `📈 *Active (${actives.length}):*\n`;
          for (const s of actives) {
            const health = await this.statsService.checkSignalHealth(s.symbol);
            const pnl = health
              ? (health.unrealizedPnl >= 0 ? "+" : "") + health.unrealizedPnl.toFixed(2) + "%"
              : "N/A";
            const testTag = s.isTestMode ? " `[T]`" : "";
            text += `  ${s.direction === "LONG" ? "📈" : "📉"} ${s.symbol} ${s.direction} $${s.entryPrice.toLocaleString()} → ${pnl}${testTag}\n`;
          }
          text += "\n";
        } else {
          text += `_Không có tín hiệu active._\n\n`;
        }

        if (queued.length > 0) {
          text += `⏳ *Queued (${queued.length}):*\n`;
          for (const s of queued) {
            const hoursLeft = Math.max(
              0,
              (s.expiresAt.getTime() - Date.now()) / 3600000,
            );
            const testTag = s.isTestMode ? " `[T]`" : "";
            text += `  ${s.direction === "LONG" ? "📈" : "📉"} ${s.symbol} ${s.direction} $${s.entryPrice.toLocaleString()} (còn ${hoursLeft.toFixed(1)}h)${testTag}\n`;
          }
        } else {
          text += `_Không có tín hiệu queued._`;
        }

        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai stats [days]
    this.telegramService.registerBotCommand(/^\/ai stats(.*)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      try {
        const daysStr = (match?.[1] || "").trim();
        const days = daysStr ? parseInt(daysStr) : 30;
        const stats = await this.statsService.getStats(isNaN(days) ? 30 : days);
        const text = this.statsService.formatStatsMessage(stats, isNaN(days) ? 30 : days);
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai check <SYMBOL>
    this.telegramService.registerBotCommand(/^\/ai check\s+(\S+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      const symbol = match?.[1]?.toUpperCase();
      if (!symbol) {
        await this.telegramService.sendTelegramMessage(chatId, "❌ Cần nhập symbol. VD: `/ai check BTCUSDT`");
        return;
      }

      try {
        const health = await this.statsService.checkSignalHealth(symbol);
        if (!health) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `⚠️ Không có tín hiệu active/queued cho *${symbol}*`,
          );
          return;
        }
        const text = this.statsService.formatHealthMessage(health);
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai params <SYMBOL>
    this.telegramService.registerBotCommand(/^\/ai params\s+(\S+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      const symbol = match?.[1]?.toUpperCase();
      if (!symbol) {
        await this.telegramService.sendTelegramMessage(chatId, "❌ Cần nhập symbol. VD: `/ai params BTCUSDT`");
        return;
      }

      try {
        const coin = symbol.replace("USDT", "");
        const params = await this.aiSignalService.getParamsForSymbol(coin, "usdt");
        if (!params) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `⚠️ Chưa có AI params cho *${symbol}*. Chờ cron tiếp theo (tối đa 1h).`,
          );
          return;
        }
        const text =
          `🧠 *AI Params: ${symbol}*\n\n` +
          `├ Strategy: *${params.strategy}*\n` +
          `├ Regime: *${params.regime}*\n` +
          `├ Confidence: *${params.confidence}%*\n` +
          `├ Stop Loss: *${params.stopLossPercent}%*\n` +
          `└ Min Confidence to Trade: *${params.minConfidenceToTrade}%*`;
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai test on|off
    this.telegramService.registerBotCommand(/^\/ai test\s*(on|off)?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      const arg = match?.[1]?.toLowerCase();
      if (!arg) {
        const current = await this.aiSignalService.isTestModeEnabled();
        await this.telegramService.sendTelegramMessage(
          chatId,
          `🧪 Test mode hiện tại: ${current ? "*BẬT*" : "*TẮT*"}\n\nDùng: \`/ai test on\` hoặc \`/ai test off\``,
        );
        return;
      }

      if (arg === "on") {
        await this.aiSignalService.enableTestMode();
        await this.telegramService.sendTelegramMessage(
          chatId,
          `🧪 *Test mode đã BẬT*\nTín hiệu sẽ được tạo nhưng KHÔNG đặt lệnh thật.\nDữ liệu sẽ lưu vào MongoDB với nhãn \\[TEST\\].`,
        );
      } else {
        await this.aiSignalService.disableTestMode();
        await this.telegramService.sendTelegramMessage(
          chatId,
          `✅ *Test mode đã TẮT*\nTín hiệu mới sẽ được thực thi thật.`,
        );
      }
    });

    // /ai pause
    this.telegramService.registerBotCommand(/^\/ai pause/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      await this.aiSignalService.pause();
      await this.telegramService.sendTelegramMessage(
        chatId,
        "⏸ *AI Signal đã TẠM DỪNG*\nKhông sinh tín hiệu mới. Lệnh đang chạy không bị ảnh hưởng.",
      );
    });

    // /ai resume
    this.telegramService.registerBotCommand(/^\/ai resume/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      await this.aiSignalService.resume();
      await this.telegramService.sendTelegramMessage(
        chatId,
        "▶️ *AI Signal đã TIẾP TỤC*\nHệ thống sẽ bắt đầu sinh tín hiệu ở chu kỳ tiếp theo.",
      );
    });

    // /ai override <SYMBOL> <STRATEGY>
    this.telegramService.registerBotCommand(
      /^\/ai override\s+(\S+)\s+(\S+)/,
      async (msg, match) => {
        const chatId = msg.chat.id;
        if (!this.isAdmin(msg.from?.id)) return;

        const symbol = match?.[1]?.toUpperCase();
        const strategy = match?.[2]?.toUpperCase();
        const validStrategies = ["RSI_CROSS", "RSI_ZONE", "TREND_EMA", "MEAN_REVERT_RSI", "STOCH_BB_PATTERN", "STOCH_EMA_KDJ"];

        if (!symbol || !strategy || !validStrategies.includes(strategy)) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `❌ Dùng: \`/ai override BTCUSDT RSI_CROSS\`\n\nStrategies hợp lệ:\n${validStrategies.join(", ")}`,
          );
          return;
        }

        const coin = symbol.replace("USDT", "");
        await this.aiSignalService.overrideStrategy(coin, "usdt", strategy);
        await this.telegramService.sendTelegramMessage(
          chatId,
          `✅ *Override đã áp dụng*\n${symbol} → *${strategy}* (có hiệu lực tới khi AI tune lại, tối đa 4h)`,
        );
      },
    );

    this.logger.log("[AiCommand] /ai commands registered");
  }

  private isAdmin(telegramId?: number): boolean {
    if (!telegramId) return false;
    if (this.adminIds.length === 0) return true; // no admin restriction configured
    return this.adminIds.includes(telegramId);
  }
}
