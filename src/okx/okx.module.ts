import { Module } from "@nestjs/common";
import { OkxService } from "./okx.service";

@Module({
  providers: [OkxService],
  exports: [OkxService],
})
export class OkxModule {}
