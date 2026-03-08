import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";
import { AdminAuthService } from "./admin-auth.service";

@Controller("admin")
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly authService: AdminAuthService,
  ) {}

  // ─── Auth (no guard) ──────────────────────────────────────────────────────

  @Post("auth/login")
  login(@Body() body: { username: string; password: string }) {
    return this.authService.login(body.username, body.password);
  }

  @UseGuards(AdminGuard)
  @Post("auth/change-password")
  changePassword(@Body() body: { username: string; oldPassword: string; newPassword: string }) {
    return this.authService.changePassword(body.username, body.oldPassword, body.newPassword);
  }

  @UseGuards(AdminGuard)
  @Get("auth/me")
  me() {
    return { ok: true };
  }

  // ─── Protected routes ─────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get("dashboard")
  getDashboard() {
    return this.adminService.getDashboardStats();
  }

  @UseGuards(AdminGuard)
  @Get("signals")
  getSignals(@Query() query: Record<string, string>) {
    return this.adminService.getSignals(query);
  }

  @UseGuards(AdminGuard)
  @Get("signals/stats")
  getSignalStats(@Query() query: Record<string, string>) {
    return this.adminService.getSignalStats(query);
  }

  @UseGuards(AdminGuard)
  @Get("signals/:id")
  getSignalById(@Param("id") id: string) {
    return this.adminService.getSignalById(id);
  }

  @UseGuards(AdminGuard)
  @Patch("signals/:id")
  updateSignal(@Param("id") id: string, @Body() dto: Record<string, unknown>) {
    return this.adminService.updateSignal(id, dto);
  }

  @UseGuards(AdminGuard)
  @Post("signals/:id/close")
  closeSignal(@Param("id") id: string) {
    return this.adminService.closeSignal(id);
  }

  @UseGuards(AdminGuard)
  @Post("signals/close-all")
  closeAllSignals() {
    return this.adminService.closeAllSignals();
  }

  @UseGuards(AdminGuard)
  @Get("users/ranking")
  getUserRanking(@Query() query: Record<string, string>) {
    return this.adminService.getUserRanking(query);
  }

  @UseGuards(AdminGuard)
  @Get("users")
  getUsers(@Query() query: Record<string, string>) {
    return this.adminService.getUsers(query);
  }

  @UseGuards(AdminGuard)
  @Get("users/:telegramId")
  getUserById(@Param("telegramId") telegramId: string) {
    return this.adminService.getUserById(parseInt(telegramId, 10));
  }

  @UseGuards(AdminGuard)
  @Patch("users/:telegramId")
  updateUser(@Param("telegramId") telegramId: string, @Body() dto: Record<string, unknown>) {
    return this.adminService.updateUser(parseInt(telegramId, 10), dto);
  }

  @UseGuards(AdminGuard)
  @Get("trades")
  getTrades(@Query() query: Record<string, string>) {
    return this.adminService.getTrades(query);
  }

  @UseGuards(AdminGuard)
  @Post("trades/:tradeId/close")
  closeTrade(@Param("tradeId") tradeId: string) {
    return this.adminService.closeTrade(tradeId);
  }

  @UseGuards(AdminGuard)
  @Post("users/:telegramId/trades/close-all")
  closeAllTrades(@Param("telegramId") telegramId: string) {
    return this.adminService.closeAllTrades(parseInt(telegramId, 10));
  }

  @UseGuards(AdminGuard)
  @Get("coin-profiles")
  getCoinProfiles(@Query() query: Record<string, string>) {
    return this.adminService.getCoinProfiles(query);
  }

  @UseGuards(AdminGuard)
  @Patch("coin-profiles/:id")
  updateCoinProfile(@Param("id") id: string, @Body() dto: Record<string, unknown>) {
    return this.adminService.updateCoinProfile(id, dto);
  }

  @UseGuards(AdminGuard)
  @Get("market-configs")
  getMarketConfigs(@Query() query: Record<string, string>) {
    return this.adminService.getMarketConfigs(query);
  }

  @UseGuards(AdminGuard)
  @Get("regime-history")
  getRegimeHistory(@Query() query: Record<string, string>) {
    return this.adminService.getRegimeHistory(query);
  }

  @UseGuards(AdminGuard)
  @Get("snapshots")
  getSnapshots(@Query() query: Record<string, string>) {
    return this.adminService.getSnapshots(query);
  }

  @UseGuards(AdminGuard)
  @Get("validations")
  getValidations(@Query() query: Record<string, string>) {
    return this.adminService.getValidations(query);
  }

  @UseGuards(AdminGuard)
  @Get("validations/stats")
  getValidationStats() {
    return this.adminService.getValidationStats();
  }

  @UseGuards(AdminGuard)
  @Get("cycle-history")
  getCycleHistory(@Query() query: Record<string, string>) {
    return this.adminService.getCycleHistory(query);
  }
}
