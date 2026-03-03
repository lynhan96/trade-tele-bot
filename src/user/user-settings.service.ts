import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  UserSettings,
  UserSettingsDocument,
  ExchangeSettings,
} from "../schemas/user-settings.schema";
import { UserApiKeys } from "../interfaces/user.interface";

export type Exchange = "binance" | "okx";

@Injectable()
export class UserSettingsService {
  constructor(
    @InjectModel(UserSettings.name)
    private readonly model: Model<UserSettingsDocument>,
  ) {}

  /**
   * Save (upsert) API keys for a user + exchange.
   */
  async saveApiKeys(
    telegramId: number,
    chatId: number,
    exchange: Exchange,
    apiKey: string,
    apiSecret: string,
    passphrase?: string,
  ): Promise<void> {
    const exchangeData: Partial<ExchangeSettings> = {
      apiKey,
      apiSecret,
      createdAt: new Date(),
      ...(passphrase !== undefined && { passphrase }),
    };

    await this.model.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          chatId,
          [exchange]: exchangeData,
        },
        $setOnInsert: {
          telegramId,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Return API keys for a user + exchange, or null if not found.
   */
  async getApiKeys(
    telegramId: number,
    exchange: Exchange,
  ): Promise<UserApiKeys | null> {
    const doc = await this.model
      .findOne({ telegramId }, { telegramId: 1, chatId: 1, [exchange]: 1 })
      .lean();

    if (!doc) return null;
    const ex = exchange === "binance" ? doc.binance : doc.okx;
    if (!ex?.apiKey) return null;

    return {
      telegramId: doc.telegramId,
      chatId: doc.chatId,
      apiKey: ex.apiKey,
      apiSecret: ex.apiSecret,
      passphrase: ex.passphrase,
      exchange,
      createdAt: ex.createdAt?.toISOString() ?? new Date().toISOString(),
    };
  }
}
