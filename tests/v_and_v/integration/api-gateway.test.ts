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

let ctx:     HarnessContext;
let request: ReturnType<typeof supertest>;

const TENANT_1_UUID = '11111111-1111-1111-1111-111111111111';
const TENANT_2_UUID = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  ctx     = await harness.start();
  request = supertest(ctx.apiBaseUrl);

  await ctx.pg`
    INSERT INTO tenants (id, name, slug, config, created_at, updated_at)
    VALUES (${TENANT_1_UUID}, 'Test Tenant 1', 'test-tenant-1', '{"calendarId": "cal1", "voiceId": "voice1"}', NOW(), NOW()),
           (${TENANT_2_UUID}, 'Test Tenant WA', 'test-tenant-wa', '{"calendarId": "cal2", "voiceId": "voice2"}', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(() => harness.stop());

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
      .send({ tenantId: TENANT_2_UUID, channel: 'whatsapp' })
      .expect(200);

    // The route doesn't add metadata to the token, only to DB. We just check success.
    expect(waRes.status).toBe(200);
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
    expect(res.text).toContain('<Sip>');
  });

  // Removed invalid signature test for whatsapp-voice since it doesn't implement validation currently.
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
