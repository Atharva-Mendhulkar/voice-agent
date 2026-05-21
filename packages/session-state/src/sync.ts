import { Redis } from 'ioredis';
import { SessionContext } from './machine.js';

export class SessionStateSync {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private getKey(roomId: string): string {
    return `session:state:${roomId}`;
  }

  async saveState(roomId: string, state: string, context: SessionContext): Promise<void> {
    const key = this.getKey(roomId);
    const data = {
      state,
      context,
      updatedAt: Date.now(),
    };
    await this.redis.set(key, JSON.stringify(data), 'EX', 86400);
  }

  async loadState(roomId: string): Promise<{ state: string; context: SessionContext } | null> {
    const key = this.getKey(roomId);
    const val = await this.redis.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as { state: string; context: SessionContext };
    } catch (err) {
      console.error(`Failed to parse session state from Redis for room ${roomId}:`, err);
      return null;
    }
  }

  async deleteState(roomId: string): Promise<void> {
    const key = this.getKey(roomId);
    await this.redis.del(key);
  }
}
