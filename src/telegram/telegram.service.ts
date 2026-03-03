import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import TelegramBot = require("node-telegram-bot-api");

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

    if (!token) {
      this.logger.error(
        "TELEGRAM_BOT_TOKEN is not set in environment variables",
      );
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.setupCommands();
    await this.registerBotMenu();
  }

  private setupCommands() {
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const firstName = msg.from?.first_name || "ban";
      await this.sendTelegramMessage(
        chatId,
        `👋 Xin chao *${firstName}*!\n\n` +
          `🧠 *AI Signal Bot* — He thong phan tich thi truong crypto tu dong bang AI.\n\n` +
          `Bot su dung Claude AI de:\n` +
          `• Phan tich xu huong thi truong theo thoi gian thuc\n` +
          `• Chon chien luoc phu hop (RSI, EMA, Stoch, BB...)\n` +
          `• Phat tin hieu LONG/SHORT kem Stop Loss & Take Profit\n` +
          `• Ho tro 2 khung thoi gian: Intraday (15m) va Swing (4h)\n\n` +
          `─────────────────────\n` +
          `📬 *Dang ky tin hieu*\n` +
          `/ai subscribe — Dang ky nhan tin hieu\n` +
          `/ai unsubscribe — Huy dang ky\n` +
          `/ai push on|off — Auto push tin hieu moi 10 phut\n\n` +
          `💹 *Giao dich that (Real Mode)*\n` +
          `/ai setkeys — Luu Binance API keys\n` +
          `/ai realmode — Xem/bat/tat dat lenh that\n` +
          `/ai realmode leverage AI|MAX|10 — Chon he so don bay\n` +
          `/ai realmode target 5 — Dat muc tieu loi nhuan +5%/ngay\n` +
          `/ai realmode stoploss 3 — Dat gioi han lo -3%/ngay\n` +
          `/ai realmode stats — Chi tiet lenh va P&L hom nay\n` +
          `/ai account — Vi the mo & unrealized PnL\n\n` +
          `⚙️ *Cai dat*\n` +
          `/ai settings — Xem cai dat hien tai\n` +
          `/ai balance <so> — Set balance mac dinh (USDT/lenh)\n` +
          `/ai moneyflow on|off — Bat/tat canh bao dong tien\n\n` +
          `🌍 *Phan tich thi truong*\n` +
          `/ai market — Phan tich thi truong AI\n` +
          `/ai signals — Xem tat ca tin hieu dang chay\n` +
          `/ai check <SYMBOL> — Kiem tra tin hieu (vd: BTC)\n` +
          `/ai close all — Dong tat ca lenh (co xac nhan)\n` +
          `/ai close <SYMBOL> — Dong mot lenh cu the\n\n` +
          `📊 *Quan tri (Admin)*\n` +
          `/ai status — Trang thai he thong\n` +
          `/ai stats — Thong ke hieu suat tin hieu\n` +
          `/ai params <SYMBOL> — Xem tham so AI cua coin\n` +
          `/ai snapshot — Tao/cap nhat daily snapshot\n` +
          `/ai test on|off — Bat/tat che do test\n` +
          `/ai pause / /ai resume — Tam dung/tiep tuc\n` +
          `/ai override — Override chien luoc\n` +
          `/ai resetall — Reset tat ca tin hieu\n\n` +
          `─────────────────────\n` +
          `💡 *Huong dan nhanh:*\n` +
          `1. /ai subscribe — bat dau nhan tin hieu\n` +
          `2. /ai market — xem AI danh gia thi truong\n` +
          `3. (Tuy chon) /ai setkeys + /ai realmode on — dat lenh that tu dong\n` +
          `4. /ai signals — theo doi tat ca tin hieu dang chay\n\n` +
          `⚠️ _Tin hieu AI chi mang tinh tham khao. Giao dich tiem an rui ro._`,
      );
    });
  }

  /**
   * Register bot command menu with Telegram (BotFather setMyCommands).
   * Auto-updates the command autocomplete menu on every startup.
   */
  private async registerBotMenu() {
    try {
      // First delete ALL existing commands (including ones set via BotFather)
      await this.bot.deleteMyCommands();

      // Then set the new command menu
      await this.bot.setMyCommands([
        { command: "start", description: "Gioi thieu bot va huong dan su dung" },
        { command: "ai", description: "Danh sach tat ca lenh AI" },
        // Signal subscription
        { command: "ai_subscribe", description: "Dang ky nhan tin hieu AI" },
        { command: "ai_unsubscribe", description: "Huy dang ky tin hieu AI" },
        { command: "ai_push", description: "Auto push tin hieu moi 10 phut" },
        // Real trading mode
        { command: "ai_setkeys", description: "Luu Binance API keys" },
        { command: "ai_realmode", description: "Xem/bat/tat dat lenh that" },
        // Settings
        { command: "ai_settings", description: "Xem cai dat hien tai" },
        { command: "ai_balance", description: "Set balance mac dinh (USDT/lenh)" },
        { command: "ai_moneyflow", description: "Bat/tat canh bao dong tien" },
        // Market & signals
        { command: "ai_market", description: "Phan tich thi truong AI" },
        { command: "ai_signals", description: "Xem tin hieu dang chay" },
        { command: "ai_check", description: "Kiem tra tin hieu coin" },
        { command: "ai_account", description: "Vi the mo va PnL real mode" },
        { command: "ai_close", description: "Dong lenh (all hoac SYMBOL)" },
        // Admin
        { command: "ai_status", description: "Trang thai he thong (admin)" },
        { command: "ai_stats", description: "Thong ke hieu suat (admin)" },
        { command: "ai_params", description: "Xem tham so AI cua coin (admin)" },
        { command: "ai_snapshot", description: "Tao/cap nhat daily snapshot (admin)" },
        { command: "ai_override", description: "Override chien luoc (admin)" },
        { command: "ai_test", description: "Bat/tat che do test (admin)" },
        { command: "ai_pause", description: "Tam dung tin hieu (admin)" },
        { command: "ai_resume", description: "Tiep tuc tin hieu (admin)" },
        { command: "ai_resetall", description: "Reset tat ca tin hieu (admin)" },
      ]);
      this.logger.log("[Telegram] Bot command menu updated successfully (old commands cleared)");
    } catch (err) {
      this.logger.warn(`[Telegram] Failed to set bot commands: ${err?.message}`);
    }
  }

  // ─── Public helpers for external modules ─────────────────────────────────

  /**
   * Register an additional bot command from outside this class.
   * Used by AiCommandService to add /ai commands without circular dependency.
   */
  public registerBotCommand(
    pattern: RegExp,
    handler: (msg: any, match: RegExpExecArray | null) => Promise<void>,
  ): void {
    if (!this.bot) {
      const interval = setInterval(() => {
        if (this.bot) {
          clearInterval(interval);
          this.bot.onText(pattern, handler);
        }
      }, 500);
      return;
    }
    this.bot.onText(pattern, handler);
  }

  /**
   * Send a Telegram message to a specific chat.
   * Used by all external modules (AiSignal, etc.).
   */
  public async sendTelegramMessage(
    chatId: number,
    text: string,
    options: { parse_mode?: "Markdown" | "HTML" | "MarkdownV2" } = {
      parse_mode: "Markdown",
    },
  ): Promise<void> {
    if (!this.bot || !chatId) return;
    try {
      await this.bot.sendMessage(chatId, text, options);
    } catch (err) {
      // If Markdown parsing fails, retry as plain text
      if (
        options.parse_mode &&
        err?.message?.includes("parse")
      ) {
        this.logger.warn(
          `[Telegram] Markdown parse failed for ${chatId}, retrying as plain text`,
        );
        try {
          await this.bot.sendMessage(chatId, text);
        } catch (retryErr) {
          this.logger.warn(
            `[Telegram] Plain text retry also failed: ${retryErr?.message}`,
          );
        }
        return;
      }
      this.logger.warn(
        `[Telegram] Failed to send message to ${chatId}: ${err?.message}`,
      );
    }
  }

  /**
   * Send a message with an inline keyboard (for confirmation dialogs).
   */
  public async sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: { text: string; callback_data: string }[][],
  ): Promise<void> {
    if (!this.bot || !chatId) return;
    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
      } as any);
    } catch (err) {
      this.logger.warn(`[Telegram] sendMessageWithKeyboard failed: ${err?.message}`);
    }
  }

  /**
   * Register a callback_query handler (for inline keyboard button presses).
   */
  public registerCallbackHandler(
    handler: (query: TelegramBot.CallbackQuery) => Promise<void>,
  ): void {
    if (!this.bot) {
      const interval = setInterval(() => {
        if (this.bot) {
          clearInterval(interval);
          this.bot.on("callback_query", handler);
        }
      }, 500);
      return;
    }
    this.bot.on("callback_query", handler);
  }

  /**
   * Acknowledge a callback_query (removes the loading spinner on the button).
   * Pass optional text to show a toast notification to the user.
   */
  public async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.answerCallbackQuery(queryId, text ? { text, show_alert: false } : {});
    } catch {
      // ignore — query may have already expired
    }
  }

  /**
   * Delete a Telegram message by chatId and messageId.
   */
  public async deleteMessage(chatId: number, messageId: number): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.deleteMessage(chatId, messageId);
    } catch (err) {
      this.logger.warn(
        `[Telegram] Failed to delete message ${messageId} in chat ${chatId}: ${err?.message}`,
      );
    }
  }
}
