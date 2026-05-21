import Fastify from 'fastify';
import cors from '@fastify/cors';
import formBody from '@fastify/formbody';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { AccessToken } from 'livekit-server-sdk';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { createRedisClient, TenantConfigCache } from '@voice-agent/redis-client';
import { createDbClient, TenantScopedDb } from '@voice-agent/db-client';
import twilio from 'twilio';

// Try standard dotenv config first
dotenv.config();

// Also try loading from the root of the workspace if a key we expect isn't set
if (!process.env.LIVEKIT_URL && !process.env.LIVEKIT_HOST) {
  const possiblePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '../..', '.env'),
    path.resolve(process.cwd(), '../../..', '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '../..', '.env'),
    path.resolve(__dirname, '../../..', '.env'),
  ];
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      break;
    }
  }
}

const port = parseInt(process.env.PORT || '8000', 10);
const livekitApiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const livekitHost = process.env.LIVEKIT_HOST || process.env.LIVEKIT_URL || 'ws://localhost:7800';

async function bootstrap() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: '*',
  });
  await fastify.register(formBody);

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking';
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  const redis = createRedisClient(redisUrl);
  const db = createDbClient(dbUrl);
  const scopedDb = new TenantScopedDb(db);
  const configCache = new TenantConfigCache(redis);

  let temporal: TemporalClient | null = null;
  try {
    const temporalConnection = await Connection.connect({ address: temporalAddress });
    temporal = new TemporalClient({
      connection: temporalConnection,
    });
    console.log('Connected to Temporal successfully');
  } catch (err) {
    console.warn(`Warning: Could not connect to Temporal at ${temporalAddress}. Workflows will not be dispatchable:`, (err as Error).message);
  }

  fastify.post('/api/sessions', async (request, reply) => {
    const { tenantId, channel = 'web', callerId } = request.body as {
      tenantId: string;
      channel?: string;
      callerId?: string;
    };

    if (!tenantId) {
      return reply.status(400).send({ error: 'tenantId is required' });
    }

    const roomId = `room-${crypto.randomUUID()}`;
    const identity = `user-${crypto.randomUUID()}`;

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity,
    });
    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
    });
    const token = await at.toJwt();

    await scopedDb.runTenantScoped(tenantId, async (tx) => {
      await tx`
        INSERT INTO sessions (
          tenant_id,
          room_id,
          channel,
          caller_id,
          state
        ) VALUES (
          ${tenantId},
          ${roomId},
          ${channel},
          ${callerId || null},
          'CONNECTING'
        )
      `;
    });

    return {
      token,
      roomId,
      serverUrl: livekitHost,
    };
  });

  fastify.post('/api/bookings/cancel', async (request, reply) => {
    const { tenantId, confirmationCode, roomId } = request.body as {
      tenantId: string;
      confirmationCode: string;
      roomId: string;
    };

    if (!tenantId || !confirmationCode || !roomId) {
      return reply.status(400).send({ error: 'tenantId, confirmationCode, and roomId are required' });
    }

    if (!temporal) {
      return reply.status(503).send({ error: 'Temporal workflow engine is offline' });
    }

    await temporal.workflow.start('CancellationWorkflow', {
      taskQueue: 'booking-queue',
      workflowId: `cancel-http-${roomId}-${Date.now()}`,
      args: [
        {
          roomId,
          tenantId,
          confirmationCode,
        },
      ],
    });

    return { success: true, message: 'Cancellation workflow dispatched' };
  });

  fastify.get('/api/tenants/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const config = await configCache.get(id, async (tid) => {
      return scopedDb.runTenantScoped(tid, async (tx) => {
        const [row] = await tx`SELECT * FROM tenants WHERE id = ${tid}`;
        console.log('API GATEWAY FETCHED DB ROW FOR TENANT:', row);
        if (!row) return null;
        const tenantConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        return {
          tenantId: row.id,
          name: row.name,
          slug: row.slug,
          calendarId: tenantConfig?.calendarId || '',
          voiceId: tenantConfig?.voiceId || '',
          systemPrompt: tenantConfig?.systemPrompt || '',
          voiceModel: tenantConfig?.voiceModel || 'sonic-english',
          sttLanguage: tenantConfig?.sttLanguage || 'en-US',
          createdAt: row.createdAt?.toISOString(),
          updatedAt: row.updatedAt?.toISOString(),
        };
      });
    });

    console.log('API GATEWAY CONFIG FROM CACHE/DB:', config);
    if (!config) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    return config;
  });

  fastify.get('/health', async () => {
    return { status: 'OK' };
  });

  fastify.post('/api/v1/webhooks/twilio', async (request, reply) => {
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = request.headers['x-twilio-signature'] as string;
    
    const protocol = (request.headers['x-forwarded-proto'] as string) || 'http';
    const host = request.headers.host || `localhost:${port}`;
    const url = `${protocol}://${host}${request.raw.url}`;

    const params = (request.body || {}) as Record<string, any>;

    if (twilioAuthToken) {
      if (!signature) {
        return reply.status(400).send({ error: 'Missing X-Twilio-Signature header' });
      }
      
      const isValid = twilio.validateRequest(twilioAuthToken, signature, url, params);
      if (!isValid) {
        fastify.log.warn({ url, signature }, 'Invalid Twilio Signature');
        return reply.status(403).send({ error: 'Invalid Twilio Signature' });
      }
    } else {
      fastify.log.warn('TWILIO_AUTH_TOKEN is not set. Skipping Twilio signature validation.');
    }

    fastify.log.info({ params }, 'Received Twilio Webhook status callback');

    // Extract status and update db session if call ended
    const callSid = params.CallSid;
    const callStatus = params.CallStatus; // 'completed', 'failed', etc.

    if (callSid && (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer')) {
      try {
        const [session] = await db`
          SELECT id FROM sessions
          WHERE metadata->>'callSid' = ${callSid}
          LIMIT 1
        `;

        if (session) {
          await db`
            UPDATE sessions
            SET state = 'DISCONNECTED', ended_at = NOW()
            WHERE id = ${session.id}
          `;
          fastify.log.info({ sessionId: session.id, callSid }, 'Marked session as disconnected via Twilio status callback');
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to update session status on Twilio webhook');
      }
    }

    reply.type('text/xml');
    return '<Response></Response>';
  });

  console.log(`Starting API Gateway on port ${port}...`);
  await fastify.listen({ port, host: '0.0.0.0' });
}

bootstrap().catch((err) => {
  console.error('Fatal error starting API Gateway:', err);
  process.exit(1);
});
