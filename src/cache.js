import { LRUCache } from "lru-cache";
import { createClient } from "redis";

export async function createDecisionCache(config, logger) {
  if (!config.enabled) {
    return new NoopCache();
  }

  if (config.redisUrl) {
    try {
      const client = createClient({ url: config.redisUrl });
      client.on("error", err => logger.warn({ err }, "redis error"));
      await client.connect();
      return new RedisCache(client, config.ttlMs);
    } catch (err) {
      logger.warn({ err }, "redis unavailable, falling back to memory cache");
    }
  }

  return new MemoryCache(config.maxEntries, config.ttlMs);
}

class NoopCache {
  async get() {
    return null;
  }

  async set() {
    return undefined;
  }
}

class MemoryCache {
  constructor(maxEntries, ttlMs) {
    this.cache = new LRUCache({ max: maxEntries, ttl: ttlMs });
  }

  async get(key) {
    return this.cache.get(key) ?? null;
  }

  async set(key, value) {
    this.cache.set(key, value);
  }
}

class RedisCache {
  constructor(client, ttlMs) {
    this.client = client;
    this.ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
  }

  async get(key) {
    const value = await this.client.get(key);
    return value ?? null;
  }

  async set(key, value) {
    await this.client.setEx(key, this.ttlSec, value);
  }
}
