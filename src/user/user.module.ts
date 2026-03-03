import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  UserSettings,
  UserSettingsSchema,
} from "../schemas/user-settings.schema";
import { UserSettingsService } from "./user-settings.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserSettings.name, schema: UserSettingsSchema },
    ]),
  ],
  providers: [UserSettingsService],
  exports: [UserSettingsService],
})
export class UserModule {}
