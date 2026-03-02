import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
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
        `/ai settings — Xem cài đặt của bạn\n` +
        `/ai moneyflow on|off — Bật/tắt cảnh báo dòng tiền\n` +
        `/ai push on|off — Auto push signals mỗi 10 phút\n` +
        `/ai market — Phân tích thị trường AI\n` +
        `/ai signals — Xem tất cả tín hiệu đang chạy\n` +
        `/ai status — Trạng thái hệ thống\n` +
        `/ai check \\<SYMBOL\\> — Kiểm tra tín hiệu coin\n`;
      if (isAdmin) {
        text +=
          `\n*Admin:*\n` +
          `/ai stats — Thống kê hiệu suất theo chiến lược\n` +
          `/ai params \\<SYMBOL\\> — Xem tham số AI của coin\n` +
          `/ai snapshot — Tạo/cập nhật daily snapshot\n` +
          `/ai test on|off — Bật/tắt chế độ test\n` +
          `/ai pause — Tạm dừng sinh tín hiệu\n` +
          `/ai resume — Tiếp tục sinh tín hiệu`;
      }
      await this.telegramService.sendTelegramMessage(chatId, text);
    });

    // /ai subscribe — any user can subscribe (also handles /ai_subscribe from menu)
    this.telegramService.registerBotCommand(/^\/ai[_ ]subscribe/, async (msg) => {
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

    // /ai unsubscribe — any user can unsubscribe (also handles /ai_unsubscribe from menu)
    this.telegramService.registerBotCommand(/^\/ai[_ ]unsubscribe/, async (msg) => {
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

    // /ai moneyflow on|off — toggle money flow alerts (also handles /ai_moneyflow)
    this.telegramService.registerBotCommand(/^\/ai[_ ]moneyflow(?:\s+(on|off))?$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const match = msg.text?.match(/^\/ai[_ ]moneyflow(?:\s+(on|off))?$/i);
      const toggle = match?.[1]?.toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `ℹ️ Ban chua đăng ký. Dùng /ai subscribe trước.`,
          );
          return;
        }

        if (!toggle) {
          // Show current status
          const enabled = (sub as any).moneyFlowEnabled !== false;
          await this.telegramService.sendTelegramMessage(
            chatId,
            `🚨 *Cảnh Báo Dòng Tiền*\n\n` +
            `Trạng thái: ${enabled ? "✅ Đang bật" : "❌ Đang tắt"}\n\n` +
            `Dùng /ai moneyflow on để bật\n` +
            `Dùng /ai moneyflow off để tắt`,
          );
          return;
        }

        const enabled = toggle === "on";
        await this.subscriptionService.toggleMoneyFlow(telegramId, enabled);
        await this.telegramService.sendTelegramMessage(
          chatId,
          enabled
            ? `✅ *Đã bật cảnh báo dòng tiền.*\n\nBạn sẽ nhận thông báo khi có biến động lớn.`
            : `✅ *Đã tắt cảnh báo dòng tiền.*\n\nBạn sẽ không nhận thông báo dòng tiền nữa.\nDùng /ai moneyflow on để bật lại.`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai settings — show user's current settings (also handles /ai_settings)
    this.telegramService.registerBotCommand(/^\/ai[_ ]settings$/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `⚙️ *Cài đặt của bạn*\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `📬 Đăng ký tín hiệu: ❌ Chưa đăng ký\n\n` +
            `Dùng /ai subscribe để bắt đầu nhận tín hiệu AI.`,
          );
          return;
        }

        const moneyFlow = (sub as any).moneyFlowEnabled !== false;
        const pushEnabled = (sub as any).signalsPushEnabled === true;
        const subscribedAt = sub.subscribedAt
          ? new Date(sub.subscribedAt).toLocaleDateString("vi-VN")
          : "N/A";

        await this.telegramService.sendTelegramMessage(
          chatId,
          `⚙️ *Cài đặt của bạn*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `📬 Đăng ký tín hiệu: ✅ Đang hoạt động\n` +
          `🚨 Cảnh báo dòng tiền: ${moneyFlow ? "✅ Bật" : "❌ Tắt"}\n` +
          `📡 Auto push signals: ${pushEnabled ? "✅ Bật (10 phút)" : "❌ Tắt"}\n` +
          `📅 Ngày đăng ký: ${subscribedAt}\n\n` +
          `*Thay đổi cài đặt:*\n` +
          `/ai moneyflow ${moneyFlow ? "off" : "on"} — ${moneyFlow ? "Tắt" : "Bật"} cảnh báo dòng tiền\n` +
          `/ai push ${pushEnabled ? "off" : "on"} — ${pushEnabled ? "Tắt" : "Bật"} auto push signals\n` +
          `/ai unsubscribe — Hủy đăng ký tất cả`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai market — AI market overview (available to all users, also handles /ai_market)
    this.telegramService.registerBotCommand(/^\/ai[_ ]market/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.telegramService.sendTelegramMessage(
          chatId,
          "🔄 _Đang phân tích thị trường..._",
        );
        const overview = await this.aiSignalService.generateMarketOverview();
        await this.telegramService.sendTelegramMessage(chatId, overview);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(
          chatId,
          `❌ Lỗi phân tích thị trường: ${err?.message}`,
        );
      }
    });

    // /ai snapshot — admin: generate/regenerate daily snapshot (also handles /ai_snapshot)
    this.telegramService.registerBotCommand(/^\/ai[_ ]snapshot/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      try {
        await this.telegramService.sendTelegramMessage(
          chatId,
          "🔄 _Đang tạo daily snapshot..._",
        );
        await this.aiSignalService.generateDailySnapshot(true);
        await this.telegramService.sendTelegramMessage(
          chatId,
          "✅ *Daily snapshot đã được tạo/cập nhật thành công!*",
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(
          chatId,
          `❌ Lỗi tạo snapshot: ${err?.message}`,
        );
      }
    });

    // /ai signals — view all active + queued signals (available to all subscribers)
    this.telegramService.registerBotCommand(/^\/ai[_ ]signals/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const text = await this.formatSignalsMessage();
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai push on|off — toggle auto-push signals every 10 min (also handles /ai_push)
    this.telegramService.registerBotCommand(/^\/ai[_ ]push(?:\s+(on|off))?$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const match = msg.text?.match(/^\/ai[_ ]push(?:\s+(on|off))?$/i);
      const toggle = match?.[1]?.toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `ℹ️ Ban chua đăng ký. Dùng /ai subscribe trước.`,
          );
          return;
        }

        if (!toggle) {
          const enabled = (sub as any).signalsPushEnabled === true;
          await this.telegramService.sendTelegramMessage(
            chatId,
            `📡 *Auto Push Signals*\n\n` +
            `Trạng thái: ${enabled ? "✅ Đang bật" : "❌ Đang tắt"}\n` +
            `Tần suất: mỗi 10 phút\n\n` +
            `Dùng /ai push on để bật\n` +
            `Dùng /ai push off để tắt`,
          );
          return;
        }

        const enabled = toggle === "on";
        await this.subscriptionService.toggleSignalsPush(telegramId, enabled);
        await this.telegramService.sendTelegramMessage(
          chatId,
          enabled
            ? `✅ *Đã bật auto push signals.*\n\nBạn sẽ nhận cập nhật tín hiệu mỗi 10 phút.`
            : `✅ *Đã tắt auto push signals.*\n\nDùng /ai push on để bật lại.`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai status (also handles /ai_status from menu)
    this.telegramService.registerBotCommand(/^\/ai[_ ]status/, async (msg) => {
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
          const healthResults = await Promise.allSettled(
            actives.map((s) => this.statsService.checkSignalHealth(s.symbol)),
          );
          text += `📈 *Active (${actives.length}):*\n`;
          for (let i = 0; i < actives.length; i++) {
            const s = actives[i];
            const health = healthResults[i].status === "fulfilled"
              ? (healthResults[i] as PromiseFulfilledResult<any>).value
              : null;
            const pnl = health
              ? (health.unrealizedPnl >= 0 ? "+" : "") + health.unrealizedPnl.toFixed(2) + "%"
              : "N/A";
            const pnlIcon = health ? (health.unrealizedPnl >= 0 ? "📗" : "📕") : "";
            const testTag = s.isTestMode ? " 🧪" : "";
            text += `  ${pnlIcon} ${s.symbol} ${s.direction} → *${pnl}*${testTag}\n`;
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

    // /ai stats [days] (also handles /ai_stats)
    this.telegramService.registerBotCommand(/^\/ai[_ ]stats(.*)/, async (msg, match) => {
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

    // /ai check <SYMBOL> (also handles /ai_check)
    this.telegramService.registerBotCommand(/^\/ai[_ ]check\s+(\S+)/, async (msg, match) => {
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

    // /ai params <SYMBOL> (also handles /ai_params)
    this.telegramService.registerBotCommand(/^\/ai[_ ]params\s+(\S+)/, async (msg, match) => {
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

    // /ai test on|off (also handles /ai_test)
    this.telegramService.registerBotCommand(/^\/ai[_ ]test\s*(on|off)?/, async (msg, match) => {
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

    // /ai pause (also handles /ai_pause)
    this.telegramService.registerBotCommand(/^\/ai[_ ]pause/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      await this.aiSignalService.pause();
      await this.telegramService.sendTelegramMessage(
        chatId,
        "⏸ *AI Signal đã TẠM DỪNG*\nKhông sinh tín hiệu mới. Lệnh đang chạy không bị ảnh hưởng.",
      );
    });

    // /ai resume (also handles /ai_resume)
    this.telegramService.registerBotCommand(/^\/ai[_ ]resume/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      await this.aiSignalService.resume();
      await this.telegramService.sendTelegramMessage(
        chatId,
        "▶️ *AI Signal đã TIẾP TỤC*\nHệ thống sẽ bắt đầu sinh tín hiệu ở chu kỳ tiếp theo.",
      );
    });

    // /ai override <SYMBOL> <STRATEGY> (also handles /ai_override)
    this.telegramService.registerBotCommand(
      /^\/ai[_ ]override\s+(\S+)\s+(\S+)/,
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

  private pushRunning = false;

  @Cron("0 */10 * * * *") // every 10 min at :00 second
  async pushSignalsToSubscribers() {
    if (this.pushRunning) return;
    this.pushRunning = true;
    try {
      const subscribers = await this.subscriptionService.findSignalsPushSubscribers();
      if (subscribers.length === 0) return;

      const text = await this.formatSignalsMessage();
      // Skip push if no active signals (don't spam empty messages)
      if (text.includes("Không có tín hiệu")) return;

      for (const sub of subscribers) {
        await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
      }
      this.logger.log(`[AiCommand] Signals push sent to ${subscribers.length} subscribers`);
    } catch (err) {
      this.logger.warn(`[AiCommand] pushSignalsToSubscribers error: ${err?.message}`);
    } finally {
      this.pushRunning = false;
    }
  }

  /**
   * Format all active + queued signals into a readable message.
   * Reused by /ai signals command and auto-push cron.
   */
  async formatSignalsMessage(): Promise<string> {
    const rawActives = await this.signalQueueService.getAllActiveSignals();
    const queued = await this.signalQueueService.getAllQueuedSignals();

    // Deduplicate by symbol (keep earliest executedAt)
    const seenSymbols = new Map<string, typeof rawActives[0]>();
    for (const s of rawActives) {
      const existing = seenSymbols.get(s.symbol);
      if (!existing || (s.executedAt && existing.executedAt && s.executedAt < existing.executedAt)) {
        seenSymbols.set(s.symbol, s);
      }
    }
    const actives = Array.from(seenSymbols.values());

    if (actives.length === 0 && queued.length === 0) {
      return `📊 *AI Signals*\n━━━━━━━━━━━━━━━━━━\n\n_Không có tín hiệu nào đang chạy._`;
    }

    const fmtPrice = (p: number) =>
      p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
      p >= 1 ? `$${p.toFixed(2)}` :
      p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

    let text = `📊 *AI Signals* (${actives.length} active`;
    if (queued.length > 0) text += `, ${queued.length} queued`;
    text += `)\n━━━━━━━━━━━━━━━━━━\n`;

    if (actives.length > 0) {
      const healthResults = await Promise.allSettled(
        actives.map((s) => this.statsService.checkSignalHealth(s.symbol)),
      );

      // Compute summary
      let totalPnl = 0;
      let winning = 0;
      let losing = 0;
      let healthCount = 0;
      for (let i = 0; i < actives.length; i++) {
        const health = healthResults[i].status === "fulfilled"
          ? (healthResults[i] as PromiseFulfilledResult<any>).value
          : null;
        if (health) {
          totalPnl += health.unrealizedPnl;
          healthCount++;
          if (health.unrealizedPnl >= 0) winning++;
          else losing++;
        }
      }

      if (healthCount > 0) {
        const avgPnl = totalPnl / healthCount;
        const totalIcon = totalPnl >= 0 ? "📗" : "📕";
        const totalSign = totalPnl >= 0 ? "+" : "";
        text += `\n${totalIcon} Tong PnL: *${totalSign}${totalPnl.toFixed(2)}%* (avg ${totalSign}${avgPnl.toFixed(2)}%)`;
        text += ` · ✅ ${winning} 🟢  ❌ ${losing} 🔴\n`;
      }

      for (let i = 0; i < actives.length; i++) {
        const s = actives[i];
        const health = healthResults[i].status === "fulfilled"
          ? (healthResults[i] as PromiseFulfilledResult<any>).value
          : null;
        const dirIcon = s.direction === "LONG" ? "🟢" : "🔴";
        const held = s.executedAt ? Math.floor((Date.now() - s.executedAt.getTime()) / 3600000) : 0;
        const heldStr = held >= 24 ? `${Math.floor(held / 24)}d${held % 24}h` : `${held}h`;

        text += `\n┌ ${dirIcon} *${s.symbol}* ${s.direction} · ${heldStr}\n`;

        if (health) {
          const pnl = health.unrealizedPnl;
          const pnlIcon = pnl >= 0 ? "📗" : "📕";
          const pnlSign = pnl >= 0 ? "+" : "";
          const distToTp = s.direction === "LONG"
            ? ((s.takeProfitPrice - health.currentPrice) / health.currentPrice) * 100
            : ((health.currentPrice - s.takeProfitPrice) / health.currentPrice) * 100;
          const distToSl = s.direction === "LONG"
            ? ((health.currentPrice - s.stopLossPrice) / health.currentPrice) * 100
            : ((s.stopLossPrice - health.currentPrice) / health.currentPrice) * 100;

          text += `│ ${pnlIcon} *${pnlSign}${pnl.toFixed(2)}%* · Now ${fmtPrice(health.currentPrice)}\n`;
          text += `│ Entry  ${fmtPrice(s.entryPrice)}\n`;
          text += `│ TP     ${fmtPrice(s.takeProfitPrice)} _(${distToTp.toFixed(1)}% away)_\n`;
          text += `│ SL     ${fmtPrice(s.stopLossPrice)} _(${distToSl.toFixed(1)}% away)_\n`;
        } else {
          text += `│ Entry  ${fmtPrice(s.entryPrice)}\n`;
          text += `│ TP     ${fmtPrice(s.takeProfitPrice)}\n`;
          text += `│ SL     ${fmtPrice(s.stopLossPrice)}\n`;
        }
        text += `└─────────────────\n`;
      }
    }

    if (queued.length > 0) {
      text += `\n⏳ *Queued (${queued.length})*\n`;
      for (const s of queued) {
        const dirIcon = s.direction === "LONG" ? "🟢" : "🔴";
        const hoursLeft = Math.max(0, (s.expiresAt.getTime() - Date.now()) / 3600000);
        text += `${dirIcon} *${s.symbol}* ${s.direction} · ${fmtPrice(s.entryPrice)} · _${hoursLeft.toFixed(1)}h left_\n`;
      }
    }

    text += `━━━━━━━━━━━━━━━━━━\n`;
    text += `_${new Date().toLocaleTimeString("vi-VN")}_`;

    return text;
  }

  private isAdmin(telegramId?: number): boolean {
    if (!telegramId) return false;
    if (this.adminIds.length === 0) return true; // no admin restriction configured
    return this.adminIds.includes(telegramId);
  }
}
