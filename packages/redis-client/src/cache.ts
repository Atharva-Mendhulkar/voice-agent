import { Redis } from 'ioredis';
import { TenantConfig } from '@voice-agent/shared-types';

export class TenantConfigCache {
  private client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private getKey(tenantId: string): string {
    return `config:tenant:${tenantId}`;
  }

  async get(
    tenantId: string,
    fallbackFetcher: (tenantId: string) => Promise<TenantConfig | null>
  ): Promise<TenantConfig | null> {
    const key = this.getKey(tenantId);
    const cached = await this.client.get(key);

    if (cached) {
      try {
        return JSON.parse(cached) as TenantConfig;
      } catch (err) {
        console.error(`Failed to parse cached tenant config for ${tenantId}:`, err);
      }
    }

    const config = await fallbackFetcher(tenantId);
    if (config) {
      await this.client.set(key, JSON.stringify(config), 'EX', 3600);
    }
    return config;
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.client.del(this.getKey(tenantId));
  }
}
