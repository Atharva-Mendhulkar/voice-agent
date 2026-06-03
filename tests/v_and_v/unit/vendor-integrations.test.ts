import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../apps/api-gateway/src/index';
import { createActivities } from '../../../workers/temporal-worker/src/activities/index';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function makeRedisMock() {
  const redis: any = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn(),
  };
  redis.duplicate = vi.fn(() => redis);
  return redis;
}

function makeSqlMock(options: { overlap?: any[]; failBookingInsert?: boolean; sessionRows?: any[] } = {}) {
  const calls: Array<{ sql: string; values: any[] }> = [];

  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join('?');
    calls.push({ sql, values });

    if (sql.includes('SELECT id FROM bookings')) {
      return options.overlap || [];
    }

    if (sql.includes('SELECT id FROM sessions')) {
      return options.sessionRows || [];
    }

    if (sql.includes('INSERT INTO bookings')) {
      if (options.failBookingInsert) {
        throw new Error('db insert failed');
      }
      return [{ id: 'booking-1', confirmationCode: 'CONF-123456' }];
    }

    return [];
  }) as any;

  tag.begin = vi.fn(async (fn: any) => fn(tag));
  return { sql: tag, calls };
}

describe('Twilio and WhatsApp voice webhooks', () => {
  it('returns TwiML that bridges WhatsApp voice to LiveKit SIP with status callbacks', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.LIVEKIT_SIP_URI = 'sip:voice-agent@sip.livekit.cloud';
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://voice.example.com';
    process.env.TWILIO_DEFAULT_TENANT_ID = '11111111-1111-1111-1111-111111111111';

    const { sql, calls } = makeSqlMock();
    const app = await createApp({ db: sql, redis: makeRedisMock() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/twilio/whatsapp-voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        CallSid: 'CA_parent_001',
        From: 'whatsapp:+919876543210',
        To: 'whatsapp:+918001234567',
        Direction: 'inbound',
        CallType: 'whatsapp',
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.payload).toContain('<Dial>');
    expect(res.payload).toContain('sip:voice-agent@sip.livekit.cloud;transport=tls');
    expect(res.payload).toContain('statusCallback="https://voice.example.com/api/v1/webhooks/twilio"');
    expect(res.payload).toContain('statusCallbackEvent="initiated ringing answered completed"');
    expect(calls.some((call) => call.sql.includes('INSERT INTO sessions'))).toBe(true);

    await app.close();
  });

  it('requires a Twilio signature on WhatsApp voice webhooks when TWILIO_AUTH_TOKEN is set', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.LIVEKIT_SIP_URI = 'sip:voice-agent@sip.livekit.cloud';

    const { sql } = makeSqlMock();
    const app = await createApp({ db: sql, redis: makeRedisMock() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/twilio/whatsapp-voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ CallSid: 'CA_parent_001' }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Missing X-Twilio-Signature header' });

    await app.close();
  });

  it('updates a telephony session using either child CallSid or ParentCallSid', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const { sql, calls } = makeSqlMock({ sessionRows: [{ id: 'session-1' }] });
    const app = await createApp({ db: sql, redis: makeRedisMock() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        CallSid: 'CA_child_001',
        ParentCallSid: 'CA_parent_001',
        CallStatus: 'completed',
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(calls.some((call) => call.sql.includes("SET state = 'DISCONNECTED'"))).toBe(true);

    await app.close();
  });
});

describe('Google Calendar and Twilio activity integration', () => {
  it('queries Google FreeBusy using the requested appointment timezone', async () => {
    const { sql } = makeSqlMock();
    const googleCalendar = {
      freebusy: {
        query: vi.fn().mockResolvedValue({ data: { calendars: { 'cal-1': { busy: [] } } } }),
      },
      events: {
        insert: vi.fn(),
        delete: vi.fn(),
      },
    };

    const activities = createActivities({
      db: sql,
      redis: makeRedisMock(),
      googleCalendar,
    });

    await activities.checkCalendarAvailability({
      tenantId: '11111111-1111-1111-1111-111111111111',
      calendarId: 'cal-1',
      date: '2026-06-03',
      time: '10:00',
      timezone: 'Asia/Kolkata',
    });

    expect(googleCalendar.freebusy.query).toHaveBeenCalledWith({
      requestBody: expect.objectContaining({
        timeMin: '2026-06-03T04:30:00.000Z',
        timeMax: '2026-06-03T05:00:00.000Z',
        timeZone: 'Asia/Kolkata',
      }),
    });
  });

  it('throws when Google Calendar event insert fails instead of creating a local-only booking', async () => {
    const { sql, calls } = makeSqlMock();
    const googleCalendar = {
      freebusy: { query: vi.fn() },
      events: {
        insert: vi.fn().mockRejectedValue(new Error('calendar unavailable')),
        delete: vi.fn(),
      },
    };

    const activities = createActivities({
      db: sql,
      redis: makeRedisMock(),
      googleCalendar,
    });

    await expect(
      activities.createBookingRecord({
        tenantId: '11111111-1111-1111-1111-111111111111',
        calendarId: 'cal-1',
        attendeeEmail: 'guest@example.com',
        attendeeName: 'Guest',
        date: '2026-06-03',
        time: '10:00',
        timezone: 'Asia/Kolkata',
      })
    ).rejects.toThrow(/Google Calendar events\.insert failed/);

    expect(calls.some((call) => call.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  it('deletes a Google event if the local booking insert fails after Calendar insert', async () => {
    const { sql } = makeSqlMock({ failBookingInsert: true });
    const googleCalendar = {
      freebusy: { query: vi.fn() },
      events: {
        insert: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };

    const activities = createActivities({
      db: sql,
      redis: makeRedisMock(),
      googleCalendar,
    });

    await expect(
      activities.createBookingRecord({
        tenantId: '11111111-1111-1111-1111-111111111111',
        calendarId: 'cal-1',
        attendeeEmail: 'guest@example.com',
        attendeeName: 'Guest',
        date: '2026-06-03',
        time: '10:00',
        timezone: 'Asia/Kolkata',
      })
    ).rejects.toThrow(/db insert failed/);

    expect(googleCalendar.events.delete).toHaveBeenCalledWith({ calendarId: 'cal-1', eventId: 'evt-1' });
  });

  it('throws on Twilio WhatsApp send failures when a Twilio client is configured', async () => {
    const { sql } = makeSqlMock();
    const twilioClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('twilio unavailable')),
      },
    };

    const activities = createActivities({
      db: sql,
      redis: makeRedisMock(),
      googleCalendar: null,
      twilioClient,
    });

    await expect(
      activities.sendWhatsAppConfirmation({
        to: '+919876543210',
        name: 'Guest',
        startTime: '2026-06-03T04:30:00.000Z',
        confirmationCode: 'CONF-123456',
      })
    ).rejects.toThrow(/twilio unavailable/);
  });
});
