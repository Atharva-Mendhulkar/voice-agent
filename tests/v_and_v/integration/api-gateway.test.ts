/**
 * Integration Tests — API Gateway (Fastify)
 *
 * Boots real Fastify instance against testcontainers Postgres + Redis.
 * Temporal client is mocked (workflow dispatch is verified via mock assertions,
 * not actual workflow execution — that lives in booking-saga.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import supertest   from 'supertest';
import { harness, HarnessContext } from '../helpers/harness';
import { buildTwilioWebhookPayload } from '../helpers/mocks';
import { sign } from 'jsonwebtoken';
import { createApp } from '../../../apps/api-gateway/src/index';

let ctx:     HarnessContext;
let request: ReturnType<typeof supertest>;

const TENANT_1_UUID = '11111111-1111-1111-1111-111111111111';
const TENANT_2_UUID = '22222222-2222-2222-2222-222222222222';
const ORIGINAL_LIVEKIT_SIP_URI = process.env.LIVEKIT_SIP_URI;

beforeAll(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.LIVEKIT_SIP_URI = 'sip:your-project-id.sip.livekit.cloud';
  ctx     = await harness.start();
  request = supertest(ctx.apiBaseUrl);

  await ctx.pg`
    INSERT INTO tenants (id, name, slug, config, created_at, updated_at)
    VALUES (${TENANT_1_UUID}, 'Test Tenant 1', 'test-tenant-1', '{"calendarId": "cal1", "voiceId": "voice1"}', NOW(), NOW()),
           (${TENANT_2_UUID}, 'Test Tenant WA', 'test-tenant-wa', '{"calendarId": "cal2", "voiceId": "voice2"}', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  await harness.stop();
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_DEFAULT_TENANT_ID;
  if (ORIGINAL_LIVEKIT_SIP_URI) {
    process.env.LIVEKIT_SIP_URI = ORIGINAL_LIVEKIT_SIP_URI;
  } else {
    delete process.env.LIVEKIT_SIP_URI;
  }
});

// ── POST /api/sessions ────────────────────────────────────────────────────────
describe('POST /api/sessions', () => {
  it('returns a signed JWT with correct claims', async () => {
    const res = await request
      .post('/api/sessions')
      .send({ tenantId: TENANT_1_UUID, channel: 'web' })
      .expect(200);

    expect(res.body.token).toBeDefined();

    // Verify the token contains the required LiveKit room claims
    const decoded = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64').toString());
    expect(decoded).toMatchObject({
      sub:  expect.stringMatching(/^user-/),
      video: {
        room: expect.stringMatching(/^room-/),
      },
    });
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects missing tenantId with 400', async () => {
    await request.post('/api/sessions').send({}).expect(400);
  });

  it('stamps the channel attribute on the room', async () => {
    const waRes = await request
      .post('/api/sessions')
      .send({ tenantId: TENANT_2_UUID, channel: 'whatsapp', callerId: '+919999999999' })
      .expect(200);

    const [session] = await ctx.pg`
      SELECT tenant_id, channel, caller_id, state
      FROM sessions
      WHERE room_id = ${waRes.body.roomId}
    `;
    expect(session).toMatchObject({
      tenantId: TENANT_2_UUID,
      channel: 'whatsapp',
      callerId: '+919999999999',
      state: 'CONNECTING',
    });
  });
});

// ── GET /api/tenants/:id ──────────────────────────────────────────────────────
describe('GET /api/tenants/:id', () => {
  it('returns tenant config for a known tenant', async () => {
    await ctx.pg`
      INSERT INTO tenants (id, name, slug, config, created_at, updated_at) 
      VALUES ('33333333-3333-3333-3333-333333333333', 'Test Tenant', 'test-tenant-3', '{"calendarId": "cal1", "voiceId": "voice1"}', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;

    const res = await request
      .get('/api/tenants/33333333-3333-3333-3333-333333333333')
      .expect(200);

    expect(res.body).toMatchObject({ tenantId: '33333333-3333-3333-3333-333333333333', name: 'Test Tenant', calendarId: 'cal1' });
  });

  it('returns 404 for unknown tenant', async () => {
    await request
      .get('/api/tenants/99999999-9999-9999-9999-999999999999')
      .expect(404);
  });
});

// ── POST /api/bookings/cancel (cancellation dispatch) ─────────────────────────
describe('POST /api/bookings/cancel', () => {
  it('dispatches CancellationWorkflow to Temporal', async () => {
    const temporalSpy = vi.spyOn(ctx.temporal.client.workflow, 'start');

    await request
      .post('/api/bookings/cancel')
      .send({ tenantId: TENANT_1_UUID, confirmationCode: 'ABC', roomId: 'room-1' })
      .expect(200);

    expect(temporalSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workflowId: expect.stringContaining('cancel-http-room-1') })
    );
  });

  it('rejects missing cancellation fields with 400', async () => {
    await request
      .post('/api/bookings/cancel')
      .send({ tenantId: TENANT_1_UUID, confirmationCode: 'ABC' })
      .expect(400);
  });

  it('returns 503 when Temporal is not configured', async () => {
    const app = await createApp({ db: ctx.pg, redis: ctx.redis });
    await app.listen({ port: 0 });
    const offlineRequest = supertest(`http://127.0.0.1:${(app.server.address() as any).port}`);

    try {
      await offlineRequest
        .post('/api/bookings/cancel')
        .send({ tenantId: TENANT_1_UUID, confirmationCode: 'ABC', roomId: 'room-offline' })
        .expect(503);
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/v1/webhooks/twilio ──────────────────────────────────────────────
describe('Twilio Status webhook', () => {
  it('returns empty <Response>', async () => {
    process.env.TWILIO_AUTH_TOKEN = '';
    const res = await request
      .post('/api/v1/webhooks/twilio')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-twilio-signature', 'dummy')
      .send(buildTwilioWebhookPayload({ CallType: 'pstn' }));
    
    if (res.status !== 200) {
      console.error('Twilio Status Webhook failed:', res.body || res.text);
    }
    
    expect(res.status).toBe(200);

    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Response></Response>');
  });

  it('rejects signed webhook mode without a Twilio signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'test-token';

    try {
      await request
        .post('/api/v1/webhooks/twilio')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(buildTwilioWebhookPayload({ CallStatus: 'completed' }))
        .expect(400);
    } finally {
      process.env.TWILIO_AUTH_TOKEN = '';
    }
  });

  it('marks a matched call session disconnected on terminal status', async () => {
    process.env.TWILIO_AUTH_TOKEN = '';
    await ctx.pg`
      INSERT INTO sessions (tenant_id, room_id, channel, caller_id, state, metadata)
      VALUES (
        ${TENANT_2_UUID},
        'room-twilio-terminal',
        'whatsapp',
        '+919876543210',
        'CONNECTED',
        ${{ callSid: 'CA_terminal_001' } as any}
      )
    `;

    await request
      .post('/api/v1/webhooks/twilio')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildTwilioWebhookPayload({ CallSid: 'CA_terminal_001', CallStatus: 'busy' }))
      .expect(200);

    const [session] = await ctx.pg`
      SELECT state, ended_at
      FROM sessions
      WHERE room_id = 'room-twilio-terminal'
    `;
    expect(session.state).toBe('DISCONNECTED');
    expect(session.endedAt).toBeTruthy();
  });
});

// ── POST /api/v1/webhooks/twilio/whatsapp-voice ───────────────────────────────
describe('WhatsApp voice webhook', () => {
  it('returns TwiML routing to LiveKit SIP URI', async () => {
    process.env.TWILIO_AUTH_TOKEN = '';
    const res = await request
      .post('/api/v1/webhooks/twilio/whatsapp-voice')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(buildTwilioWebhookPayload({ CallType: 'whatsapp', From: 'whatsapp:+919876543210' }))
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Sip ');
    expect(res.text).toContain('sip:your-project-id.sip.livekit.cloud;transport=tls');
    expect(res.text).toContain('statusCallbackEvent="initiated ringing answered completed"');
    expect(res.text).toContain('/api/v1/webhooks/twilio');
  });

  it('persists inbound WhatsApp call metadata when a default tenant is configured', async () => {
    process.env.TWILIO_AUTH_TOKEN = '';
    process.env.TWILIO_DEFAULT_TENANT_ID = TENANT_2_UUID;

    try {
      await request
        .post('/api/v1/webhooks/twilio/whatsapp-voice')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(buildTwilioWebhookPayload({ CallSid: 'CA_whatsapp_persist_001', CallType: 'whatsapp' }))
        .expect(200);

      const [session] = await ctx.pg`
        SELECT tenant_id, room_id, channel, caller_id, state, metadata
        FROM sessions
        WHERE metadata->>'callSid' = 'CA_whatsapp_persist_001'
      `;
      expect(session).toMatchObject({
        tenantId: TENANT_2_UUID,
        roomId: 'twilio-CA_whatsapp_persist_001',
        channel: 'whatsapp',
        callerId: 'whatsapp:+919876543210',
        state: 'CONNECTING',
      });
      expect(session.metadata).toMatchObject({
        callSid: 'CA_whatsapp_persist_001',
        callType: 'whatsapp',
      });
    } finally {
      delete process.env.TWILIO_DEFAULT_TENANT_ID;
    }
  });

  it('returns 500 when the LiveKit SIP URI is missing', async () => {
    const originalSipUri = process.env.LIVEKIT_SIP_URI;
    process.env.TWILIO_AUTH_TOKEN = '';
    delete process.env.LIVEKIT_SIP_URI;

    try {
      await request
        .post('/api/v1/webhooks/twilio/whatsapp-voice')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(buildTwilioWebhookPayload({ CallSid: 'CA_missing_sip_uri' }))
        .expect(500);
    } finally {
      if (originalSipUri) {
        process.env.LIVEKIT_SIP_URI = originalSipUri;
      }
    }
  });
});

// ── /health ───────────────────────────────────────────────────────────────────
describe('Health checks', () => {
  it('GET /health returns 200 with DB + Redis status', async () => {
    const res = await request.get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: {
        db:    { status: 'ok' },
        redis: { status: 'ok' },
      },
    });
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────
function makeInternalToken() {
  return sign({ role: 'internal' }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: '5m' });
}
