import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type UserSignalSubscriptionDocument = UserSignalSubscription & Document;

/**
 * Stores which users have subscribed to receive AI signal notifications.
 * Users opt-in via /ai subscribe and opt-out via /ai unsubscribe.
 * Replaces the Redis-scan approach for scalability (supports many users).
 */
@Schema({ collection: "user_signal_subscriptions", timestamps: true })
export class UserSignalSubscription {
  @Prop({ required: true, unique: true })
  telegramId: number; // Telegram user ID

  @Prop({ required: true })
  chatId: number; // Chat ID to send notifications to

  @Prop()
  username?: string; // Telegram username (optional, for display)

  @Prop({ required: true, default: true })
  isActive: boolean; // false = unsubscribed

  @Prop({ required: true, default: new Date() })
  subscribedAt: Date;

  @Prop()
  unsubscribedAt?: Date;
}

export const UserSignalSubscriptionSchema = SchemaFactory.createForClass(
  UserSignalSubscription,
);

// Fast lookup by isActive status (telegramId index already created by unique: true)
UserSignalSubscriptionSchema.index({ isActive: 1 });
