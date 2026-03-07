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
import { MarketDataService } from "../market-data/market-data.service";
import { BinanceService } from "../binance/binance.service";

const DUAL_TIMEFRAME_COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

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
    private readonly marketDataService: MarketDataService,
    private readonly binanceService: BinanceService,
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
    // /start — auto-create user subscription
    this.telegramService.registerBotCommand(/^\/start/, async (msg) => {
      const telegramId = msg.from?.id;
      const chatId = msg.chat.id;
      if (!telegramId) return;

      try {
        const existing = await this.subscriptionService.getSubscription(telegramId);
        if (!existing) {
          await this.subscriptionService.subscribe(telegramId, chatId, msg.from?.username);
          this.logger.log(`[AiCommand] Auto-created subscription for user ${telegramId} (${msg.from?.username ?? "no username"}) via /start`);
        }
      } catch (err) {
        this.logger.warn(`[AiCommand] Failed to auto-subscribe user ${telegramId}: ${err?.message}`);
      }
    });

    // /ai — show subcommand help
    this.telegramService.registerBotCommand(/^\/ai$/, async (msg) => {
      const chatId = msg.chat.id;
      const isAdmin = this.isAdmin(msg.from?.id);
      let text =
        `🤖 *AI Signal Commands*\n\n` +
        `*Bat dau:*\n` +
        `/ai setkeys <key> <secret> — Luu Binance API keys\n` +
        `/ai on — Bat bot giao dich\n` +
        `/ai off — Tat bot giao dich\n\n` +
        `*Cai dat:*\n` +
        `/ai settings — Xem cai dat cua ban\n` +
        `/ai leverage AI|MAX|<so> — Dat leverage\n` +
        `/ai target <N|off> — Muc tieu loi nhuan %/ngay\n` +
        `/ai stoploss <N|off> — Gioi han lo %/ngay\n` +
        `/ai maxpos <N> — Toi da vi the cung luc\n` +
        `/ai vol <COIN> <so> — Vol rieng cho tung coin\n` +
        `/ai balance <so> — Balance mac dinh\n` +
        `/ai tpsl <tp%> <sl%> — TP/SL tuy chinh\n\n` +
        `*Tai khoan:*\n` +
        `/ai my — Dashboard (so du, PnL, all-time)\n` +
        `/ai my history — Lich su 10 lenh gan nhat\n` +
        `/ai account — Vi the mo & PnL\n` +
        `/ai close — Dong lenh\n\n` +
        `*He thong:*\n` +
        `/ai signals — Tin hieu AI dang chay\n` +
        `/ai rank — Xep hang PnL\n` +
        `/ai daily history — Lich su TP/SL hang ngay\n`;
      await this.telegramService.sendTelegramMessage(chatId, text);
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
            `ℹ️ Dung /ai on de bat bot giao dich.`,
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
            `⚡ Bot: ❌ Chưa bật\n\n` +
            `Dùng /ai setkeys va /ai on de bat dau.`,
          );
          return;
        }

        const moneyFlow = sub.moneyFlowEnabled !== false;
        const pushEnabled = sub.signalsPushEnabled === true;
        const subscribedAt = sub.subscribedAt
          ? new Date(sub.subscribedAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
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
          `⚡ Bot: ${realMode ? "✅ BẬT" : "❌ TẮT"}\n` +
          `🔑 Binance API: ${hasKeys ? "✅ Da luu" : "❌ Chua luu"}\n` +
          `📊 Leverage: *${leverageLabel}*\n` +
          `📈 Max vi the: *${sub.maxOpenPositions ?? 3} lenh*\n` +
          (openTrades.length > 0 ? `📊 Lenh mo: *${openTrades.length}*\n` : "") +
          `🚨 Canh bao dong tien: ${moneyFlow ? "✅ Bat" : "❌ Tat"}\n` +
          `📡 Auto push: ${pushEnabled ? "✅ Bat (10 phut)" : "❌ Tat"}\n\n` +
          `*Daily Limit:*\n` +
          `🎯 Muc tieu loi: ${sub.realModeDailyTargetPct ? `*+${sub.realModeDailyTargetPct}%/ngay*` : "_Chua dat_"}\n` +
          `🛑 Gioi han lo: ${sub.realModeDailyStopLossPct ? `*-${sub.realModeDailyStopLossPct}%/ngay*` : "_Chua dat_"}\n\n` +
          `*Vol & TP/SL:*\n` +
          `💰 Balance: *${balance.toLocaleString()} USDT/lenh*\n` +
          (coinVolLines ? `${coinVolLines}\n` : `  _Chua co override coin nao_\n`) +
          `📐 TP/SL: ${tpSlLine}\n\n` +
          `*Thay doi:*\n` +
          `/ai on|off — Bat/tat bot\n` +
          `/ai leverage AI|MAX|10 — Dat leverage\n` +
          `/ai target 5 — Muc tieu +5%/ngay\n` +
          `/ai stoploss 3 — Gioi han lo -3%/ngay\n` +
          `/ai maxpos 3 — Toi da 3 lenh\n` +
          `/ai balance <so> — Balance mac dinh\n` +
          `/ai vol BTC 5000 — Vol BTC rieng\n` +
          `/ai tpsl 2.5 1.5 — TP/SL tuy chinh`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Lỗi: ${err?.message}`);
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

    // /ai coins — show how many coins are currently being listened to
    this.telegramService.registerBotCommand(/^\/ai[_ ]coins/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const status = await this.aiSignalService.getStatus();
        const coins = status.shortlist;
        const count = coins.length;

        if (count === 0) {
          await this.telegramService.sendTelegramMessage(chatId, `📡 *Coins dang theo doi*\n\n_Chua co coin nao duoc load. Thu lai sau._`);
          return;
        }

        // Group into rows of 5 for readability
        const rows: string[] = [];
        for (let i = 0; i < coins.length; i += 5) {
          rows.push(coins.slice(i, i + 5).map(s => s.replace("USDT", "")).join(" · "));
        }

        const text =
          `📡 *Coins dang theo doi: ${count} coin*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          rows.join("\n") +
          `\n\n_Danh sach cap nhat moi 5 phut theo volume & bien dong gia._`;

        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai signals — view user's open trades (real mode) or all signals (signal-only mode)
    this.telegramService.registerBotCommand(/^\/ai[_ ]signals/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;

      try {
        const sub = telegramId ? await this.subscriptionService.getSubscription(telegramId) : null;

        // Real trading users see their own trades
        if (sub?.realModeEnabled && telegramId) {
          const text = await this.formatUserTradesMessage(telegramId);
          await this.telegramService.sendTelegramMessage(chatId, text);
          return;
        }

        // Signal-only users see all system signals
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
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua bat bot. Dung /ai on de bat.`);
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
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua bat bot. Dung /ai on de bat.`);
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
          await this.telegramService.sendTelegramMessage(chatId, `❌ Ban chua bat bot. Dung /ai on de bat.`);
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
            `ℹ️ Dung /ai on de bat bot giao dich.`,
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
          const _to = (p: Promise<any>, ms: number) =>
            Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
          const healthResults = await Promise.allSettled(
            actives.map((s) => _to(this.statsService.buildHealthCheck(s as any), 3000)),
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

    // /ai resetall — cancel all signals + clear Redis state (admin only)
    this.telegramService.registerBotCommand(/^\/ai[_ ]resetall$/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      const cancelled = await this.signalQueueService.cancelAllSignals();
      await this.telegramService.sendTelegramMessage(
        chatId,
        `✅ *Reset hoan tat*\n\n` +
        `• ${cancelled} tin hieu da huy (ACTIVE + QUEUED)\n` +
        `• Redis signal keys da xoa\n\n` +
        `_He thong san sang cho tin hieu moi._`,
      );
    });

    // /ai admin reset — full database clean: delete all signals + trades + reset stats (admin only)
    this.telegramService.registerBotCommand(/^\/ai[_ ]admin[_ ]reset$/i, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.isAdmin(msg.from?.id)) return;

      try {
        // Close any real positions first
        const realModeUsers = await this.subscriptionService.findRealModeSubscribers();
        let realClosed = 0;
        for (const user of realModeUsers) {
          const count = await this.userRealTradingService
            .closeAllRealPositions(user.telegramId, user.chatId, "ADMIN_RESET")
            .catch(() => 0);
          realClosed += count;
        }

        // Full reset: delete all signal docs + clear all Redis keys
        const signalsDeleted = await this.signalQueueService.fullReset();

        // Delete all user trades
        const tradesDeleted = await this.userRealTradingService.deleteAllTrades();

        // Reset coin profile stats
        const profilesReset = await this.aiSignalService.resetCoinProfileStats();

        let text = `🔄 *Full Reset hoan tat*\n\n`;
        text += `• ${signalsDeleted} tin hieu da xoa\n`;
        text += `• ${tradesDeleted} giao dich da xoa\n`;
        text += `• ${profilesReset} coin profile da reset stats\n`;
        text += `• Redis signal/params/cooldown keys da xoa\n`;
        if (realClosed > 0) text += `• ${realClosed} lenh that da dong\n`;
        text += `\n_He thong clean, san sang test moi._`;

        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
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
          // Auto-subscribe if not yet registered
          const sub = await this.subscriptionService.getSubscription(telegramId);
          if (!sub) {
            await this.subscriptionService.subscribe(telegramId, chatId, msg.from?.username);
          }

          await this.userSettingsService.saveApiKeys(telegramId, chatId, "binance", apiKey, apiSecret);
          await this.telegramService.sendTelegramMessage(
            chatId,
            `✅ *Binance API Keys da duoc luu!*\n\nDung /ai on de bat bot giao dich`,
          );
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
        }
      },
    );

    // /ai on — start trading (auto-subscribe + enable real mode)
    this.telegramService.registerBotCommand(/^\/ai[_ ]on$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
        if (!keys?.apiKey) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `❌ Ban chua luu Binance API keys.\nDung: \`/ai setkeys <apiKey> <apiSecret>\``,
          );
          return;
        }

        // Enable hedge mode (dual side position) so bot can hold LONG + SHORT simultaneously
        const hedgeOk = await this.binanceService.enableHedgeMode(keys.apiKey, keys.apiSecret);
        if (!hedgeOk) {
          await this.telegramService.sendTelegramMessage(
            chatId,
            `⚠️ Khong the bat Hedge Mode tren Binance.\nHay bat thu cong: Binance App → Futures → Settings → Position Mode → Hedge Mode.\nSau do thu lai /ai on.`,
          );
          return;
        }

        // Auto-subscribe if not yet registered
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.subscriptionService.subscribe(telegramId, chatId, msg.from?.username);
        }
        await this.subscriptionService.setRealMode(telegramId, true);
        // Clear daily-disabled flag so the user gets a fresh daily counter
        await this.subscriptionService.setRealModeDailyDisabled(telegramId, null).catch(() => {});
        await this.telegramService.sendTelegramMessage(
          chatId,
          `✅ *Bot da bat!*\n\n🔄 Hedge Mode: ON\nBot se tu dong dat lenh that khi co tin hieu moi.\nDung /ai off de tat.`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai off — stop trading
    this.telegramService.registerBotCommand(/^\/ai[_ ]off$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        await this.subscriptionService.setRealMode(telegramId, false);
        await this.userDataStreamService.unregisterUser(telegramId).catch(() => {});
        await this.telegramService.sendTelegramMessage(
          chatId,
          `✅ *Bot da tat.*\n\nKhong co them lenh that nao duoc dat.\nDung /ai on de bat lai.`,
        );
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai leverage <AI|MAX|N> — set leverage mode
    this.telegramService.registerBotCommand(/^\/ai[_ ]leverage(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot truoc.`);
          return;
        }

        const leverageArg = (match?.[1] ?? "").toLowerCase();
        if (!leverageArg) {
          const mode = sub.realModeLeverageMode ?? "AI";
          const label = mode === "FIXED" ? `Fixed ${sub.realModeLeverage ?? "?"}x` : mode === "MAX" ? "Max (Binance)" : "AI Signal";
          await this.telegramService.sendTelegramMessage(chatId,
            `📊 *Leverage hien tai: ${label}*\n\nDung: /ai leverage AI|MAX|<so>\nVD: /ai leverage 10`);
          return;
        }

        if (leverageArg === "ai") {
          await this.subscriptionService.setRealModeLeverage(telegramId, "AI");
          await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *AI Signal* (dung leverage tu tin hieu AI)`);
        } else if (leverageArg === "max") {
          await this.subscriptionService.setRealModeLeverage(telegramId, "MAX");
          await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *MAX* (dung max leverage Binance cho moi cap)`);
        } else {
          const n = parseInt(leverageArg);
          if (isNaN(n) || n < 1 || n > 125) {
            await this.telegramService.sendTelegramMessage(chatId,
              `❌ Leverage khong hop le. Dung: AI, MAX, hoac so tu 1-125.\nVD: /ai leverage 10`);
            return;
          }
          await this.subscriptionService.setRealModeLeverage(telegramId, "FIXED", n);
          await this.telegramService.sendTelegramMessage(chatId, `✅ Leverage: *Fixed ${n}x*`);
        }
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai target <N|off> — daily profit target %
    this.telegramService.registerBotCommand(/^\/ai[_ ]target(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const val = (match?.[1] ?? "").toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot truoc.`);
          return;
        }

        if (!val) {
          const cur = sub.realModeDailyTargetPct;
          await this.telegramService.sendTelegramMessage(chatId,
            `🎯 *Muc tieu loi nhuan ngay*\n\n` +
            (cur != null ? `Hien tai: *+${cur}%*\nDung /ai target off de tat` : `_Chua dat_\nDung: /ai target 5 — dat +5%/ngay`));
          return;
        }

        if (val === "off") {
          await this.subscriptionService.setDailyTargetPct(telegramId, null);
          await this.telegramService.sendTelegramMessage(chatId, `✅ Muc tieu loi nhuan ngay da tat.`);
        } else {
          const n = parseFloat(val);
          if (isNaN(n) || n <= 0 || n > 100) {
            await this.telegramService.sendTelegramMessage(chatId,
              `❌ Nhap % hop le (1–100).\nVD: /ai target 5 — dat muc tieu +5% moi ngay`);
            return;
          }
          await this.subscriptionService.setDailyTargetPct(telegramId, n);
          await this.telegramService.sendTelegramMessage(chatId,
            `✅ *Muc Tieu Loi Nhuan Ngay: +${n}%*\n\nKhi tong PnL hom nay dat +${n}%, bot se tu dong dong tat ca lenh.\nSe mo lai tu dong vao ngay mai.`);
        }
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai stoploss <N|off> — daily stop loss %
    this.telegramService.registerBotCommand(/^\/ai[_ ]stoploss(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const val = (match?.[1] ?? "").toLowerCase();

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot truoc.`);
          return;
        }

        if (!val) {
          const cur = sub.realModeDailyStopLossPct;
          await this.telegramService.sendTelegramMessage(chatId,
            `🛑 *Gioi han lo ngay*\n\n` +
            (cur != null ? `Hien tai: *-${cur}%*\nDung /ai stoploss off de tat` : `_Chua dat_\nDung: /ai stoploss 3 — dat -3%/ngay`));
          return;
        }

        if (val === "off") {
          await this.subscriptionService.setDailyStopLossPct(telegramId, null);
          await this.telegramService.sendTelegramMessage(chatId, `✅ Gioi han lo ngay da tat.`);
        } else {
          const n = parseFloat(val);
          if (isNaN(n) || n <= 0 || n > 100) {
            await this.telegramService.sendTelegramMessage(chatId,
              `❌ Nhap % hop le (1–100).\nVD: /ai stoploss 3 — dat gioi han lo -3% moi ngay`);
            return;
          }
          await this.subscriptionService.setDailyStopLossPct(telegramId, n);
          await this.telegramService.sendTelegramMessage(chatId,
            `✅ *Gioi Han Lo Ngay: -${n}%*\n\nKhi tong PnL hom nay giam -${n}%, bot se tu dong dong tat ca lenh.\nSe mo lai tu dong vao ngay mai.`);
        }
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai maxpos <N> — max concurrent positions
    this.telegramService.registerBotCommand(/^\/ai[_ ]maxpos(?:\s+(\S+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot truoc.`);
          return;
        }

        const val = match?.[1];
        if (!val) {
          const cur = sub.maxOpenPositions ?? 3;
          await this.telegramService.sendTelegramMessage(chatId,
            `📊 *Toi da vi the: ${cur} lenh*\n\nDung: /ai maxpos <so>\nVD: /ai maxpos 5`);
          return;
        }

        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1 || n > 20) {
          await this.telegramService.sendTelegramMessage(chatId,
            `❌ Nhap so hop le (1–20).\nVD: /ai maxpos 3 — toi da 3 lenh cung luc`);
          return;
        }
        await this.subscriptionService.setMaxOpenPositions(telegramId, n);
        await this.telegramService.sendTelegramMessage(chatId,
          `✅ *Gioi Han Vi The: ${n} lenh*\n\nBot se chi mo toi da ${n} vi the cung luc.\nLenh moi se bi bo qua khi dat gioi han.`);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai close [all|SYMBOL] — close REAL Binance positions (user-facing)
    this.telegramService.registerBotCommand(
      /^\/ai[_ ]close(?:\s+(\S+))?$/i,
      async (msg, match) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        if (!telegramId) return;

        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub?.realModeEnabled) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Bot chua bat. Dung \`/ai on\` de bat.`);
          return;
        }

        const arg = match?.[1]?.toUpperCase() ?? "";
        const isCloseAll = !arg || arg === "ALL";

        const fmtP = (p: number) =>
          p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
          p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;

        try {
          const realTrades = await this.userRealTradingService.getOpenTrades(telegramId);

          if (isCloseAll) {
            if (realTrades.length === 0) {
              await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Khong co lenh that nao dang mo.`);
              return;
            }

            let text = `⚠️ *Xac nhan dong tat ca lenh that?*\n━━━━━━━━━━━━━━━━━━\n`;
            const allPnls: number[] = [];
            let totalUsdtPnl = 0;
            for (const t of realTrades) {
              const price = this.marketDataService.getLatestPrice(t.symbol) ?? t.entryPrice;
              const pnlPct = t.direction === "LONG"
                ? ((price - t.entryPrice) / t.entryPrice) * 100
                : ((t.entryPrice - price) / t.entryPrice) * 100;
              const pnlUsdt = (pnlPct / 100) * (t.notionalUsdt || 0);
              totalUsdtPnl += pnlUsdt;
              allPnls.push(pnlPct);
              const sign = pnlPct >= 0 ? "+" : "";
              const usdtSign = pnlUsdt >= 0 ? "+" : "";
              const icon = pnlPct >= 0 ? "📗" : "📕";
              text += `${icon} ${t.symbol} ${t.direction} (${fmtP(t.entryPrice)}) — *${sign}${pnlPct.toFixed(2)}% (${usdtSign}${pnlUsdt.toFixed(2)} USDT)*\n`;
            }
            text += `\n_Bam xac nhan de dong *${realTrades.length} lenh that*._`;

            const avgPnl = allPnls.reduce((a, b) => a + b, 0) / allPnls.length;
            const avgSign = avgPnl >= 0 ? "+" : "";
            const totalUsdtSign = totalUsdtPnl >= 0 ? "+" : "";
            await this.telegramService.sendMessageWithKeyboard(chatId, text, [[
              { text: `✅ ${avgSign}${avgPnl.toFixed(2)}% (${totalUsdtSign}${totalUsdtPnl.toFixed(2)} USDT) Dong ${realTrades.length} lenh`, callback_data: `close_all:${telegramId}` },
              { text: `❌ Huy`, callback_data: `close_cancel` },
            ]]);
          } else {
            const symbol = arg.endsWith("USDT") ? arg : `${arg}USDT`;
            const realTrade = realTrades.find((t) => t.symbol === symbol);

            if (!realTrade) {
              await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Khong co lenh that nao dang mo cho *${symbol}*.`);
              return;
            }

            const price = this.marketDataService.getLatestPrice(symbol) ?? realTrade.entryPrice;
            const pnlPct = realTrade.direction === "LONG"
              ? ((price - realTrade.entryPrice) / realTrade.entryPrice) * 100
              : ((realTrade.entryPrice - price) / realTrade.entryPrice) * 100;
            const pnlUsdt = (pnlPct / 100) * (realTrade.notionalUsdt || 0);
            const sign = pnlPct >= 0 ? "+" : "";
            const usdtSign = pnlUsdt >= 0 ? "+" : "";

            let text = `⚠️ *Xac nhan dong ${symbol}?*\n━━━━━━━━━━━━━━━━━━\n`;
            text += `\n⚡ Lenh that: ${realTrade.direction} — *${sign}${pnlPct.toFixed(2)}% (${usdtSign}${pnlUsdt.toFixed(2)} USDT)*\n`;
            text += `Entry: ${fmtP(realTrade.entryPrice)} · Now: ${fmtP(price)}\n`;

            await this.telegramService.sendMessageWithKeyboard(chatId, text, [[
              { text: `✅ ${sign}${pnlPct.toFixed(2)}% (${usdtSign}${pnlUsdt.toFixed(2)} USDT) Dong ${symbol}`, callback_data: `close_sig:${symbol}:${telegramId}` },
              { text: `❌ Huy`, callback_data: `close_cancel` },
            ]]);
          }
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
        }
      },
    );

    // /ai admin close [all|SYMBOL] — close AI signals AND all users' real positions for those signals
    this.telegramService.registerBotCommand(
      /^\/ai[_ ]admin[_ ]close(?:\s+(\S+))?$/i,
      async (msg, match) => {
        if (!this.isAdmin(msg.from?.id)) return;
        const chatId = msg.chat.id;

        const arg = match?.[1]?.toUpperCase() ?? "";
        const isCloseAll = !arg || arg === "ALL";

        try {
          const testSignals = await this.signalQueueService.getAllActiveSignals();
          const realModeUsers = await this.subscriptionService.findRealModeSubscribers();

          if (isCloseAll) {
            if (testSignals.length === 0) {
              await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Khong co tin hieu AI nao dang chay.`);
              return;
            }

            // Close all AI signals (use signal key with profile for dual-timeframe coins)
            let signalsClosed = 0;
            for (const s of testSignals) {
              const price = this.marketDataService.getLatestPrice(s.symbol) ?? s.entryPrice;
              const sigKey = this.getSignalKey(s);
              await this.signalQueueService.resolveActiveSignal(sigKey, price, "MANUAL").catch(() => {});
              signalsClosed++;
            }

            // Close all real positions for all real-mode users
            let realClosed = 0;
            for (const user of realModeUsers) {
              const count = await this.userRealTradingService
                .closeAllRealPositions(user.telegramId, user.chatId, "ADMIN_CLOSE")
                .catch(() => 0);
              realClosed += count;
            }

            let resultText = `✅ *Da dong ${signalsClosed} tin hieu AI*\n`;
            if (realClosed > 0) resultText += `⚡ Da dong ${realClosed} lenh that cho ${realModeUsers.length} user\n`;
            resultText += `📊 He thong se tao tin hieu moi trong lan scan tiep theo.`;
            await this.telegramService.sendTelegramMessage(chatId, resultText);
          } else {
            const symbol = arg.endsWith("USDT") ? arg : `${arg}USDT`;
            const signal = testSignals.find((s) => s.symbol === symbol);

            if (!signal) {
              await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Khong co tin hieu AI nao cho *${symbol}*.`);
              return;
            }

            // Close the AI signal (use signal key with profile for dual-timeframe coins)
            const price = this.marketDataService.getLatestPrice(symbol) ?? signal.entryPrice;
            const pnlPct = signal.direction === "LONG"
              ? ((price - signal.entryPrice) / signal.entryPrice) * 100
              : ((signal.entryPrice - price) / signal.entryPrice) * 100;
            const sigKey = this.getSignalKey(signal);
            await this.signalQueueService.resolveActiveSignal(sigKey, price, "MANUAL").catch(() => {});

            // Close real positions for this symbol for all real-mode users
            let realClosed = 0;
            for (const user of realModeUsers) {
              const result = await this.userRealTradingService
                .closeRealPosition(user.telegramId, user.chatId, symbol, "ADMIN_CLOSE")
                .catch(() => ({ success: false }));
              if (result.success) realClosed++;
            }

            const sign = pnlPct >= 0 ? "+" : "";
            let resultText = `✅ *Da dong tin hieu ${symbol}* (${sign}${pnlPct.toFixed(2)}%)\n`;
            if (realClosed > 0) resultText += `⚡ Da dong ${realClosed} lenh that\n`;
            resultText += `📊 Se tao tin hieu moi khi co co hoi.`;
            await this.telegramService.sendTelegramMessage(chatId, resultText);
          }
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
        }
      },
    );

    // /ai account — real mode open positions with unrealized PnL (also handles /ai_account)
    this.telegramService.registerBotCommand(/^\/ai[_ ]account/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot giao dich.`);
          return;
        }
        if (!sub.realModeEnabled) {
          await this.telegramService.sendTelegramMessage(chatId,
            `⚡ *Bot chua bat*\n\nDung /ai on de bat.`);
          return;
        }

        const stats = await this.userRealTradingService.getDailyStats(telegramId);

        if (stats.openTrades.length === 0 && stats.closedToday.length === 0) {
          // Try to show Binance Futures wallet balance
          const keys = await this.userSettingsService.getApiKeys(telegramId, "binance");
          let balanceText = `_Chua co lenh nao hom nay._`;
          if (keys?.apiKey) {
            const bal = await this.binanceService.getFuturesBalance(keys.apiKey, keys.apiSecret);
            if (bal) {
              const pnlSign = bal.unrealizedPnl >= 0 ? "+" : "";
              balanceText =
                `💼 *So du Futures (USDT)*\n\n` +
                `Wallet:    *${bal.walletBalance.toFixed(2)} USDT*\n` +
                `Available: *${bal.availableBalance.toFixed(2)} USDT*\n` +
                (Math.abs(bal.unrealizedPnl) > 0.01
                  ? `Unrealized: *${pnlSign}${bal.unrealizedPnl.toFixed(2)} USDT*\n`
                  : ``) +
                `\n_Chua co vi the nao dang mo._`;
            }
          }
          await this.telegramService.sendTelegramMessage(chatId,
            `⚡ *Real Account*\n━━━━━━━━━━━━━━━━━━\n\n${balanceText}`);
          return;
        }

        const unrealizedTotal = stats.openTrades.reduce((s, t) => s + t.unrealizedPnlUsdt, 0);
        const unrealizedSign = unrealizedTotal >= 0 ? "+" : "";
        const unrealizedIcon = unrealizedTotal >= 0 ? "📗" : "📕";
        const dailySign = stats.totalPnlUsdt >= 0 ? "+" : "";
        const dailyIcon = stats.totalPnlUsdt >= 0 ? "📗" : "📕";

        let text = `⚡ *Real Account*\n━━━━━━━━━━━━━━━━━━\n`;
        text += `\n*${stats.openTrades.length} lenh mo* · ${dailyIcon} PnL hom nay: *${dailySign}${stats.totalPnlUsdt.toFixed(2)} USDT*\n`;

        if (stats.openTrades.length > 0) {
          text += `\n`;
          for (const t of stats.openTrades) {
            const dirIcon = t.direction === "LONG" ? "🟢" : "🔴";
            const pnlIcon = t.unrealizedPnlUsdt >= 0 ? "📗" : "📕";
            const pnlSign = t.unrealizedPnlPct >= 0 ? "+" : "";
            const usdtSign = t.unrealizedPnlUsdt >= 0 ? "+" : "";
            const nowPrice = this.marketDataService.getLatestPrice(t.symbol);
            const held = t.openedAt
              ? Math.floor((Date.now() - new Date(t.openedAt).getTime()) / 3600000)
              : 0;
            const heldStr = held >= 24 ? `${Math.floor(held / 24)}d${held % 24}h` : `${held}h`;
            text += `${dirIcon} *${t.symbol}* ${t.direction} ${t.leverage}x · ${heldStr}\n`;
            text += `${pnlIcon} *${pnlSign}${t.unrealizedPnlPct.toFixed(2)}% (${usdtSign}${t.unrealizedPnlUsdt.toFixed(2)} USDT)*\n`;
            text += `Entry: ${fmtP(t.entryPrice)}${nowPrice ? ` · Now: ${fmtP(nowPrice)}` : ""} · Vol: ${t.notionalUsdt.toFixed(0)} USDT\n\n`;
          }
        }

        text += `━━━━━━━━━━━━━━━━━━\n`;
        text += `${unrealizedIcon} Unrealized: *${unrealizedSign}${unrealizedTotal.toFixed(2)} USDT*\n`;
        if (stats.closedToday.length > 0) {
          const closedPnl = stats.closedToday.reduce((s, t) => s + t.pnlUsdt, 0);
          const closedSign = closedPnl >= 0 ? "+" : "";
          text += `📋 Da dong hom nay: *${stats.closedToday.length} lenh* (${closedSign}${closedPnl.toFixed(2)} USDT)\n`;
        }
        text += `_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;

        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai my — personal dashboard: wallet + open trades + today closed + all-time stats
    this.telegramService.registerBotCommand(/^\/ai[_ ]my$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const fmtP = (p: number) =>
        p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
        p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;
      const sign = (v: number) => v >= 0 ? "+" : "";

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub) {
          await this.telegramService.sendTelegramMessage(chatId, `ℹ️ Dung /ai on de bat bot giao dich.`);
          return;
        }
        const keys = sub.realModeEnabled
          ? await this.userSettingsService.getApiKeys(telegramId, "binance")
          : null;
        const [stats, balance] = await Promise.all([
          this.userRealTradingService.getDailyStats(telegramId),
          keys ? this.binanceService.getFuturesBalance(keys.apiKey, keys.apiSecret) : Promise.resolve(null),
        ]);

        const pnlIcon = stats.totalPnlUsdt >= 0 ? "📗" : "📕";
        const balancePct = balance && balance.walletBalance > 0
          ? (stats.totalPnlUsdt / balance.walletBalance) * 100
          : stats.dailyPnlPct;

        // Win rate from today's closed trades
        const wins = stats.closedToday.filter(t => t.pnlUsdt >= 0).length;
        const totalClosed = stats.closedToday.length;

        let text = `⚡ *My Dashboard*\n━━━━━━━━━━━━━━━━━━\n\n`;

        // ── Wallet overview ──
        if (balance) {
          text += `💰 So Du: *${balance.walletBalance.toFixed(2)} USDT*\n`;
          text += `    Kha dung: ${balance.availableBalance.toFixed(2)}`;
          if (Math.abs(balance.unrealizedPnl) > 0.01) {
            const urIcon = balance.unrealizedPnl >= 0 ? "📈" : "📉";
            text += ` · ${urIcon} *${sign(balance.unrealizedPnl)}${balance.unrealizedPnl.toFixed(2)}*`;
          }
          text += `\n`;
        }

        // ── Today PnL card ──
        const todayPnlEmoji = stats.totalPnlUsdt >= 0 ? "🟩" : "🟥";
        text += `\n${todayPnlEmoji} *PnL Hom Nay*\n`;
        text += `    *${sign(stats.totalPnlUsdt)}${stats.totalPnlUsdt.toFixed(2)} USDT* (${sign(balancePct)}${balancePct.toFixed(2)}%)\n`;
        text += `    Mo: ${stats.openTrades.length} · Dong: ${totalClosed}`;
        if (totalClosed > 0) {
          text += ` · 🏆 ${wins}W/${totalClosed - wins}L (${Math.round(wins / totalClosed * 100)}%)`;
        }
        text += `\n`;

        // ── Open positions ──
        if (stats.openTrades.length > 0) {
          text += `\n━━━━━━━━━━━━━━━━━━\n`;
          text += `📊 *Lenh Dang Mo* (${stats.openTrades.length})\n\n`;
          for (const t of stats.openTrades) {
            const dirIcon = t.direction === "LONG" ? "🟢" : "🔴";
            const pnlIcon = t.unrealizedPnlUsdt >= 0 ? "📈" : "📉";
            const held = t.openedAt ? Math.floor((Date.now() - new Date(t.openedAt).getTime()) / 3600000) : 0;
            const heldStr = held >= 24 ? `${Math.floor(held / 24)}d${held % 24}h` : `${held}h`;
            text += `${dirIcon} *${t.symbol}* · ${t.leverage}x · ${heldStr}\n`;
            text += `    ${pnlIcon} PnL: *${sign(t.unrealizedPnlPct)}${t.unrealizedPnlPct.toFixed(2)}%* (*${sign(t.unrealizedPnlUsdt)}${t.unrealizedPnlUsdt.toFixed(2)} USDT*)\n\n`;
          }
        }

        // ── Closed today (grouped: wins then losses) ──
        if (stats.closedToday.length > 0) {
          text += `━━━━━━━━━━━━━━━━━━\n`;
          const closedPnl = stats.closedToday.reduce((s, t) => s + (t.pnlUsdt || 0), 0);
          text += `📋 *Da Dong* (${totalClosed}) · *${sign(closedPnl)}${closedPnl.toFixed(2)} USDT*\n\n`;

          const winTrades = stats.closedToday.filter(t => t.pnlUsdt > 0);
          const lossTrades = stats.closedToday.filter(t => t.pnlUsdt < 0);
          const breakEvenTrades = stats.closedToday.filter(t => t.pnlUsdt === 0);

          if (winTrades.length > 0) {
            const winTotal = winTrades.reduce((s, t) => s + t.pnlUsdt, 0);
            text += `✅ *Win (${winTrades.length})* · +${winTotal.toFixed(2)} USDT\n`;
            for (const t of winTrades) {
              const sym = t.symbol.replace("USDT", "");
              text += `    ${sym} +${t.pnlUsdt.toFixed(2)}\n`;
            }
            text += `\n`;
          }

          if (lossTrades.length > 0) {
            const lossTotal = lossTrades.reduce((s, t) => s + t.pnlUsdt, 0);
            text += `❌ *Loss (${lossTrades.length})* · ${lossTotal.toFixed(2)} USDT\n`;
            for (const t of lossTrades) {
              const sym = t.symbol.replace("USDT", "");
              text += `    ${sym} ${t.pnlUsdt.toFixed(2)}\n`;
            }
            text += `\n`;
          }

          if (breakEvenTrades.length > 0) {
            text += `➖ *Break-even (${breakEvenTrades.length})*\n`;
            for (const t of breakEvenTrades) {
              const sym = t.symbol.replace("USDT", "");
              text += `    ${sym} 0.00\n`;
            }
            text += `\n`;
          }
        }

        if (stats.openTrades.length === 0 && stats.closedToday.length === 0) {
          text += `\n_Chua co lenh nao hom nay._\n`;
        }

        // ── All-time stats ──
        const at = stats.allTime;
        if (at.total > 0) {
          const atWinRate = Math.round((at.wins / at.total) * 100);
          const atIcon = at.pnlUsdt >= 0 ? "📈" : "📉";
          text += `\n━━━━━━━━━━━━━━━━━━\n`;
          text += `${atIcon} *All-time*\n`;
          text += `    ${at.total} lenh · ${atWinRate}% WR\n`;
          text += `    *${sign(at.pnlUsdt)}${at.pnlUsdt.toFixed(2)} USDT*\n`;
        }

        text += `\n_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai my history — recent trade history (last 10 closed trades)
    this.telegramService.registerBotCommand(/^\/ai[_ ]my[_ ]history$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      const sign = (v: number) => v >= 0 ? "+" : "";

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub?.realModeEnabled) {
          await this.telegramService.sendTelegramMessage(chatId,
            `⚡ *Bot chua bat*\n\nDung /ai on de bat.`);
          return;
        }

        const trades = await this.userRealTradingService.getRecentTrades(telegramId, 10);
        if (trades.length === 0) {
          await this.telegramService.sendTelegramMessage(chatId,
            `📋 *Lich Su Giao Dich*\n━━━━━━━━━━━━━━━━━━\n\n_Chua co lenh nao._`);
          return;
        }

        const totalPnl = trades.reduce((s, t) => s + t.pnlUsdt, 0);
        const totalWins = trades.filter(t => t.pnlUsdt >= 0).length;
        const totalIcon = totalPnl >= 0 ? "📗" : "📕";

        let text = `📋 *Lich Su Giao Dich* (${trades.length} gan nhat)\n━━━━━━━━━━━━━━━━━━\n`;
        text += `${totalIcon} Tong: *${sign(totalPnl)}${totalPnl.toFixed(2)} USDT* · Win: *${totalWins}/${trades.length}*\n\n`;

        for (const t of trades) {
          const icon = t.pnlUsdt >= 0 ? "✅" : "❌";
          const reasonVi =
            t.closeReason === "TAKE_PROFIT" ? "TP" :
            t.closeReason === "STOP_LOSS" ? "SL" :
            t.closeReason === "DAILY_TARGET" ? "Daily TP" :
            t.closeReason === "DAILY_STOP_LOSS" ? "Daily SL" : "Thu cong";
          const dateStr = t.closedAt
            ? new Date(t.closedAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })
            : "";
          text += `${icon} *${t.symbol}* ${sign(t.pnlUsdt)}${t.pnlUsdt.toFixed(2)} USDT (${reasonVi})${dateStr ? ` · ${dateStr}` : ""}\n`;
        }

        text += `\n━━━━━━━━━━━━━━━━━━\n_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai daily_history — view daily TP/SL limit hit history
    this.telegramService.registerBotCommand(/^\/ai[_ ]daily[_ ]history$/i, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const isAdmin = this.adminIds.includes(telegramId);
        const records = isAdmin
          ? await this.userRealTradingService.getAllDailyLimitHistory(30)
          : await this.userRealTradingService.getDailyLimitHistory(telegramId, 20);

        if (records.length === 0) {
          await this.telegramService.sendTelegramMessage(chatId,
            `📊 *Daily Limit History*\n━━━━━━━━━━━━━━━━━━\n\n_Chua co su kien nao._`);
          return;
        }

        const sign = (v: number) => v >= 0 ? "+" : "";
        const title = isAdmin ? "Daily Limit History (All Users)" : "Daily Limit History";
        let text = `📊 *${title}*\n━━━━━━━━━━━━━━━━━━\n\n`;

        for (const r of records) {
          const icon = r.type === "DAILY_TARGET" ? "🎯" : "🛑";
          const typeVi = r.type === "DAILY_TARGET" ? "TP" : "SL";
          const dateStr = new Date(r.triggeredAt).toLocaleString("vi-VN", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
            timeZone: "Asia/Ho_Chi_Minh",
          });
          const userTag = isAdmin ? ` · @${r.username ?? r.telegramId}` : "";
          text += `${icon} *${typeVi}* ${sign(r.pnlUsdt)}${r.pnlUsdt.toFixed(2)} USDT (${sign(r.pnlPct)}${r.pnlPct.toFixed(2)}%) · Limit: ${r.type === "DAILY_TARGET" ? "+" : "-"}${r.limitPct}% · Dong: ${r.positionsClosed} lenh · ${dateStr}${userTag}\n`;
        }

        text += `\n━━━━━━━━━━━━━━━━━━\n_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi: ${err?.message}`);
      }
    });

    // /ai rank — PnL ranking across all real-mode users (also handles /ai_rank)
    this.telegramService.registerBotCommand(/^\/ai[_ ]rank/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from?.id;
      if (!telegramId) return;

      try {
        const sub = await this.subscriptionService.getSubscription(telegramId);
        if (!sub?.realModeEnabled) {
          await this.telegramService.sendTelegramMessage(chatId,
            `⚡ *Bot chua bat*\n\nDung /ai on de bat bot truoc khi xem xep hang.`);
          return;
        }

        const { today, allTime } = await this.userRealTradingService.getAllUsersRanking();

        const medal = (i: number) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        const sign = (v: number) => v >= 0 ? "+" : "";
        const nameOf = (u: { telegramId: number; username?: string }) =>
          u.username ? `@${u.username}` : `User #${u.telegramId}`;

        let text = `🏆 *Xep Hang*\n━━━━━━━━━━━━━━━━━━\n`;

        text += `\n📅 *Hom Nay:*\n`;
        if (today.length === 0) {
          text += `_Chua co giao dich hom nay_\n`;
        } else {
          for (let i = 0; i < today.length; i++) {
            const u = today[i];
            const winRate = u.total > 0 ? `  Win: ${u.wins}/${u.total} (${Math.round(u.wins / u.total * 100)}%)` : "";
            text += `${medal(i)} ${nameOf(u)}  *${sign(u.pnlUsdt)}${u.pnlUsdt.toFixed(2)} USDT*${winRate}\n`;
          }
        }

        text += `\n📊 *Tong Cong (All-time):*\n`;
        if (allTime.length === 0) {
          text += `_Chua co giao dich_\n`;
        } else {
          for (let i = 0; i < allTime.length; i++) {
            const u = allTime[i];
            const winRate = u.total > 0 ? `  Win: ${u.wins}/${u.total} (${Math.round(u.wins / u.total * 100)}%)` : "";
            text += `${medal(i)} ${nameOf(u)}  *${sign(u.pnlUsdt)}${u.pnlUsdt.toFixed(2)} USDT*${winRate}\n`;
          }
        }

        text += `\n━━━━━━━━━━━━━━━━━━\n_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;
        await this.telegramService.sendTelegramMessage(chatId, text);
      } catch (err) {
        await this.telegramService.sendTelegramMessage(chatId, `❌ Loi lay xep hang: ${err?.message}`);
      }
    });

    // Inline keyboard callback handler for close confirmations
    this.telegramService.registerCallbackHandler(async (query) => {
      const chatId = query.message?.chat.id;
      const messageId = query.message?.message_id;
      const fromId = query.from?.id;
      if (!chatId) return;

      const data = query.data ?? "";

      if (data === "close_cancel") {
        await this.telegramService.answerCallbackQuery(query.id, "Da huy.");
        if (messageId) await this.telegramService.deleteMessage(chatId, messageId);
        return;
      }

      if (data.startsWith("close_all:")) {
        const telegramId = parseInt(data.split(":")[1]);
        if (isNaN(telegramId) || fromId !== telegramId) return;

        await this.telegramService.answerCallbackQuery(query.id, "Dang dong...");
        if (messageId) await this.telegramService.deleteMessage(chatId, messageId);

        try {
          const realClosed = await this.userRealTradingService.closeAllRealPositions(telegramId, chatId, "MANUAL");
          await this.telegramService.sendTelegramMessage(chatId, `✅ *Da dong ${realClosed} lenh that*`);
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi dong lenh: ${err?.message}`);
        }
        return;
      }

      if (data.startsWith("close_sig:")) {
        const parts = data.split(":");
        const symbol = parts[1];
        const telegramId = parseInt(parts[2]);
        if (!symbol || isNaN(telegramId) || fromId !== telegramId) return;

        await this.telegramService.answerCallbackQuery(query.id, "Dang dong...");
        if (messageId) await this.telegramService.deleteMessage(chatId, messageId);

        try {
          const result = await this.userRealTradingService.closeRealPosition(telegramId, chatId, symbol, "MANUAL");
          let resultText = `✅ *Da dong ${symbol}*\n`;
          if (result.success && result.pnlPct !== undefined) {
            const sign = result.pnlPct >= 0 ? "+" : "";
            resultText += `⚡ *${sign}${result.pnlPct.toFixed(2)}%*\n`;
          }
          await this.telegramService.sendTelegramMessage(chatId, resultText);
        } catch (err) {
          await this.telegramService.sendTelegramMessage(chatId, `❌ Loi dong lenh: ${err?.message}`);
        }
        return;
      }
    });

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

    const TEST_VOL = 1000; // Fixed test volume for PnL display
    const getVol = (symbol: string, isTest?: boolean) =>
      isTest ? TEST_VOL : this.getVolForSymbol(symbol, opts?.coinVolumes, opts?.tradingBalance);
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
      // Use buildHealthCheck (skips redundant DB query) with 3s timeout per signal
      const withTimeout = (p: Promise<any>, ms: number) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
      const healthResults = await Promise.allSettled(
        actives.map((s) => withTimeout(this.statsService.buildHealthCheck(s as any), 3000)),
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
          const v = getVol(actives[i].symbol, actives[i].isTestMode);
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
        const v = getVol(s.symbol, s.isTestMode);
        const health = healthResults[i].status === "fulfilled"
          ? (healthResults[i] as PromiseFulfilledResult<any>).value
          : null;
        const dirIcon = s.direction === "LONG" ? "🟢" : "🔴";
        const heldMs = s.executedAt ? Date.now() - s.executedAt.getTime() : 0;
        const heldH = Math.floor(heldMs / 3600000);
        const heldM = Math.floor((heldMs % 3600000) / 60000);
        const heldStr = heldH >= 24
          ? `${Math.floor(heldH / 24)}d${heldH % 24}h`
          : heldH > 0 ? `${heldH}h${heldM}m` : `${heldM}m`;
        const createdStr = s.executedAt
          ? s.executedAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })
          : "";
        const tpPct = getTpPct(s);
        const slPct = getSlPct(s);
        const tpPrice = getTpPrice(s);
        const slPrice = getSlPrice(s);
        const tpUsdt = (tpPct / 100) * v;
        const slUsdt = (slPct / 100) * v;

        text += `\n┌ ${dirIcon} *${s.symbol}* ${s.direction} · ${heldStr}${createdStr ? ` · _${createdStr}_` : ""} · _Vol ${v.toLocaleString()} USDT_\n`;

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
    text += `_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;

    return text;
  }

  /**
   * Format user's own open trades for /ai signals (real trading mode).
   */
  private async formatUserTradesMessage(telegramId: number): Promise<string> {
    const trades = await this.userRealTradingService.getOpenTrades(telegramId);

    if (trades.length === 0) {
      return `📊 *My Trades*\n━━━━━━━━━━━━━━━━━━\n\n_Chua co lenh nao dang mo._`;
    }

    const fmtPrice = (p: number) =>
      p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
      p >= 1 ? `$${p.toFixed(2)}` :
      p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(6)}`;

    let totalPnlUsdt = 0;
    let totalNotional = 0;
    let winning = 0;
    let losing = 0;

    // Pre-compute PnL for each trade
    const tradeData: { trade: typeof trades[0]; currentPrice: number; pnlPct: number; pnlUsdt: number }[] = [];
    for (const trade of trades) {
      const currentPrice = this.marketDataService.getLatestPrice(trade.symbol) || 0;
      const pnlPct = currentPrice > 0
        ? trade.direction === "LONG"
          ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
          : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100
        : 0;
      const pnlUsdt = (pnlPct / 100) * trade.notionalUsdt;
      totalPnlUsdt += pnlUsdt;
      totalNotional += trade.notionalUsdt;
      if (pnlPct >= 0) winning++; else losing++;
      tradeData.push({ trade, currentPrice, pnlPct, pnlUsdt });
    }

    const totalPnlPct = totalNotional > 0 ? (totalPnlUsdt / totalNotional) * 100 : 0;

    let text = `📊 *My Trades* (${trades.length} open)\n━━━━━━━━━━━━━━━━━━\n`;

    const totalIcon = totalPnlUsdt >= 0 ? "📗" : "📕";
    const totalSign = totalPnlUsdt >= 0 ? "+" : "";
    text += `\n${totalIcon} Tong PnL: *${totalSign}${totalPnlPct.toFixed(2)}%* (*${totalSign}${totalPnlUsdt.toFixed(2)} USDT*)`;
    text += ` · ✅ ${winning} 🟢  ❌ ${losing} 🔴\n`;

    for (const { trade, currentPrice, pnlPct, pnlUsdt } of tradeData) {
      const dirIcon = trade.direction === "LONG" ? "🟢" : "🔴";
      const heldMs = trade.openedAt ? Date.now() - new Date(trade.openedAt).getTime() : 0;
      const heldH = Math.floor(heldMs / 3600000);
      const heldM = Math.floor((heldMs % 3600000) / 60000);
      const heldStr = heldH >= 24
        ? `${Math.floor(heldH / 24)}d${heldH % 24}h`
        : heldH > 0 ? `${heldH}h${heldM}m` : `${heldM}m`;

      const pnlIcon = pnlPct >= 0 ? "📗" : "📕";
      const pnlSign = pnlPct >= 0 ? "+" : "";
      const usdSign = pnlUsdt >= 0 ? "+" : "";

      text += `\n┌ ${dirIcon} *${trade.symbol}* ${trade.direction} · ${heldStr} · _x${trade.leverage}_\n`;
      text += `│ ${pnlIcon} *${pnlSign}${pnlPct.toFixed(2)}%* (*${usdSign}${pnlUsdt.toFixed(2)} USDT*)`;
      if (currentPrice > 0) text += ` · Now ${fmtPrice(currentPrice)}`;
      text += `\n`;
      text += `│ Entry  ${fmtPrice(trade.entryPrice)} · Vol ${trade.notionalUsdt.toFixed(0)} USDT\n`;
      if (trade.tpPrice) text += `│ TP     ${fmtPrice(trade.tpPrice)}\n`;
      text += `│ SL     ${fmtPrice(trade.slPrice)}\n`;
      text += `└─────────────────\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━\n`;
    text += `_${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}_`;

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
      const _to = (p: Promise<any>, ms: number) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
      const healthResults = await Promise.allSettled(
        actives.map((s) => _to(this.statsService.buildHealthCheck(s as any), 3000)),
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
            const sigKey = this.getSignalKey(actives[i]);
            await this.signalQueueService
              .resolveActiveSignal(sigKey, exitPrice, "AUTO_TAKE_PROFIT")
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

  private getSignalKey(signal: { symbol: string; timeframeProfile?: string; coin?: string }): string {
    const coin = (signal.coin || signal.symbol.replace("USDT", "")).toUpperCase();
    const profile = signal.timeframeProfile;
    if (DUAL_TIMEFRAME_COINS.includes(coin) && profile) {
      return `${signal.symbol}:${profile}`;
    }
    return signal.symbol;
  }

  private isAdmin(telegramId?: number): boolean {
    if (!telegramId) return false;
    if (this.adminIds.length === 0) return true; // no admin restriction configured
    return this.adminIds.includes(telegramId);
  }
}
