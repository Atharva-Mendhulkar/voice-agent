import { Redis } from 'ioredis';

export class BookingLockManager {
  private client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  async acquireBookingLock(
    slotId: string,
    tenantId: string,
    requestId: string
  ): Promise<boolean> {
    const key = `lock:booking:${slotId}:${tenantId}`;
    const res = await this.client.set(key, requestId, 'EX', 60, 'NX');
    return res === 'OK';
  }

  async releaseBookingLock(
    slotId: string,
    tenantId: string,
    requestId: string
  ): Promise<void> {
    const key = `lock:booking:${slotId}:${tenantId}`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(luaScript, 1, key, requestId);
  }
}
