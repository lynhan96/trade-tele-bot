import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { TelegramBotService } from "../telegram/telegram.service";
import { AiSignalService } from "./ai-signal.service";
import { AiSignalStatsService } from "./ai-signal-stats.service";
import { SignalQueueService } from "./signal-queue.service";
import { SubscriberInfo, UserSignalSubscriptionService } from "./user-signal-subscription.service";
import { UserSettingsService } from "../user/user-settings.service";
import { UserRealTradingService } from "./user-real-trading.service";
import { UserDataStreamService } from "./user-data-stream.service";

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
    private readonly userSettingsService: UserSettingsService,
    private readonly userRealTradingService: UserRealTradingService,
    private readonly userDataStreamService: UserDataStreamService,
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
        `/ai balance <so> — Set balance mac dinh (USDT/lenh)\n` +
        `/ai vol <COIN> <so> — Set vol rieng cho tung coin\n` +
        `/ai tpsl <tp%> <sl%> — Set TP/SL tuy chinh\n` +
        `/ai tpsl off — Dung TP/SL tu AI\n` +
        `/ai setkeys <key> <secret> — Luu Binance API keys\n` +
        `/ai realmode — Xem/bat/tat che do dat lenh that\n` +
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
          const enabled = sub.moneyFlowEnabled !== false;
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

        const moneyFlow = sub.moneyFlowEnabled !== false;
        const pushEnabled = sub.signalsPushEnabled === true;
        const subscribedAt = sub.subscribedAt
          ? new Date(sub.subscribedAt).toLocaleDateString("vi-VN")
          : "N/A";
        const balance = sub.tradingBalance ?? 1000;
        const coinVols = sub.coinVolumes ?? {};
        const coinVolLines = Object.entries(coinVols).map(([c, v]) => `  • ${c}: ${v.toLocaleString()} USDT`).join("\n");
        const customTp = sub.customTpPct;
        const customSl = sub.customSlPct;
        const tpSlLine = (customTp && customSl)
          ? `TP ${customTp}% / SL ${customSl}% _(tuy chinh)_`
          : "_Dung TP/SL tu AI_";

        const realMode = sub.realModeEnabled === true;
        const leverageMode = sub.realModeLeverageMode ?? "AI";
        const leverageLabel =
          leverageMode === "FIXED" ? `Fixed ${sub.realModeLeverage ?? "?"}x` :
          leverageMode === "MAX" ? "Max (Binance)" : "AI Signal";
        const hasKeys = !!(await this.userSettingsService.getApiKeys(telegramId, "binance"));
        const openTrades = realMode ? await this.userRealTradingService.getOpenTrades(telegramId) : [];

        await this.telegramService.sendTelegramMessage(
          chatId,
          `⚙️ *Cài đặt của bạn*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `📬 Đăng ký tín hiệu: ✅ Đang hoạt động\n` +
          `🚨 Cảnh báo dòng tiền: ${moneyFlow ? "✅ Bật" : "❌ Tắt"}\n` +
          `📡 Auto push signals: ${pushEnabled ? "✅ Bật (10 phút)" : "❌ Tắt"}\n` +
          `📅 Ngày đăng ký: ${subscribedAt}\n\n` +
          `*Cai dat vol:*\n` +
          `💰 Balance mac dinh: *${balance.toLocaleString()} USDT/lenh*\n` +
          (coinVolLines ? `${coinVolLines}\n` : `  _Chua co override coin nao_\n`) +
          `📐 TP/SL: ${tpSlLine}\n\n` +
          `*Real Trading Mode:*\n` +
          `🔑 Binance API Keys: ${hasKeys ? "✅ Da luu" : "❌ Chua luu"}\n` +
          `⚡ Real Mode: ${realMode ? "✅ BẬT" : "❌ TẮT"}\n` +
          (realMode ? `📊 Leverage: *${leverageLabel}*\n` : "") +
          (realMode && openTrades.length > 0 ? `📈 Lenh mo: *${openTrades.length}*\n` : "") +
          `\n*Thay đổi cài đặt:*\n` +
          `/ai moneyflow ${moneyFlow ? "off" : "on"} — ${moneyFlow ? "Tắt" : "Bật"} cảnh báo dòng tiền\n` +
          `/ai push ${pushEnabled ? "off" : "on"} — ${pushEnabled ? "Tắt" : "Bật"} auto push signals\n` +
          `/ai balance <so> — Doi balance mac dinh\n` +
          `/ai vol BTC 5000 — Set vol BTC rieng\n` +
          `/ai tpsl 2.5 1.5 — Set TP/SL tuy chinh\n` +
          `/ai setkeys <key> <secret> — Luu Binance API keys\n` +
          `/ai realmode on|off — Bat/tat real mode\n` +
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

    // /ai signals — view all active + queued signals (personalized with user's balance)
    this.telegramService.registerBotCommand(/^\/ai[_ ]signals/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;

      try {
        const sub = telegramId ? await this.subscriptionService.getSubscription(telegramId) : null;
        const text = await this.formatSignalsMessage({
          tradingBalance: sub?.tradingBalance,
          coinVolumes: sub?.coinVolumes,
          customTpPct: sub?.customTpPct,
          customSlPct: sub?.customSlPct,
        });
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai balance <amount> — set per-user trading balance for USDT PnL display
    this.telegramService.registerBotCommand(/^\/ai[_ ]balance(?:\s+(\d+(?:\.\d+)?))?$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const match = msg.text?.match(/^\/ai[_ ]balance(?:\s+(\d+(?:\.\d+)?))?$/i);
      const amountStr = match?.[1];

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua subscribe. Dung /ai subscribe truoc.`);
          return;
        }

        if (!amountStr) {
          const cur = sub.tradingBalance ?? 1000;
          await this.telegramService.sendTelegramMessage(chatId,
            `💰 *Trading Balance cua ban*\n━━━━━━━━━━━━━━━━━━\n\nSo du hien tai: *${cur.toLocaleString()} USDT/lenh*\n\nDung: /ai balance <so tien>\nVi du: /ai balance 500`
          );
          return;
        }

        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount < 10 || amount > 1_000_000) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ So du phai tu 10 den 1,000,000 USDT`);
          return;
        }

        await this.subscriptionService.setTradingBalance(telegramId, amount);
        await this.telegramService.sendTelegramMessage(chatId,
          `✅ *Da cap nhat balance*\n━━━━━━━━━━━━━━━━━━\n\nTrading balance: *${amount.toLocaleString()} USDT/lenh*\n_PnL tu nay se tinh theo so du nay_`
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai target <amount|off> — set per-user profit target in USDT
    this.telegramService.registerBotCommand(/^\/ai[_ ]target(?:\s+(\S+))?$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const match = msg.text?.match(/^\/ai[_ ]target(?:\s+(\S+))?$/i);
      const arg = match?.[1]?.toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua subscribe. Dung /ai subscribe truoc.`);
          return;
        }

        if (!arg) {
          const cur = sub.profitTarget;
          const msg2 = cur
            ? `🎯 Profit target hien tai: *${cur} USDT*\n\nDung /ai target off de tat, hoac /ai target <so> de doi`
            : `🎯 Profit target: *chua dat*\n\nDung: /ai target <so USDT>\nVi du: /ai target 50 _(khi tong PnL dat +50 USDT, bot se thong bao)_`;
          await this.telegramService.sendTelegramMessage(chatId,
            `💼 *Profit Target*\n━━━━━━━━━━━━━━━━━━\n\n${msg2}`
          );
          return;
        }

        if (arg === "off") {
          await this.subscriptionService.setProfitTarget(telegramId, null);
          await this.telegramService.sendTelegramMessage(chatId,
            `✅ *Profit target da tat*\n_Bot se khong thong bao khi dat muc tieu_`
          );
          return;
        }

        const amount = parseFloat(arg);
        if (isNaN(amount) || amount <= 0) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Nhap so USDT hop le (vi du: /ai target 50)`);
          return;
        }

        await this.subscriptionService.setProfitTarget(telegramId, amount);
        const balance = sub.tradingBalance ?? 1000;
        await this.telegramService.sendTelegramMessage(chatId,
          `✅ *Profit Target da dat*\n━━━━━━━━━━━━━━━━━━\n\nMuc tieu: *+${amount} USDT*\nBalance hien tai: ${balance.toLocaleString()} USDT/lenh\n\n_Khi tong PnL mo cua dat +${amount} USDT, bot se thong bao va tu dong dong tat ca lenh_`
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai vol [COIN] [amount|off] — per-coin volume override
    this.telegramService.registerBotCommand(/^\/ai[_ ]vol(?:\s+(\S+))?(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const coin = match?.[1]?.toUpperCase();
      const amountStr = match?.[2]?.toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua subscribe. Dung /ai subscribe truoc.`);
          return;
        }

        if (!coin) {
          // Show current per-coin settings
          const vols = sub.coinVolumes ?? {};
          const base = sub.tradingBalance ?? 1000;
          const lines = Object.entries(vols).map(([c, v]) => `• ${c}: *${v.toLocaleString()} USDT*`);
          await this.telegramService.sendTelegramMessage(chatId,
            `💰 *Per-Coin Volume*\n━━━━━━━━━━━━━━━━━━\n` +
            `Mac dinh: *${base.toLocaleString()} USDT/lenh*\n\n` +
            (lines.length ? lines.join("\n") : `_Chua co override coin nao_`) +
            `\n\n*Cach dung:*\n/ai vol BTC 5000 — Set BTC vol 5000 USDT\n/ai vol BTC off — Xoa override BTC`
          );
          return;
        }

        if (amountStr === "off") {
          const ok = await this.subscriptionService.setCoinVolume(telegramId, coin, null);
          if (!ok) { await this.telegramService.sendTelegramMessage(chatId, `❌ Loi khi xoa override`); return; }
          await this.telegramService.sendTelegramMessage(chatId,
            `✅ Da xoa override *${coin}* — se dung balance mac dinh`
          );
          return;
        }

        const amount = parseFloat(amountStr ?? "");
        if (isNaN(amount) || amount < 10 || amount > 1_000_000) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ So tien khong hop le (10 – 1,000,000 USDT)\nVi du: /ai vol BTC 5000`);
          return;
        }

        await this.subscriptionService.setCoinVolume(telegramId, coin, amount);
        await this.telegramService.sendTelegramMessage(chatId,
          `✅ *${coin}* vol: *${amount.toLocaleString()} USDT/lenh*\n_PnL BTC se tinh theo so du nay_`
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
      }
    });

    // /ai tpsl [tp% sl% | off] — set custom TP/SL % for signal display
    this.telegramService.registerBotCommand(/^\/ai[_ ]tpsl(?:\s+(\S+))?(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const arg1 = match?.[1]?.toLowerCase();
      const arg2 = match?.[2];

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua subscribe. Dung /ai subscribe truoc.`);
          return;
        }

        if (!arg1) {
          const tp = sub.customTpPct;
          const sl = sub.customSlPct;
          await this.telegramService.sendTelegramMessage(chatId,
            `📐 *TP/SL Tuy Chinh*\n━━━━━━━━━━━━━━━━━━\n\n` +
            (tp && sl
              ? `TP: *${tp}%* · SL: *${sl}%*\n\nDung /ai tpsl off de dung lai TP/SL tu AI`
              : `_Dang dung TP/SL tu AI_`) +
            `\n\n*Cach dung:*\n/ai tpsl 2.5 1.5 — Set TP=2.5%, SL=1.5%\n/ai tpsl off — Dung TP/SL tu AI`
          );
          return;
        }

        if (arg1 === "off") {
          const ok = await this.subscriptionService.clearCustomTpSl(telegramId);
          if (!ok) { await this.telegramService.sendTelegramMessage(chatId, `❌ Loi`); return; }
          await this.telegramService.sendTelegramMessage(chatId,
            `✅ Da xoa TP/SL tuy chinh — se dung TP/SL tu AI`
          );
          return;
        }

        const tp = parseFloat(arg1);
        const sl = parseFloat(arg2 ?? "");
        if (isNaN(tp) || isNaN(sl) || tp <= 0 || sl <= 0 || tp > 50 || sl > 50) {
          await this.telegramService.sendTelegramMessage(chatId,
            `❌ Nhap TP% va SL% hop le (0–50)\nVi du: /ai tpsl 2.5 1.5`
          );
          return;
        }

        await this.subscriptionService.setCustomTpSl(telegramId, tp, sl);
        await this.telegramService.sendTelegramMessage(chatId,
          `✅ *TP/SL da cap nhat*\n━━━━━━━━━━━━━━━━━━\n\nTP: *+${tp}%* · SL: *-${sl}%*\n_Hien thi trong /ai signals se tinh theo TP/SL nay_`
        );
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
          const enabled = sub.signalsPushEnabled === true;
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

    // /ai setkeys <apiKey> <apiSecret> — save Binance API keys for real mode
    this.telegramService.registerBotCommand(
      /^\/ai[_ ]setkeys\s+(\S+)\s+(\S+)$/,
      async (msg, match) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        if (!telegramId) return;

        const apiKey = match?.[1];
        const apiSecret = match?.[2];
        if (!apiKey || !apiSecret) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `❌ Dung: \`/ai setkeys <apiKey> <apiSecret>\``,
          );
          return;
        }

        try {
          // Must be subscribed first
          const sub = await this.subscriptionService.getSubscription(telegramId);
          if (!sub) {
            await this.telegramService.sendTelegramMessage(
              chatId,
              `ℹ️ Ban chua dang ky. Dung /ai subscribe truoc.`,
            );
            return;
          }

          await this.userSettingsService.saveApiKeys(telegramId, chatId, "binance", apiKey, apiSecret);
          await this.telegramService.sendTelegramMessage(
            chatId,
            `✅ *Binance API Keys da duoc luu!*\n\nBat real trading voi /ai realmode on`,
          );
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
        }
      },
    );

    // /ai realmode [on|off|leverage <N|AI|MAX>] — manage real trading mode
    this.telegramService.registerBotCommand(
      /^\/ai[_ ]realmode(?:\s+(.+))?$/i,
      async (msg, match) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        if (!telegramId) return;

        const arg = (match?.[1] ?? "").trim().toLowerCase();

        try {
          const sub = await this.subscriptionService.getSubscription(telegramId);
          if (!sub) {
            await this.telegramService.sendTelegramMessage(
              chatId,
              `ℹ️ Ban chua dang ky. Dung /ai subscribe truoc.`,
            );
            return;
          }

          // No arg — show full overview
          if (!arg) {
            const realMode = sub.realModeEnabled === true;
            const leverageMode = sub.realModeLeverageMode ?? "AI";
            const leverageLabel =
              leverageMode === "FIXED" ? `Fixed ${sub.realModeLeverage ?? "?"}x` :
              leverageMode === "MAX" ? "Max (Binance)" : "AI Signal";
            const hasKeys = !!(await this.userSettingsService.getApiKeys(telegramId, "binance"));
            const dailyTarget = sub.realModeDailyTargetPct;
            const dailySl = sub.realModeDailyStopLossPct;
            const disabledAt = sub.realModeDailyDisabledAt;

            let overviewText =
              `⚡ *Real Trading Mode*\n━━━━━━━━━━━━━━━━━━\n\n` +
              `Trang thai: ${realMode ? "✅ BẬT" : "❌ TẮT"}\n` +
              `Binance API: ${hasKeys ? "✅ Da luu" : "❌ Chua luu"}\n` +
              `Leverage: *${leverageLabel}*\n`;

            if (disabledAt) {
              const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
              if (disabledAt >= startOfToday) {
                overviewText += `⚠️ Tu dong tat hom nay (se mo lai ngay mai)\n`;
              }
            }

            overviewText += `\n*Gioi han ngay:*\n`;
            overviewText += `Muc tieu loi nhuan: ${dailyTarget != null ? `*+${dailyTarget}%*` : "_chua dat_"}\n`;
            overviewText += `Gioi han lo: ${dailySl != null ? `*-${dailySl}%*` : "_chua dat_"}\n`;

            if (realMode) {
              try {
                const stats = await this.userRealTradingService.getDailyStats(telegramId);
                const sign = stats.totalPnlUsdt >= 0 ? "+" : "";
                const pnlIcon = stats.totalPnlUsdt >= 0 ? "📗" : "📕";
                overviewText += `\n*Hom nay:*\n`;
                overviewText += `${pnlIcon} PnL: *${sign}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign}${stats.dailyPnlPct.toFixed(2)}%*)\n`;
                overviewText += `Lenh mo: *${stats.openTrades.length}*, Lenh dong: *${stats.closedToday.length}*\n`;
                overviewText += `Xem chi tiet: /ai realmode stats\n`;
              } catch { /* ignore */ }
            }

            overviewText +=
              `\n*Lenh:*\n` +
              `/ai realmode on|off — Bat/tat real mode\n` +
              `/ai realmode leverage AI|MAX|10 — Dat leverage\n` +
              `/ai realmode target 5 — Dat muc tieu loi nhuan +5%\n` +
              `/ai realmode target off — Tat muc tieu\n` +
              `/ai realmode stoploss 3 — Dat gioi han lo -3%\n` +
              `/ai realmode stoploss off — Tat gioi han lo\n` +
              `/ai realmode stats — Chi tiet lenh hom nay`;
            await this.telegramService.sendTelegramMessage(chatId, overviewText);
            return;
          }

          // /ai realmode on
          if (arg === "on") {
            const hasKeys = !!(await this.userSettingsService.getApiKeys(telegramId, "binance"));
            if (!hasKeys) {
              await this.telegramService.sendTelegramMessage(
                chatId,
                `❌ Ban chua luu Binance API keys.\nDung: \`/ai setkeys <apiKey> <apiSecret>\``,
              );
              return;
            }
            await this.subscriptionService.setRealMode(telegramId, true);
            // Clear daily-disabled flag so the user gets a fresh daily counter
            await this.subscriptionService.setRealModeDailyDisabled(telegramId, null).catch(() => {});
            await this.telegramService.sendTelegramMessage(
              chatId,
              `✅ *Real Mode da bat!*\n\nBot se tu dong dat lenh that khi co tin hieu moi.\nDung /ai realmode off de tat.`,
            );
            return;
          }

          // /ai realmode off
          if (arg === "off") {
            await this.subscriptionService.setRealMode(telegramId, false);
            // Close data stream if active
            await this.userDataStreamService.unregisterUser(telegramId).catch(() => {});
            await this.telegramService.sendTelegramMessage(
              chatId,
              `✅ *Real Mode da tat.*\n\nKhong co them lenh that nao duoc dat.`,
            );
            return;
          }

          // /ai realmode target <N|off>
          if (arg.startsWith("target")) {
            const parts = arg.split(/\s+/);
            const val = parts[1] ?? "";
            if (val === "off") {
              await this.subscriptionService.setDailyTargetPct(telegramId, null);
              await this.telegramService.sendTelegramMessage(chatId, `✅ Muc tieu loi nhuan ngay da tat.`);
            } else {
              const n = parseFloat(val);
              if (isNaN(n) || n <= 0 || n > 100) {
                await this.telegramService.sendTelegramMessage(chatId,
                  `❌ Nhap % hop le (1–100).\nVD: /ai realmode target 5 — dat muc tieu +5% moi ngay`);
                return;
              }
              await this.subscriptionService.setDailyTargetPct(telegramId, n);
              await this.telegramService.sendTelegramMessage(chatId,
                `✅ *Muc Tieu Loi Nhuan Ngay: +${n}%*\n\nKhi tong PnL hom nay dat +${n}%, bot se tu dong dong tat ca lenh va tat real mode.\nSe mo lai tu dong vao ngay mai.`);
            }
            return;
          }

          // /ai realmode stoploss <N|off>
          if (arg.startsWith("stoploss")) {
            const parts = arg.split(/\s+/);
            const val = parts[1] ?? "";
            if (val === "off") {
              await this.subscriptionService.setDailyStopLossPct(telegramId, null);
              await this.telegramService.sendTelegramMessage(chatId, `✅ Gioi han lo ngay da tat.`);
            } else {
              const n = parseFloat(val);
              if (isNaN(n) || n <= 0 || n > 100) {
                await this.telegramService.sendTelegramMessage(chatId,
                  `❌ Nhap % hop le (1–100).\nVD: /ai realmode stoploss 3 — dat gioi han lo -3% moi ngay`);
                return;
              }
              await this.subscriptionService.setDailyStopLossPct(telegramId, n);
              await this.telegramService.sendTelegramMessage(chatId,
                `✅ *Gioi Han Lo Ngay: -${n}%*\n\nKhi tong PnL hom nay giam -${n}%, bot se tu dong dong tat ca lenh va tat real mode.\nSe mo lai tu dong vao ngay mai.`);
            }
            return;
          }

          // /ai realmode stats — detailed today's stats
          if (arg === "stats") {
            const fmtP = (p: number) =>
              p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
              p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
            try {
              const stats = await this.userRealTradingService.getDailyStats(telegramId);
              const sign = (v: number) => v >= 0 ? "+" : "";
              const pnlIcon = stats.totalPnlUsdt >= 0 ? "📗" : "📕";

              let text =
                `📊 *Real Mode: Thong Ke Hom Nay*\n━━━━━━━━━━━━━━━━━━\n\n` +
                `${pnlIcon} PnL: *${sign(stats.totalPnlUsdt)}${stats.totalPnlUsdt.toFixed(2)} USDT* (*${sign(stats.dailyPnlPct)}${stats.dailyPnlPct.toFixed(2)}%*)\n` +
                `Lenh mo: *${stats.openTrades.length}* · Dong hom nay: *${stats.closedToday.length}*\n`;

              if (stats.openTrades.length > 0) {
                text += `\n*Lenh Dang Mo:*\n`;
                for (const t of stats.openTrades) {
                  const icon = t.unrealizedPnlUsdt >= 0 ? "📗" : "📕";
                  const dir = t.direction === "LONG" ? "🟢" : "🔴";
                  text +=
                    `${dir} *${t.symbol}* ${t.direction} ${t.leverage}x\n` +
                    `${icon} ${sign(t.unrealizedPnlPct)}${t.unrealizedPnlPct.toFixed(2)}% (${sign(t.unrealizedPnlUsdt)}${t.unrealizedPnlUsdt.toFixed(2)} USDT)\n` +
                    `Entry: ${fmtP(t.entryPrice)} · Vol: ${t.notionalUsdt.toFixed(0)} USDT\n`;
                }
              }

              if (stats.closedToday.length > 0) {
                text += `\n*Dong Hom Nay:*\n`;
                for (const t of stats.closedToday) {
                  const icon = t.pnlUsdt >= 0 ? "✅" : "❌";
                  const reasonVi =
                    t.closeReason === "TAKE_PROFIT" ? "TP" :
                    t.closeReason === "STOP_LOSS" ? "SL" :
                    t.closeReason === "DAILY_TARGET" ? "Daily TP" :
                    t.closeReason === "DAILY_STOP_LOSS" ? "Daily SL" : "Thu cong";
                  text += `${icon} *${t.symbol}* ${sign(t.pnlUsdt)}${t.pnlUsdt.toFixed(2)} USDT (${reasonVi})\n`;
                }
              }

              if (stats.openTrades.length === 0 && stats.closedToday.length === 0) {
                text += `\n_Chua co lenh nao hom nay._`;
              }

              text += `\n━━━━━━━━━━━━━━━━━━\n_${new Date().toLocaleTimeString("vi-VN")} UTC_`;
              await this.telegramService.sendTelegramMessage(chatId, text);
            } catch (err) {
              await this.telegramService.sendTelegramMessage(chatId, `❌ Loi lay thong ke: ${err?.message}`);
            }
            return;
          }

          // /ai realmode leverage <AI|MAX|N>
          if (arg.startsWith("leverage")) {
            const parts = arg.split(/\s+/);
            const leverageArg = parts[1] ?? "";
            if (leverageArg === "ai") {
              await this.subscriptionService.setRealModeLeverage(telegramId, "AI");
              await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *AI Signal* (dung leverage tu tin hieu AI)`);
            } else if (leverageArg === "max") {
              await this.subscriptionService.setRealModeLeverage(telegramId, "MAX");
              await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *MAX* (dung max leverage Binance cho moi cap)`);
            } else {
              const n = parseInt(leverageArg);
              if (isNaN(n) || n < 1 || n > 125) {
                await this.telegramService.sendTelegramMessage(
                  chatId,
                  `❌ Leverage khong hop le. Dung: AI, MAX, hoac so tu 1-125.\nVD: /ai realmode leverage 10`,
                );
                return;
              }
              await this.subscriptionService.setRealModeLeverage(telegramId, "FIXED", n);
              await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *Fixed ${n}x*`);
            }
            return;
          }

          await this.telegramService.sendTelegramMessage(
            chatId,
            `❌ Lenh khong hop le.\nDung: /ai realmode [on|off|target <N|off>|stoploss <N|off>|leverage <AI|MAX|N>|stats]`,
          );
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
        }
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
      // Check profit targets first (may close signals)
      await this.checkProfitTargets();

      const subscribers = await this.subscriptionService.findSignalsPushSubscribers();
      if (subscribers.length === 0) return;

      // Send personalized message per subscriber (uses their trading balance + per-coin vol + custom TP/SL)
      let sent = 0;
      for (const sub of subscribers) {
        const text = await this.formatSignalsMessage({
          tradingBalance: sub.tradingBalance,
          coinVolumes: sub.coinVolumes,
          customTpPct: sub.customTpPct,
          customSlPct: sub.customSlPct,
        });
        // Skip push if no active signals (don't spam empty messages)
        if (text.includes("Không có tín hiệu")) continue;
        await this.telegramService.sendTelegramMessage(sub.chatId, text).catch(() => {});
        sent++;
      }
      if (sent > 0) {
        this.logger.log(`[AiCommand] Signals push sent to ${sent} subscribers`);
      }
    } catch (err) {
      this.logger.warn(`[AiCommand] pushSignalsToSubscribers error: ${err?.message}`);
    } finally {
      this.pushRunning = false;
    }
  }

  /**
   * Format active signals display, personalized per-user settings.
   * @param opts.tradingBalance Default balance for all coins (USDT per trade)
   * @param opts.coinVolumes Per-coin USDT overrides, e.g. { BTC: 5000 }
   * @param opts.customTpPct Custom TP% — if set, TP price is computed from entry
   * @param opts.customSlPct Custom SL% — if set, SL price is computed from entry
   */
  async formatSignalsMessage(
    opts?: Pick<SubscriberInfo, "tradingBalance" | "coinVolumes" | "customTpPct" | "customSlPct">,
  ): Promise<string> {
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

    const getVol = (symbol: string) =>
      this.getVolForSymbol(symbol, opts?.coinVolumes, opts?.tradingBalance);
    const customTp = opts?.customTpPct;
    const customSl = opts?.customSlPct;

    const fmtPrice = (p: number) =>
      p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
      p >= 1 ? `$${p.toFixed(2)}` :
      p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;
    const fmtUsd = (pct: number, v: number) => {
      const usd = (pct / 100) * v;
      return (usd >= 0 ? "+" : "-") + Math.abs(usd).toFixed(2) + " USDT";
    };

    // TP/SL helpers: use custom % if set (price computed from entry), else AI prices
    const getTpPct = (s: typeof actives[0]) =>
      customTp ?? (s.direction === "LONG"
        ? ((s.takeProfitPrice - s.entryPrice) / s.entryPrice) * 100
        : ((s.entryPrice - s.takeProfitPrice) / s.entryPrice) * 100);
    const getSlPct = (s: typeof actives[0]) =>
      customSl ?? (s.direction === "LONG"
        ? ((s.entryPrice - s.stopLossPrice) / s.entryPrice) * 100
        : ((s.stopLossPrice - s.entryPrice) / s.entryPrice) * 100);
    const getTpPrice = (s: typeof actives[0]) =>
      customTp
        ? (s.direction === "LONG" ? s.entryPrice * (1 + customTp / 100) : s.entryPrice * (1 - customTp / 100))
        : s.takeProfitPrice;
    const getSlPrice = (s: typeof actives[0]) =>
      customSl
        ? (s.direction === "LONG" ? s.entryPrice * (1 - customSl / 100) : s.entryPrice * (1 + customSl / 100))
        : s.stopLossPrice;

    let text = `📊 *AI Signals* (${actives.length} active`;
    if (queued.length > 0) text += `, ${queued.length} queued`;
    if (customTp && customSl) text += ` · TP${customTp}%/SL${customSl}%`;
    text += `)\n━━━━━━━━━━━━━━━━━━\n`;

    if (actives.length > 0) {
      const healthResults = await Promise.allSettled(
        actives.map((s) => this.statsService.checkSignalHealth(s.symbol)),
      );

      // Compute summary
      let totalPnl = 0;
      let totalUsdSum = 0;
      let winning = 0;
      let losing = 0;
      let healthCount = 0;
      for (let i = 0; i < actives.length; i++) {
        const health = healthResults[i].status === "fulfilled"
          ? (healthResults[i] as PromiseFulfilledResult<any>).value
          : null;
        if (health) {
          const v = getVol(actives[i].symbol);
          totalPnl += health.unrealizedPnl;
          totalUsdSum += (health.unrealizedPnl / 100) * v;
          healthCount++;
          if (health.unrealizedPnl >= 0) winning++;
          else losing++;
        }
      }

      if (healthCount > 0) {
        const totalIcon = totalPnl >= 0 ? "📗" : "📕";
        const totalSign = totalPnl >= 0 ? "+" : "";
        const usdSign = totalUsdSum >= 0 ? "+" : "-";
        text += `\n${totalIcon} Tong PnL: *${totalSign}${totalPnl.toFixed(2)}%* (*${usdSign}${Math.abs(totalUsdSum).toFixed(2)} USDT*)`;
        text += ` · ✅ ${winning} 🟢  ❌ ${losing} 🔴\n`;
      }

      for (let i = 0; i < actives.length; i++) {
        const s = actives[i];
        const v = getVol(s.symbol);
        const health = healthResults[i].status === "fulfilled"
          ? (healthResults[i] as PromiseFulfilledResult<any>).value
          : null;
        const dirIcon = s.direction === "LONG" ? "🟢" : "🔴";
        const held = s.executedAt ? Math.floor((Date.now() - s.executedAt.getTime()) / 3600000) : 0;
        const heldStr = held >= 24 ? `${Math.floor(held / 24)}d${held % 24}h` : `${held}h`;
        const tpPct = getTpPct(s);
        const slPct = getSlPct(s);
        const tpPrice = getTpPrice(s);
        const slPrice = getSlPrice(s);
        const tpUsdt = (tpPct / 100) * v;
        const slUsdt = (slPct / 100) * v;

        text += `\n┌ ${dirIcon} *${s.symbol}* ${s.direction} · ${heldStr} · _Vol ${v.toLocaleString()} USDT_\n`;

        if (health) {
          const pnl = health.unrealizedPnl;
          const pnlIcon = pnl >= 0 ? "📗" : "📕";
          const pnlSign = pnl >= 0 ? "+" : "";
          text += `│ ${pnlIcon} *${pnlSign}${pnl.toFixed(2)}%* (*${fmtUsd(pnl, v)}*) · Now ${fmtPrice(health.currentPrice)}\n`;
        }
        text += `│ Entry  ${fmtPrice(s.entryPrice)}\n`;
        text += `│ TP     ${fmtPrice(tpPrice)} _(+${tpPct.toFixed(1)}% / +${tpUsdt.toFixed(2)} USDT)_\n`;
        text += `│ SL     ${fmtPrice(slPrice)} _(-${slPct.toFixed(1)}% / -${slUsdt.toFixed(2)} USDT)_\n`;
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

  /**
   * Check if any subscriber's profit target has been reached.
   * If yes, notify them and close all active signals.
   * Runs in the 10-min auto-push cron.
   */
  private async checkProfitTargets(): Promise<void> {
    try {
      const targets = await this.subscriptionService.findSubscribersWithProfitTarget();
      if (targets.length === 0) return;

      const actives = await this.signalQueueService.getAllActiveSignals();
      if (actives.length === 0) {
        // No positions open — reset notified flag so next cycle can fire again
        for (const sub of targets) {
          if (sub.profitTargetNotified) {
            await this.subscriptionService.setProfitTargetNotified(sub.telegramId, false);
          }
        }
        return;
      }

      // Fetch health for all active signals (current prices + unrealised PnL)
      const healthResults = await Promise.allSettled(
        actives.map((s) => this.statsService.checkSignalHealth(s.symbol)),
      );

      for (const sub of targets) {
        if (sub.profitTargetNotified) continue; // already notified this cycle

        const getSubVol = (symbol: string) =>
          this.getVolForSymbol(symbol, sub.coinVolumes, sub.tradingBalance);
        let totalUsd = 0;
        for (let i = 0; i < actives.length; i++) {
          const health =
            healthResults[i].status === "fulfilled"
              ? (healthResults[i] as PromiseFulfilledResult<any>).value
              : null;
          if (!health) continue;
          const vol = getSubVol(actives[i].symbol);
          totalUsd += (health.unrealizedPnl / 100) * vol;
        }

        if (totalUsd >= (sub.profitTarget ?? Infinity)) {
          const sign = totalUsd >= 0 ? "+" : "";
          const msg =
            `🎯 *Muc tieu loi nhuan dat!*\n━━━━━━━━━━━━━━━━━━\n` +
            `Tong PnL: *${sign}${totalUsd.toFixed(2)} USDT*\n` +
            `Muc tieu: *+${(sub.profitTarget ?? 0).toFixed(2)} USDT*\n\n` +
            `_Tat ca tin hieu se duoc dong lai._`;
          await this.telegramService.sendTelegramMessage(sub.chatId, msg).catch(() => {});
          await this.subscriptionService.setProfitTargetNotified(sub.telegramId, true);

          // Close all active signals at current market price
          for (let i = 0; i < actives.length; i++) {
            const health =
              healthResults[i].status === "fulfilled"
                ? (healthResults[i] as PromiseFulfilledResult<any>).value
                : null;
            const exitPrice = health?.currentPrice ?? actives[i].entryPrice;
            await this.signalQueueService
              .resolveActiveSignal(actives[i].symbol, exitPrice, "AUTO_TAKE_PROFIT")
              .catch(() => {});
          }
          this.logger.log(
            `[AiCommand] Profit target hit for ${sub.telegramId}: +${totalUsd.toFixed(2)} USDT — closed ${actives.length} signals`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`[AiCommand] checkProfitTargets error: ${err?.message}`);
    }
  }

  /** Resolve per-trade volume for a symbol: coin override → base balance → 1000 USDT default. */
  private getVolForSymbol(
    symbol: string,
    coinVolumes?: Record<string, number>,
    tradingBalance?: number,
  ): number {
    const base = symbol.replace(/USDT$/, ""); // "BTCUSDT" → "BTC"
    return coinVolumes?.[base] ?? coinVolumes?.[symbol] ?? tradingBalance ?? 1000;
  }

  private isAdmin(telegramId?: number): boolean {
    if (!telegramId) return false;
    if (this.adminIds.length === 0) return true; // no admin restriction configured
    return this.adminIds.includes(telegramId);
  }
}
