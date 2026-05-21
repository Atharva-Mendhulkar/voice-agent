import { Redis, RedisOptions } from 'ioredis';

export function createRedisClient(url: string, options?: RedisOptions): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    ...options,
  });
}

export class ActiveSessionsTracker {
  private client: Redis;
  private readonly key = 'keda:active_sessions';

  constructor(client: Redis) {
    this.client = client;
  }

  async incrementActiveSessions(): Promise<number> {
    return this.client.incr(this.key);
  }

  async decrementActiveSessions(): Promise<number> {
    const val = await this.client.decr(this.key);
    if (val < 0) {
      await this.client.set(this.key, 0);
      return 0;
    }
    return val;
  }

  async getActiveSessions(): Promise<number> {
    const val = await this.client.get(this.key);
    return val ? parseInt(val, 10) : 0;
  }
}
