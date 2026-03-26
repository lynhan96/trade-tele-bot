import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";
import { AdminAuthService } from "./admin-auth.service";
import { TradingConfigService } from "../ai-signal/trading-config";
import type { TradingConfig } from "../ai-signal/trading-config";
import { UserRealTradingService } from "../ai-signal/user-real-trading.service";

@Controller("admin")
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly authService: AdminAuthService,
    private readonly tradingConfig: TradingConfigService,
    private readonly userRealTradingService: UserRealTradingService,
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
  @Get("ai-reviews")
  getAiReviews(@Query() query: Record<string, string>) {
    return this.adminService.getAiReviews(query);
  }

  @UseGuards(AdminGuard)
  @Patch("signals/:id")
  updateSignal(@Param("id") id: string, @Body() dto: Record<string, unknown>) {
    return this.adminService.updateSignal(id, dto);
  }

  @UseGuards(AdminGuard)
  @Post("signals/:id/close")
  closeSignal(@Param("id") id: string, @Headers("x-source") source?: string) {
    return this.adminService.closeSignal(id, source);
  }

  @UseGuards(AdminGuard)
  @Post("signals/close-all")
  closeAllSignals() {
    return this.adminService.closeAllSignals();
  }

  @UseGuards(AdminGuard)
  @Post("signals/:id/hedge")
  forceOpenHedge(@Param("id") id: string) {
    return this.adminService.forceOpenHedge(id);
  }

  @UseGuards(AdminGuard)
  @Post("signals/:id/close-hedge")
  forceCloseHedge(@Param("id") id: string, @Headers("x-source") source?: string) {
    return this.adminService.forceCloseHedge(id, source);
  }

  @UseGuards(AdminGuard)
  @Get("signals/:id/orders")
  getSignalOrders(@Param("id") id: string) {
    return this.adminService.getSignalOrders(id);
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
  @Put("users/:telegramId/api-keys/:exchange")
  setUserApiKeys(
    @Param("telegramId") telegramId: string,
    @Param("exchange") exchange: string,
    @Body() dto: { apiKey: string; apiSecret: string; passphrase?: string },
  ) {
    return this.adminService.setUserApiKeys(
      parseInt(telegramId, 10),
      exchange as 'binance' | 'okx',
      dto,
    );
  }

  @UseGuards(AdminGuard)
  @Delete("users/:telegramId/api-keys/:exchange")
  removeUserApiKeys(
    @Param("telegramId") telegramId: string,
    @Param("exchange") exchange: string,
  ) {
    return this.adminService.removeUserApiKeys(
      parseInt(telegramId, 10),
      exchange as 'binance' | 'okx',
    );
  }

  @UseGuards(AdminGuard)
  @Get("trades/stats")
  getTradeStats(@Query() query: Record<string, string>) {
    return this.adminService.getTradeStats(query);
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

  @UseGuards(AdminGuard)
  @Get("coins/stats")
  getCoinStats(@Query() query: Record<string, string>) {
    return this.adminService.getCoinStats(query);
  }

  @UseGuards(AdminGuard)
  @Post("coins/:coin/override")
  setCoinOverride(@Param("coin") coin: string, @Body() body: { action: 'blacklist' | 'whitelist' | 'clear' }) {
    return this.adminService.setCoinOverride(coin, body.action);
  }

  // ─── Trading Config ──────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get("trading-config")
  getTradingConfig() {
    return { config: this.tradingConfig.get() };
  }

  @UseGuards(AdminGuard)
  @Patch("trading-config")
  async updateTradingConfig(@Body() body: Partial<TradingConfig>) {
    const updated = await this.tradingConfig.update(body);
    return { config: updated };
  }

  @UseGuards(AdminGuard)
  @Get("orders")
  getOrders(@Query() query: any) {
    return this.adminService.getOrders(query);
  }

  @UseGuards(AdminGuard)
  @Get("onchain-snapshots")
  getOnChainSnapshots(@Query() query: any) {
    return this.adminService.getOnChainSnapshots(query);
  }

  @UseGuards(AdminGuard)
  @Get("account-pnl")
  getAccountPnl() {
    return this.userRealTradingService.getAllAccountPnl();
  }

  @UseGuards(AdminGuard)
  @Post("trading-config/reset")
  async resetTradingConfig() {
    const config = await this.tradingConfig.reset();
    return { config };
  }

  // ─── Agent Dashboard ──────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get("agent/events")
  getAgentEvents(@Query() query: any) {
    return this.adminService.getAgentEvents(query);
  }

  @UseGuards(AdminGuard)
  @Get("agent/status")
  getAgentStatus() {
    return this.adminService.getAgentStatus();
  }

  @UseGuards(AdminGuard)
  @Get("agent/learnings")
  getAgentLearnings() {
    return this.adminService.getAgentLearnings();
  }

  @Post("agent/events")
  createAgentEvent(@Body() dto: any) {
    // No auth required — agent calls this internally
    return this.adminService.createAgentEvent(dto);
  }

  @Post("agent/market-hints")
  setMarketHints(@Body() dto: { takerBuyCoins?: string[]; takerSellCoins?: string[]; takerDetails?: Record<string, number> }) {
    return this.adminService.setMarketHints(dto);
  }

  @Get("agent/market-hints")
  getMarketHints() {
    return this.adminService.getMarketHints();
  }

  @Post("agent/brain")
  setAgentBrain(@Body() dto: any) {
    // Agent sends all insights in one payload — stored in Redis for bot strategy
    return this.adminService.setAgentBrain(dto);
  }

  @Get("agent/brain")
  getAgentBrain() {
    return this.adminService.getAgentBrain();
  }
}
