/**
 * mocks.ts — nock interceptors for all external HTTP services.
 *
 * Each helper is stateless and idempotent. Call the one you need
 * at the top of each test/describe block.
 */
import nock from 'nock';

// ── Deepgram STT ─────────────────────────────────────────────────────────────
export const mockDeepgram = {
  transcript(text: string) {
    return nock('https://api.deepgram.com')
      .post(/\/v1\/listen/)
      .reply(200, {
        results: {
          channels: [{
            alternatives: [{ transcript: text, confidence: 0.99, words: [] }],
          }],
          utterances: [{ transcript: text, start: 0, end: 1.5 }],
        },
      });
  },
  timeout() {
    return nock('https://api.deepgram.com')
      .post(/\/v1\/listen/)
      .replyWithError({ code: 'ETIMEDOUT' });
  },
};

// ── OpenAI LLM ───────────────────────────────────────────────────────────────
export const mockOpenAI = {
  bookingIntent(toolName: string, toolArgs: Record<string, unknown>) {
    return nock('https://api.openai.com')
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_test_001',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(toolArgs) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      });
  },
  text(content: string) {
    return nock('https://api.openai.com')
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'chatcmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      });
  },
  timeout() {
    return nock('https://api.openai.com')
      .post('/v1/chat/completions')
      .delayConnection(35_000)  // Beyond agent timeout
      .reply(408);
  },
};

// ── Cartesia TTS ─────────────────────────────────────────────────────────────
export const mockCartesia = {
  synthesize() {
    // Return 100ms of silence as raw PCM (16-bit LE, 16kHz, mono)
    const silencePcm = Buffer.alloc(16000 * 2 * 0.1);  // 0.1s
    return nock('https://api.cartesia.ai')
      .post(/\/tts\/bytes/)
      .reply(200, silencePcm, { 'Content-Type': 'audio/pcm' });
  },
};

// ── Google Calendar ───────────────────────────────────────────────────────────
export const mockGoogleCalendar = {
  available(slots: Array<{ start: string; end: string }>) {
    return nock('https://www.googleapis.com')
      .post(/\/calendar\/v3\/freeBusy/)
      .reply(200, {
        kind: 'calendar#freeBusy',
        calendars: { primary: { busy: [] } },  // No conflicts
        _availableSlots: slots,
      });
  },
  busy() {
    return nock('https://www.googleapis.com')
      .post(/\/calendar\/v3\/freeBusy/)
      .reply(200, {
        kind: 'calendar#freeBusy',
        calendars: { primary: { busy: [{ start: '2025-01-15T10:00:00Z', end: '2025-01-15T11:00:00Z' }] } },
      });
  },
  createEvent(eventId = 'evt-test-001') {
    return nock('https://www.googleapis.com')
      .post(/\/calendar\/v3\/calendars\/[^/]+\/events/)
      .reply(200, { id: eventId, status: 'confirmed' });
  },
  deleteEvent() {
    return nock('https://www.googleapis.com')
      .delete(/\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+/)
      .reply(200, {});
  },
  failCreate() {
    return nock('https://www.googleapis.com')
      .post(/\/calendar\/v3\/calendars\/[^/]+\/events/)
      .reply(503, { error: { code: 503, message: 'Service Unavailable' } });
  },
};

// ── Twilio (WhatsApp call webhook simulation) ─────────────────────────────────
export function buildTwilioWebhookPayload(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    CallSid:    'CA_test_001',
    From:       'whatsapp:+919876543210',
    To:         'whatsapp:+918001234567',
    CallStatus: 'ringing',
    Direction:  'inbound',
    CallType:   'whatsapp',
    ...overrides,
  }).toString();
}

// ── Shared test fixtures ──────────────────────────────────────────────────────
export const fixtures = {
  bookingRequest: {
    callerNumber: '+919876543210',
    callerName:   'Ravi Verma',
    requestedDate: '2025-01-15',
    requestedTime: '10:00',
    serviceType:   'consultation' as const,
    channel:       'web' as const,
  },
  confirmedSlot: {
    date: '2025-01-15',
    time: '10:00',
    durationMinutes: 60,
    timezone: 'Asia/Kolkata',
  },
};
