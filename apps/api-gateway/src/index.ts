import Fastify, { FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formBody from '@fastify/formbody';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { AccessToken, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { createRedisClient, TenantConfigCache } from '@voice-agent/redis-client';
import { createDbClient, TenantScopedDb } from '@voice-agent/db-client';
import twilio from 'twilio';
import postgres from 'postgres';
import { Redis } from 'ioredis';

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

// Convert wss:// to https:// for the REST API clients
const livekitHttpHost = livekitHost.replace('wss://', 'https://').replace('ws://', 'http://');
const roomService = new RoomServiceClient(livekitHttpHost, livekitApiKey, livekitApiSecret);
const agentDispatch = new AgentDispatchClient(livekitHttpHost, livekitApiKey, livekitApiSecret);
const agentName = process.env.LIVEKIT_AGENT_NAME || 'voice-agent';

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim();
}

function getPublicUrl(request: FastifyRequest): string {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (baseUrl) {
    return new URL(request.raw.url || '/', baseUrl).toString();
  }

  const protocol = getFirstHeaderValue(request.headers['x-forwarded-proto'] as string | string[] | undefined) || 'http';
  const host =
    getFirstHeaderValue(request.headers['x-forwarded-host'] as string | string[] | undefined) ||
    request.headers.host ||
    `localhost:${port}`;
  return `${protocol}://${host}${request.raw.url}`;
}

function validateTwilioSignature(request: FastifyRequest, params: Record<string, any>) {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  if (!twilioAuthToken) {
    return { valid: true, skipped: true, url: getPublicUrl(request) };
  }

  const signature = request.headers['x-twilio-signature'] as string | undefined;
  if (!signature) {
    return { valid: false, statusCode: 400, error: 'Missing X-Twilio-Signature header', url: getPublicUrl(request) };
  }

  const url = getPublicUrl(request);
  const valid = twilio.validateRequest(twilioAuthToken, signature, url, params);
  return { valid, statusCode: valid ? undefined : 403, error: valid ? undefined : 'Invalid Twilio Signature', url };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function withSipTransport(sipUri: string): string {
  if (/;transport=/i.test(sipUri)) {
    return sipUri;
  }
  return `${sipUri};transport=tls`;
}

export async function createApp({
  db,
  redis,
  temporalClient,
}: {
  db: postgres.Sql;
  redis: Redis;
  temporalClient?: TemporalClient;
}) {
  const fastify = Fastify({
    logger: process.env.API_GATEWAY_LOG_LEVEL === 'silent' || process.env.NODE_ENV === 'test' ? false : true,
  });

  await fastify.register(cors, {
    origin: '*',
  });
  await fastify.register(formBody);

  const scopedDb = new TenantScopedDb(db);
  const configCache = new TenantConfigCache(redis);
  
  const temporal = temporalClient || null;

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

    // Create the room explicitly on LiveKit server with metadata
    const roomMetadata = JSON.stringify({ tenantId, channel, callerId: callerId || null });
    await roomService.createRoom({
      name: roomId,
      emptyTimeout: 300,     // 5 min grace if no one joins
      departureTimeout: 30,  // 30s after last participant leaves
      metadata: roomMetadata,
    });

    // Explicitly dispatch the agent to this room
    await agentDispatch.createDispatch(roomId, agentName, {
      metadata: roomMetadata,
    });

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

    if (!config) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    return config;
  });

  fastify.get('/health', async () => {
    try {
      await db`SELECT 1`;
      await redis.ping();
      return {
        status: 'ok',
        checks: {
          db: { status: 'ok' },
          redis: { status: 'ok' },
        }
      };
    } catch (e) {
      return {
        status: 'error',
        error: (e as Error).message,
      };
    }
  });

  fastify.post('/api/v1/webhooks/twilio', async (request, reply) => {
    const params = (request.body || {}) as Record<string, any>;
    const validation = validateTwilioSignature(request, params);

    if (!validation.valid) {
      fastify.log.warn({ url: validation.url }, validation.error);
      return reply.status(validation.statusCode || 403).send({ error: validation.error });
    }

    if (validation.skipped) {
      fastify.log.warn('TWILIO_AUTH_TOKEN is not set. Skipping Twilio signature validation.');
    }

    fastify.log.info({ params }, 'Received Twilio Webhook status callback');

    // Extract status and update db session if call ended
    const callSid = params.CallSid;
    const parentCallSid = params.ParentCallSid;
    const callStatus = params.CallStatus; // 'completed', 'failed', etc.

    const terminalStatuses = new Set(['completed', 'failed', 'no-answer', 'busy', 'canceled']);

    if (callSid && terminalStatuses.has(callStatus)) {
      try {
        const [session] = await db`
          SELECT id FROM sessions
          WHERE metadata->>'callSid' = ${callSid}
             OR metadata->>'parentCallSid' = ${callSid}
             OR metadata->>'callSid' = ${parentCallSid || ''}
             OR metadata->>'parentCallSid' = ${parentCallSid || ''}
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

  fastify.post('/api/v1/webhooks/twilio/whatsapp-voice', async (request, reply) => {
    const params = (request.body || {}) as Record<string, any>;
    const validation = validateTwilioSignature(request, params);

    if (!validation.valid) {
      fastify.log.warn({ url: validation.url }, validation.error);
      return reply.status(validation.statusCode || 403).send({ error: validation.error });
    }

    if (validation.skipped) {
      fastify.log.warn('TWILIO_AUTH_TOKEN is not set. Skipping Twilio signature validation.');
    }

    let sipUri = process.env.LIVEKIT_SIP_URI;
    if (!sipUri) {
      fastify.log.error('LIVEKIT_SIP_URI is not set. Cannot route WhatsApp voice call.');
      return reply.status(500).send({ error: 'LIVEKIT_SIP_URI is required' });
    }

    const dialedNumber = (params.To || '').replace('whatsapp:', '').replace('+', '');
    if (dialedNumber && sipUri.startsWith('sip:')) {
      sipUri = sipUri.replace('sip:', `sip:${dialedNumber}@`);
    }

    const callSid = params.CallSid;
    const tenantId = process.env.TWILIO_DEFAULT_TENANT_ID || process.env.DEFAULT_TENANT_ID;
    if (tenantId && callSid) {
      try {
        const [existing] = await db`
          SELECT id FROM sessions
          WHERE metadata->>'callSid' = ${callSid}
          LIMIT 1
        `;

        if (!existing) {
          await db`
            INSERT INTO sessions (
              tenant_id,
              room_id,
              channel,
              caller_id,
              state,
              metadata
            ) VALUES (
              ${tenantId},
              ${`twilio-${callSid}`},
              'whatsapp',
              ${params.From || null},
              'CONNECTING',
              ${{
                callSid,
                from: params.From || null,
                to: params.To || null,
                direction: params.Direction || null,
                callType: params.CallType || 'whatsapp',
              } as any}
            )
          `;
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to persist inbound WhatsApp voice session metadata');
      }
    } else if (!tenantId) {
      fastify.log.warn('TWILIO_DEFAULT_TENANT_ID is not set. WhatsApp voice session metadata will not be persisted.');
    }

    const callbackUrl =
      process.env.TWILIO_SIP_STATUS_CALLBACK_URL ||
      new URL('/api/v1/webhooks/twilio', process.env.TWILIO_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL || validation.url).toString();

    const twiml = `
      <Response>
        <Dial>
          <Sip statusCallbackEvent="initiated ringing answered completed" statusCallback="${escapeXml(callbackUrl)}" statusCallbackMethod="POST">${escapeXml(withSipTransport(sipUri))}</Sip>
        </Dial>
      </Response>
    `;
    return reply.type('text/xml').send(twiml);
  });

  return fastify;
}

async function bootstrap() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking';
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  const redis = createRedisClient(redisUrl);
  const db = createDbClient(dbUrl);

  let temporalClient: TemporalClient | undefined;
  try {
    const temporalConnection = await Connection.connect({ address: temporalAddress });
    temporalClient = new TemporalClient({
      connection: temporalConnection,
    });
    console.log('Connected to Temporal successfully');
  } catch (err) {
    console.warn(`Warning: Could not connect to Temporal at ${temporalAddress}. Workflows will not be dispatchable:`, (err as Error).message);
  }

  const app = await createApp({ db, redis, temporalClient });

  console.log(`Starting API Gateway on port ${port}...`);
  await app.listen({ port, host: '0.0.0.0' });
}

// Only run bootstrap if executed directly, not when imported as a module for testing
if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('Fatal error starting API Gateway:', err);
    process.exit(1);
  });
}
