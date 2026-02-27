import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  UserSignalSubscription,
  UserSignalSubscriptionDocument,
} from "../schemas/user-signal-subscription.schema";

export interface SubscriberInfo {
  telegramId: number;
  chatId: number;
  username?: string;
}

@Injectable()
export class UserSignalSubscriptionService {
  private readonly logger = new Logger(UserSignalSubscriptionService.name);

  constructor(
    @InjectModel(UserSignalSubscription.name)
    private readonly subscriptionModel: Model<UserSignalSubscriptionDocument>,
  ) {}

  /**
   * Subscribe a user to AI signal notifications.
   * Idempotent — re-activates if previously unsubscribed.
   */
  async subscribe(telegramId: number, chatId: number, username?: string): Promise<boolean> {
    const existing = await this.subscriptionModel.findOne({ telegramId });

    if (existing) {
      if (existing.isActive) return false; // already subscribed
      await this.subscriptionModel.findByIdAndUpdate(existing._id, {
        isActive: true,
        chatId,
        username,
        subscribedAt: new Date(),
        unsubscribedAt: undefined,
      });
      this.logger.log(`[SignalSubscription] Re-subscribed user ${telegramId}`);
      return true;
    }

    await this.subscriptionModel.create({
      telegramId,
      chatId,
      username,
      isActive: true,
      subscribedAt: new Date(),
    });
    this.logger.log(`[SignalSubscription] New subscriber: ${telegramId} (${username ?? "no username"})`);
    return true;
  }

  /**
   * Unsubscribe a user from AI signal notifications.
   */
  async unsubscribe(telegramId: number): Promise<boolean> {
    const existing = await this.subscriptionModel.findOne({ telegramId });
    if (!existing || !existing.isActive) return false;

    await this.subscriptionModel.findByIdAndUpdate(existing._id, {
      isActive: false,
      unsubscribedAt: new Date(),
    });
    this.logger.log(`[SignalSubscription] Unsubscribed user ${telegramId}`);
    return true;
  }

  /**
   * Get all active subscribers. Used by AiSignalService to broadcast notifications.
   */
  async findAllActive(): Promise<SubscriberInfo[]> {
    const docs = await this.subscriptionModel.find({ isActive: true }).lean();
    return docs.map((d) => ({
      telegramId: d.telegramId,
      chatId: d.chatId,
      username: d.username,
    }));
  }

  /**
   * Check subscription status for a given user.
   */
  async isSubscribed(telegramId: number): Promise<boolean> {
    const doc = await this.subscriptionModel.findOne({ telegramId, isActive: true });
    return !!doc;
  }

  /**
   * Count total active subscribers.
   */
  async countActive(): Promise<number> {
    return this.subscriptionModel.countDocuments({ isActive: true });
  }
}
