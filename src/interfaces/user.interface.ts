export interface UserApiKeys {
  telegramId: number;
  chatId: number;
  apiKey: string;
  apiSecret: string;
  passphrase?: string; // For OKX
  exchange: "binance" | "okx";
  createdAt: string;
}

export interface UserActiveExchange {
  exchange: "binance" | "okx";
  setAt: string;
}

export interface UserBotConfig {
  botType: string; // e.g. "BOT_FUTURE_CT_1"
  enabled: boolean;
  volume: number; // USDT volume per order
  leverage: number; // Leverage multiplier
  enabledAt: string; // ISO timestamp
  takeProfitPercent?: number; // TP % from entry price (e.g. 5 = 5%)
  stopLossPercent?: number; // SL % from entry price (e.g. 3 = 3%)
}

export interface UserBotsConfig {
  bots: UserBotConfig[];
  updatedAt: string;
}
