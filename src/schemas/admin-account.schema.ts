import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AdminAccountDocument = AdminAccount & Document;

@Schema({ collection: "admin_accounts", timestamps: true })
export class AdminAccount {
  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ default: "admin" })
  role: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  lastLoginAt?: Date;
}

export const AdminAccountSchema = SchemaFactory.createForClass(AdminAccount);
