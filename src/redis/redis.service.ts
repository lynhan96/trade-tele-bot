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
    if (this.client?.isOpen) {
      await this.client.quit();
    }
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

  /** Atomic SET-if-NOT-EXISTS with TTL. Returns true if key was set (lock acquired). */
  async setNX(key: string, value: any, ttl: number): Promise<boolean> {
    const fullKey = this.getKey(key);
    const serialized = JSON.stringify(value);
    const result = await this.client.set(fullKey, serialized, {
      NX: true,
      EX: ttl,
    });
    return result === "OK";
  }

  /** Atomic increment. Returns the new value. */
  async incr(key: string): Promise<number> {
    return this.client.incr(this.getKey(key));
  }

  /** Atomic decrement. Returns the new value. */
  async decr(key: string): Promise<number> {
    return this.client.decr(this.getKey(key));
  }

  /**
   * Atomic init-and-increment: if key doesn't exist, set it to `initValue` with TTL,
   * then increment and return the new value. Prevents race conditions.
   */
  async initAndIncr(key: string, initValue: number, ttl: number): Promise<number> {
    const fullKey = this.getKey(key);
    const script = `
      local exists = redis.call('EXISTS', KEYS[1])
      if exists == 0 then
        redis.call('SET', KEYS[1], ARGV[1])
        redis.call('EXPIRE', KEYS[1], ARGV[2])
      end
      return redis.call('INCR', KEYS[1])
    `;
    return this.client.eval(script, {
      keys: [fullKey],
      arguments: [initValue.toString(), ttl.toString()],
    }) as Promise<number>;
  }

  async keys(pattern: string): Promise<string[]> {
    const fullPattern = this.getKey(pattern);
    const allKeys: string[] = [];
    let cursor = 0;
    do {
      const result = await this.client.scan(cursor, {
        MATCH: fullPattern,
        COUNT: 100,
      });
      cursor = result.cursor;
      allKeys.push(...result.keys);
    } while (cursor !== 0);
    return allKeys;
  }
}
