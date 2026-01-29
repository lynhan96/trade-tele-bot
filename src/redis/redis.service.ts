import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, RedisClientType } from "redis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType;
  private readonly prefix = "binance-bot";

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    this.client = createClient({
      socket: {
        host: this.configService.get("REDIS_HOST", "localhost"),
        port: this.configService.get("REDIS_PORT", 6379),
      },
      password: this.configService.get("REDIS_PASSWORD"),
      database: this.configService.get("REDIS_DB", 0),
    });

    this.client.on("error", (err) =>
      this.logger.error("Redis Client Error", err),
    );
    this.client.on("connect", () => this.logger.log("Connected to Redis"));

    await this.client.connect();
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  private getKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const fullKey = this.getKey(key);
    const serialized = JSON.stringify(value);

    if (ttl) {
      await this.client.setEx(fullKey, ttl, serialized);
    } else {
      await this.client.set(fullKey, serialized);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const fullKey = this.getKey(key);
    const value = await this.client.get(fullKey);

    if (!value) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.getKey(key);
    await this.client.del(fullKey);
  }

  async exists(key: string): Promise<boolean> {
    const fullKey = this.getKey(key);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const fullPattern = this.getKey(pattern);
    return await this.client.keys(fullPattern);
  }
}
