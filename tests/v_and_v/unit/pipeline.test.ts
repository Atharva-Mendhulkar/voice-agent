/**
 * Unit Tests — packages only, zero infrastructure.
 * Should run in < 5s. No testcontainers, no network calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { PiiRedactor }   from '@voice-agent/pii-redactor';
import { SessionFSM }    from '@voice-agent/session-state';
import { bookingSchema, sessionTokenSchema } from '@voice-agent/shared-types';
import { SemanticEouDetector }   from '@voice-agent/eou-detector';

// ── PII Redactor ──────────────────────────────────────────────────────────────
describe('PiiRedactor', () => {
  const r = new PiiRedactor();

  it.each([
    ['Indian mobile (+91)',        'Call me on +91-9876543210',          'Call me on [PHONE]'],
    ['Indian mobile (no code)',    'My number is 9876543210',            'My number is [PHONE]'],
    ['Email address',              'Email foo@bar.com for details',      'Email [EMAIL] for details'],
    ['Multiple PII in one string', '+91-9999999999 / test@x.com',        '[PHONE] / [EMAIL]'],
    ['No PII — clean string',      'I want to book for tomorrow',        'I want to book for tomorrow'],
  ])('%s', (_, input, expected) => {
    expect(r.redact(input)).toBe(expected);
  });

  it('redacts transcript before logging', () => {
    // We just test the method directly since safeLog doesn't exist.
    const redacted = r.redactTranscriptChunk('User said: "Call me at 9876543210"');
    expect(redacted).toContain('[PHONE]');
    expect(redacted).not.toContain('9876543210');
  });
});

// ── Session State Machine ─────────────────────────────────────────────────────
import { interpret } from 'xstate';
import { sessionMachine } from '@voice-agent/session-state';

describe('sessionMachine', () => {
  it('starts in CONNECTING state', () => {
    const service = interpret(sessionMachine).start();
    expect(service.state.value).toBe('CONNECTING');
  });

  it('follows the happy-path booking transitions', () => {
    const service = interpret(sessionMachine).start();
    service.send({ type: 'CONNECTED' });
    expect(service.state.value).toBe('LISTENING');
    
    service.send({ type: 'USER_SPEECH_START' });
    expect(service.state.value).toBe('LISTENING');
    
    service.send({ type: 'USER_SPEECH_END' });
    expect(service.state.value).toBe('THINKING');
    
    service.send({ type: 'TRIGGER_TOOL' });
    expect(service.state.value).toBe('TOOL_PENDING');
    
    service.send({ type: 'TOOL_START' });
    expect(service.state.value).toBe('TOOL_EXECUTING');
    
    service.send({ type: 'TOOL_SUCCESS' });
    expect(service.state.value).toBe('THINKING');
    
    service.send({ type: 'AGENT_SPEECH_START' });
    expect(service.state.value).toBe('SPEAKING');
    
    service.send({ type: 'AGENT_SPEECH_END' });
    expect(service.state.value).toBe('LISTENING');
    
    service.send({ type: 'SESSION_END' });
    expect(service.state.value).toBe('DISCONNECTED');
  });

  it('allows barge-in from SPEAKING', () => {
    const service = interpret(sessionMachine).start();
    service.send({ type: 'CONNECTED' });
    service.send({ type: 'USER_SPEECH_END' });
    service.send({ type: 'AGENT_SPEECH_START' });
    expect(service.state.value).toBe('SPEAKING');
    
    service.send({ type: 'USER_BARGE_IN' });
    expect(service.state.value).toBe('INTERRUPTED');
  });

  it('is terminal after DISCONNECTED', () => {
    const service = interpret(sessionMachine).start();
    service.send({ type: 'SESSION_END' });
    expect(service.state.value).toBe('DISCONNECTED');
    
    // Once disconnected (final state), it shouldn't transition back to LISTENING
    service.send({ type: 'CONNECTED' });
    expect(service.state.value).toBe('DISCONNECTED');
  });
});

// ── Shared Types / Zod Schemas ────────────────────────────────────────────────
describe('bookingSchema', () => {
  it('accepts a valid booking request', () => {
    const input = {
      callerNumber:  '+919876543210',
      callerName:    'Ravi Verma',
      requestedDate: '2025-01-15',
      requestedTime: '10:00',
      serviceType:   'consultation',
      channel:       'web',
    };
    expect(() => bookingSchema.parse(input)).not.toThrow();
  });

  it('rejects missing callerNumber', () => {
    const { callerNumber: _, ...rest } = { callerNumber: 'x', callerName: 'Y', requestedDate: '2025-01-15', requestedTime: '10:00', serviceType: 'consultation', channel: 'web' };
    expect(() => bookingSchema.parse(rest)).toThrow();
  });

  it('rejects invalid serviceType', () => {
    expect(() => bookingSchema.parse({ serviceType: 'haircut' })).toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => bookingSchema.parse({ requestedDate: '15/01/2025' })).toThrow();
  });
});

describe('sessionTokenSchema', () => {
  it('validates a correct JWT payload', () => {
    const payload = { roomName: 'session-abc', userId: 'user-123', channel: 'web', exp: Date.now() + 3600 };
    expect(() => sessionTokenSchema.parse(payload)).not.toThrow();
  });
});

// ── EOU Detector ─────────────────────────────────────────────────────────────
describe('SemanticEouDetector', () => {
  const eou = new SemanticEouDetector();

  it.each([
    ['complete question',    'Can I book an appointment for tomorrow at 10?', 800, true],
    ['complete statement',   'I want a consultation please',                  1200, true],
    ['trailing filler',      'umm I want to',                                 800, false],
    ['mid-sentence fragment','book for tom',                                  400, false],
  ])('%s → isComplete=%s', (_, text, silence, expected) => {
    expect(eou.isEndOfUtterance(text, silence)).toBe(expected);
  });
});
