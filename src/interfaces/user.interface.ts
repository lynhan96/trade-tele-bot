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
