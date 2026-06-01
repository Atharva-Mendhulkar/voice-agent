/**
 * TestHarness — boots and tears down the real infrastructure
 * (PostgreSQL, Redis, Temporal) used by integration & E2E tests.
 *
 * AI services (Deepgram, OpenAI, Cartesia, Google Calendar, Twilio)
 * are always mocked at the HTTP boundary via nock — never hit in CI.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer,     StartedRedisContainer }     from '@testcontainers/redis';
import { TestWorkflowEnvironment }                        from '@temporalio/testing';
import { Redis }                                          from 'ioredis';
import postgres                                           from 'postgres';
import nock                                               from 'nock';
import { runMigrations, createDbClient }                  from '@voice-agent/db-client';

export interface HarnessContext {
  pg:          postgres.Sql;
  redis:       Redis;
  temporal:    TestWorkflowEnvironment;
  apiBaseUrl:  string;
}

export class TestHarness {
  private pgContainer!:    StartedPostgreSqlContainer;
  private redisContainer!: StartedRedisContainer;
  private ctx!:            HarnessContext;

  async start(): Promise<HarnessContext> {
    console.log('[harness] starting test infrastructure...');

    // ── Postgres ──────────────────────────────────────────────────────────────
    this.pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg15')
      .withDatabase('voice_booking')
      .withUsername('postgres')
      .withPassword('test')
      .start();

    const pgUrl = this.pgContainer.getConnectionUri();
    const dbClient = createDbClient(pgUrl);
    await runMigrations(dbClient);  // Run all migrations against blank DB

    // ── Redis ─────────────────────────────────────────────────────────────────
    this.redisContainer = await new RedisContainer('redis:7-alpine').start();
    const redis = new Redis(this.redisContainer.getConnectionUrl());

    // ── Temporal (in-process, time-skippable) ─────────────────────────────────
    const temporal = await TestWorkflowEnvironment.createLocal();

    // ── Inject env vars so app code picks up test infra ───────────────────────
    process.env.DATABASE_URL = this.pgContainer.getConnectionUri();
    process.env.REDIS_URL    = this.redisContainer.getConnectionUrl();

    // ── Start API Gateway pointed at test infra ───────────────────────────────
    const { createApp } = await import('../../../apps/api-gateway/src/index');
    const app = await createApp({
      db:           dbClient,
      redis,
      temporalClient: temporal.client,
    });
    await app.listen({ port: 0 });  // Random port
    const apiBaseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;

    this.ctx = { pg: dbClient, redis, temporal, apiBaseUrl };
    return this.ctx;
  }

  async stop(): Promise<void> {
    console.log('[harness] tearing down...');
    nock.cleanAll();
    await this.ctx?.redis.quit();
    await this.ctx?.pg.end();
    await this.ctx?.temporal.teardown();
    await this.redisContainer?.stop();
    await this.pgContainer?.stop();
  }

  /** Assert no dangling Redis keys match a pattern — call after each saga test */
  async assertNoLeaks(pattern: string): Promise<void> {
    const keys = await this.ctx.redis.keys(pattern);
    if (keys.length > 0) {
      throw new Error(`[harness] Redis leak: found keys matching '${pattern}': ${keys.join(', ')}`);
    }
  }
}

export const harness = new TestHarness();
