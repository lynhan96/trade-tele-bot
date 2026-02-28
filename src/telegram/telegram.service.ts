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
  }

  private setupCommands() {
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const firstName = msg.from?.first_name || "bạn";
      await this.sendTelegramMessage(
        chatId,
        `👋 Xin chào *${firstName}*!\n\n` +
          `🧠 *AI Signal Bot* — Hệ thống phân tích thị trường crypto tự động.\n\n` +
          `Bot sử dụng AI để:\n` +
          `• Phân tích xu hướng thị trường theo thời gian thực\n` +
          `• Chọn chiến lược phù hợp (RSI, EMA, Stoch, BB...)\n` +
          `• Phát tín hiệu LONG/SHORT kèm Stop Loss & Take Profit\n` +
          `• Hỗ trợ 2 khung thời gian: Intraday (15m) và Swing (4h)\n\n` +
          `─────────────────────\n` +
          `📋 *Lệnh sử dụng:*\n\n` +
          `📬 *Đăng ký tín hiệu*\n` +
          `/ai subscribe — Đăng ký nhận tín hiệu mới\n` +
          `/ai unsubscribe — Hủy đăng ký\n\n` +
          `📊 *Xem thông tin*\n` +
          `/ai — Danh sách tất cả lệnh\n\n` +
          `─────────────────────\n` +
          `💡 *Hướng dẫn nhanh:*\n` +
          `1. Dùng /ai subscribe để bắt đầu nhận tín hiệu\n` +
          `2. Khi có tín hiệu mới, bot sẽ gửi thông báo kèm entry, SL, TP\n` +
          `3. Theo dõi và tự quản lý lệnh theo tín hiệu\n\n` +
          `⚠️ _Lưu ý: Tín hiệu chỉ mang tính tham khảo. Giao dịch tiềm ẩn rủi ro._`,
      );
    });
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
      this.logger.warn(
        `[Telegram] Failed to send message to ${chatId}: ${err?.message}`,
      );
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
