import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type UserSettingsDocument = UserSettings & Document;

// ─── Nested: ExchangeSettings ─────────────────────────────────────────────

@Schema({ _id: false })
export class ExchangeSettings {
  @Prop({ required: true })
  apiKey: string;

  @Prop({ required: true })
  apiSecret: string;

  @Prop()
  passphrase?: string; // OKX only

  @Prop({ required: true })
  createdAt: Date;
}

// ─── Root: UserSettings ───────────────────────────────────────────────────

@Schema({ collection: "user_settings", timestamps: true })
export class UserSettings {
  @Prop({ required: true, unique: true, index: true })
  telegramId: number;

  @Prop()
  chatId?: number;

  @Prop({ type: Object })
  binance?: ExchangeSettings;

  @Prop({ type: Object })
  okx?: ExchangeSettings;
}

export const UserSettingsSchema = SchemaFactory.createForClass(UserSettings);
