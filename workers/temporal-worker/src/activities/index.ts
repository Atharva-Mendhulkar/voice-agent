import postgres from 'postgres';
import { Redis } from 'ioredis';
import { BookingLockManager } from '@voice-agent/redis-client';
import crypto from 'crypto';
import { TenantScopedDb } from '@voice-agent/db-client';
import { WorkflowResultBroker } from '@voice-agent/redis-client';
import { google } from 'googleapis';
import { ApplicationFailure } from '@temporalio/activity';
import twilio from 'twilio';

export interface ActivityContext {
  db: postgres.Sql;
  redis: Redis;
  googleCalendar?: GoogleCalendarClient | null;
  twilioClient?: TwilioMessagesClient | null;
  requireGoogleCalendarSync?: boolean;
  requireTwilioWhatsApp?: boolean;
}

type GoogleCalendarClient = {
  freebusy: {
    query: (params: any) => Promise<{ data: any }>;
  };
  events: {
    insert: (params: any) => Promise<{ data: any }>;
    delete: (params: any) => Promise<any>;
  };
};

type TwilioMessagesClient = {
  messages: {
    create: (params: any) => Promise<any>;
  };
};

function getGoogleCalendar(): GoogleCalendarClient | null {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';

  if (!email || !key) {
    return null;
  }

  // Parse private key if base64 encoded
  if (!key.includes('BEGIN PRIVATE KEY')) {
    try {
      key = Buffer.from(key, 'base64').toString('utf8');
    } catch {
      // Use as is
    }
  }

  // Strip literal surrounding double quotes if present
  key = key.replace(/^["']|["']$/g, '');

  // Replace escaped newlines if any
  key = key.replace(/\\n/g, '\n');

  // Fix common copy-paste errors where newlines are lost and replaced by spaces
  if (key.includes('BEGIN PRIVATE KEY')) {
    // Extract the base64 body
    const bodyMatch = key.replace(/-----BEGIN PRIVATE KEY-----/g, '')
                         .replace(/-----END PRIVATE KEY-----/g, '')
                         .replace(/\s+/g, '');
    
    // Reconstruct the valid PEM format with 64-character lines
    const lines = bodyMatch.match(/.{1,64}/g) || [];
    key = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  }

  try {
    const auth = new google.auth.JWT({
      email,
      key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    return google.calendar({ version: 'v3', auth }) as unknown as GoogleCalendarClient;
  } catch (err) {
    console.error('Failed to initialize Google Calendar client:', err);
    return null;
  }
}

function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return localAsUtc - date.getTime();
}

function zonedDateTimeToDate(date: string, time: string, timeZone = 'UTC'): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  if (!year || !month || !day || hour === undefined || minute === undefined) {
    throw ApplicationFailure.nonRetryable(`Invalid appointment date/time: ${date} ${time}`);
  }

  if (timeZone === 'UTC') {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const firstOffset = getTimeZoneOffsetMs(timeZone, utcGuess);
  let utcDate = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(timeZone, utcDate);

  if (secondOffset !== firstOffset) {
    utcDate = new Date(utcGuess.getTime() - secondOffset);
  }

  return utcDate;
}

export function createActivities(context: ActivityContext) {
  const scopedDb = new TenantScopedDb(context.db);
  const broker = new WorkflowResultBroker(context.redis, context.redis);
  const googleCalendar: GoogleCalendarClient | null =
    context.googleCalendar === undefined ? getGoogleCalendar() : context.googleCalendar;
  const requireGoogleCalendarSync = context.requireGoogleCalendarSync ?? process.env.GOOGLE_CALENDAR_REQUIRED === 'true';

  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const rawTwilioWhatsapp = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';
  const twilioWhatsappNumber = rawTwilioWhatsapp.startsWith('whatsapp:') ? rawTwilioWhatsapp : `whatsapp:${rawTwilioWhatsapp}`;
  const twilioClient =
    context.twilioClient === undefined
      ? twilioAccountSid && twilioAuthToken
        ? twilio(twilioAccountSid, twilioAuthToken)
        : null
      : context.twilioClient;
  const requireTwilioWhatsApp = context.requireTwilioWhatsApp ?? process.env.TWILIO_WHATSAPP_REQUIRED === 'true';

  function ensureGoogleCalendar(): GoogleCalendarClient {
    if (!googleCalendar) {
      throw ApplicationFailure.nonRetryable('Google Calendar client is not configured');
    }
    return googleCalendar;
  }

  return {
    async checkCalendarAvailability(params: {
      tenantId: string;
      calendarId: string;
      date: string;
      time: string;
      durationMinutes?: number;
      timezone?: string;
    }): Promise<{ available: boolean; proposedSlot?: string }> {
      const { tenantId, calendarId, date, time, durationMinutes = 30, timezone = 'UTC' } = params;
      const startTime = zonedDateTimeToDate(date, time, timezone);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Check PostgreSQL first for local collision
      const overlapping = await scopedDb.runTenantScoped(tenantId, async (tx) => {
        return tx`
          SELECT id FROM bookings
          WHERE calendar_id = ${calendarId}
            AND status = 'confirmed'
            AND start_time < ${endTime}
            AND end_time > ${startTime}
          LIMIT 1
        `;
      });

      if (overlapping.length > 0) {
        const proposedTime = new Date(startTime.getTime() + 30 * 60000);
        const proposedString = proposedTime.toISOString().substring(11, 16);
        return { available: false, proposedSlot: proposedString };
      }

      // Query Google Calendar FreeBusy API if configured
      if (googleCalendar || requireGoogleCalendarSync) {
        try {
          const freebusyRes = await ensureGoogleCalendar().freebusy.query({
            requestBody: {
              timeMin: startTime.toISOString(),
              timeMax: endTime.toISOString(),
              timeZone: timezone,
              items: [{ id: calendarId }],
            },
          });
          const busy = freebusyRes.data.calendars?.[calendarId]?.busy || [];
          const errors = freebusyRes.data.calendars?.[calendarId]?.errors || [];
          if (errors.length > 0) {
            throw new Error(`FreeBusy returned calendar errors: ${JSON.stringify(errors)}`);
          }
          if (busy.length > 0) {
            const proposedTime = new Date(startTime.getTime() + 30 * 60000);
            const proposedString = proposedTime.toISOString().substring(11, 16);
            return { available: false, proposedSlot: proposedString };
          }
        } catch (err) {
          throw ApplicationFailure.nonRetryable(`Google Calendar availability check failed: ${(err as Error).message}`);
        }
      }

      return { available: true };
    },

    async holdCalendarSlot(params: {
      calendarId: string;
      date: string;
      time: string;
    }): Promise<{ success: boolean }> {
      const { calendarId, date, time } = params;
      const key = `calendar:hold:${calendarId}:${date}:${time}`;
      const acquired = await context.redis.set(key, 'held', 'EX', 600, 'NX');
      return { success: acquired === 'OK' };
    },

    async releaseCalendarHold(params: {
      calendarId: string;
      date: string;
      time: string;
    }): Promise<{ success: boolean }> {
      const { calendarId, date, time } = params;
      const key = `calendar:hold:${calendarId}:${date}:${time}`;
      await context.redis.del(key);
      return { success: true };
    },

    async releaseSlotInRedis(params: {
      slotId: string;
      tenantId: string;
      requestId: string;
    }): Promise<{ success: boolean }> {
      const lockManager = new BookingLockManager(context.redis);
      await lockManager.releaseBookingLock(params.slotId, params.tenantId, params.requestId);
      return { success: true };
    },

    async createBookingRecord(params: {
      tenantId: string;
      calendarId: string;
      attendeeEmail: string;
      attendeePhone?: string | null;
      attendeeName: string;
      date: string;
      time: string;
      durationMinutes?: number;
      timezone?: string;
      workflowId?: string;
    }): Promise<{ id: string; confirmationCode: string }> {
      const {
        tenantId,
        calendarId,
        attendeeEmail,
        attendeePhone,
        attendeeName,
        date,
        time,
        durationMinutes = 30,
        timezone = 'UTC',
        workflowId,
      } = params;

      const confirmationCode = 'CONF-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const startTime = zonedDateTimeToDate(date, time, timezone);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Insert event into Google Calendar if configured
      let calendarEventId: string = crypto.randomUUID();
      let insertedGoogleEvent = false;
      if (googleCalendar || requireGoogleCalendarSync) {
        try {
          const eventRes = await ensureGoogleCalendar().events.insert({
            calendarId,
            requestBody: {
              summary: `Booking: ${attendeeName}`,
              description: `Confirmed reservation via SHIELD Voice Coordinator.`,
              start: { dateTime: startTime.toISOString(), timeZone: timezone },
              end: { dateTime: endTime.toISOString(), timeZone: timezone },
              extendedProperties: {
                private: {
                  tenantId,
                  workflowId: workflowId || '',
                },
              },
            },
          });
          if (eventRes.data.id) {
            calendarEventId = eventRes.data.id;
            insertedGoogleEvent = true;
          }
        } catch (err) {
          throw ApplicationFailure.nonRetryable(`Google Calendar events.insert failed: ${(err as Error).message}`);
        }
      }

      let row: any;
      try {
        [row] = await scopedDb.runTenantScoped(tenantId, async (tx) => {
          return tx`
            INSERT INTO bookings (
              tenant_id,
              confirmation_code,
              calendar_event_id,
              calendar_id,
              attendee_email,
              attendee_phone,
              attendee_name,
              start_time,
              end_time,
              duration_minutes,
              timezone,
              status,
              temporal_workflow_id
            ) VALUES (
              ${tenantId},
              ${confirmationCode},
              ${calendarEventId},
              ${calendarId},
              ${attendeeEmail},
              ${attendeePhone || null},
              ${attendeeName},
              ${startTime},
              ${endTime},
              ${durationMinutes},
              ${timezone},
              'confirmed',
              ${workflowId || null}
            ) RETURNING id, confirmation_code
          `;
        });
      } catch (err) {
        if (insertedGoogleEvent && googleCalendar) {
          try {
            await googleCalendar.events.delete({ calendarId, eventId: calendarEventId });
          } catch (deleteErr) {
            console.warn('Failed to delete Google Calendar event after DB insert failure:', (deleteErr as Error).message);
          }
        }
        throw err;
      }

      return { id: row.id, confirmationCode: row.confirmationCode };
    },

    async cancelBookingRecord(params: {
      tenantId: string;
      confirmationCode: string;
    }): Promise<{ success: boolean; attendeeEmail?: string; attendeeName?: string; startTime?: string }> {
      const { tenantId, confirmationCode } = params;

      // Retrieve existing booking to delete from Google Calendar and notify attendee
      const [booking] = await scopedDb.runTenantScoped(tenantId, async (tx) => {
        return tx`
          SELECT calendar_id, calendar_event_id, attendee_email, attendee_name, start_time FROM bookings
          WHERE confirmation_code = ${confirmationCode}
          LIMIT 1
        `;
      });

      if (booking && googleCalendar) {
        try {
          await googleCalendar.events.delete({
            calendarId: booking.calendarId,
            eventId: booking.calendarEventId,
          });
        } catch (err) {
          console.warn('Google Calendar events.delete failed during cancellation:', (err as Error).message);
        }
      }

      await scopedDb.runTenantScoped(tenantId, async (tx) => {
        await tx`
          UPDATE bookings
          SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
          WHERE confirmation_code = ${confirmationCode}
        `;
      });

      return {
        success: true,
        attendeeEmail: booking?.attendeeEmail,
        attendeeName: booking?.attendeeName,
        startTime: booking?.startTime ? new Date(booking.startTime).toISOString() : undefined,
      };
    },

    async deleteBookingRecord(params: {
      tenantId: string;
      bookingId: string;
    }): Promise<{ success: boolean }> {
      const { tenantId, bookingId } = params;

      // Retrieve existing booking to delete from Google Calendar
      const [booking] = await scopedDb.runTenantScoped(tenantId, async (tx) => {
        return tx`
          SELECT calendar_id, calendar_event_id FROM bookings
          WHERE id = ${bookingId}
          LIMIT 1
        `;
      });

      if (booking && googleCalendar) {
        try {
          await googleCalendar.events.delete({
            calendarId: booking.calendarId,
            eventId: booking.calendarEventId,
          });
        } catch (err) {
          console.warn('Google Calendar events.delete failed during delete:', (err as Error).message);
        }
      }

      await scopedDb.runTenantScoped(tenantId, async (tx) => {
        await tx`
          DELETE FROM bookings
          WHERE id = ${bookingId}
        `;
      });
      return { success: true };
    },

    async chargePayment(params: {
      attendeeName: string;
      amount?: number;
    }): Promise<{ success: boolean }> {
      const { attendeeName } = params;
      // Simulate Stripe API call - fail if attendeeName contains "Fail Payment"
      if (attendeeName.toLowerCase().includes('fail payment')) {
        throw ApplicationFailure.nonRetryable('Payment gateway declined transaction');
      }
      return { success: true };
    },

    async confirmCalendarSlot(params: {
      calendarId: string;
      date: string;
      time: string;
    }): Promise<{ success: boolean }> {
      // Slot hold is confirmed, delete the temporary Redis hold key
      const { calendarId, date, time } = params;
      const key = `calendar:hold:${calendarId}:${date}:${time}`;
      await context.redis.del(key);
      return { success: true };
    },

    async notifyBroker(params: {
      roomId: string;
      event: any;
    }): Promise<{ success: boolean }> {
      const { roomId, event } = params;
      await broker.publishResult(roomId, event);
      return { success: true };
    },

    async saveTranscriptAndEvents(params: {
      roomId: string;
      tenantId: string;
      transcript: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
    }): Promise<{ success: boolean }> {
      const { roomId, tenantId, transcript } = params;

      await scopedDb.runTenantScoped(tenantId, async (tx) => {
        let sessionId: string;
        const [existingSession] = await tx`
          SELECT id FROM sessions
          WHERE room_id = ${roomId}
          LIMIT 1
        `;

        if (existingSession) {
          sessionId = existingSession.id;
        } else {
          const [newSession] = await tx`
            INSERT INTO sessions (
              tenant_id,
              room_id,
              channel,
              state,
              started_at,
              ended_at
            ) VALUES (
              ${tenantId},
              ${roomId},
              'web',
              'DISCONNECTED',
              NOW(),
              NOW()
            ) RETURNING id
          `;
          sessionId = newSession.id;
        }

        for (let i = 0; i < transcript.length; i++) {
          const turn = transcript[i];
          await tx`
            INSERT INTO transcripts (
              session_id,
              tenant_id,
              role,
              text,
              turn_index,
              timestamp
            ) VALUES (
              ${sessionId},
              ${tenantId},
              ${turn.role},
              ${turn.text},
              ${i},
              ${new Date(turn.ts)}
            )
          `;
        }

        await tx`
          INSERT INTO session_events (
            session_id,
            tenant_id,
            event_type,
            payload
          ) VALUES (
            ${sessionId},
            ${tenantId},
            'call_summarized',
            ${{ turnCount: transcript.length } as any}
          )
        `;
      });

      return { success: true };
    },

    async sendWhatsAppConfirmation(params: {
      to: string;
      name: string;
      startTime: string;
      confirmationCode: string;
    }): Promise<{ success: boolean }> {
      const { to, name, startTime, confirmationCode } = params;
      if (!twilioClient) {
        if (requireTwilioWhatsApp) {
          throw ApplicationFailure.nonRetryable('Twilio WhatsApp client is not configured');
        }
        console.warn('[SIMULATED WHATSAPP] Twilio client not configured. Would send:');
        console.warn(`To: whatsapp:${to}`);
        console.warn(`Body: Hi ${name}, your appointment has been confirmed for ${startTime}. Confirmation Code: ${confirmationCode}. Thank you!`);
        return { success: true };
      }

      try {
        const toFormat = to.startsWith('+') ? to : `+${to}`;
        await twilioClient.messages.create({
          from: twilioWhatsappNumber,
          to: `whatsapp:${toFormat}`,
          body: `Hi ${name},\n\nYour appointment has been confirmed for ${startTime}.\nConfirmation Code: ${confirmationCode}\n\nThank you!`,
        });
        console.log(`WhatsApp confirmation sent to ${toFormat}`);
      } catch (err) {
        console.error('Failed to send WhatsApp message via Twilio:', err);
        throw ApplicationFailure.nonRetryable(`Failed to send WhatsApp message via Twilio: ${(err as Error).message}`);
      }

      return { success: true };
    },

    async sendConfirmationEmail(params: {
      to: string;
      name: string;
      startTime: string;
      confirmationCode: string;
    }): Promise<{ success: boolean }> {
      const { to, name, startTime, confirmationCode } = params;
      const apiKey = process.env.SENDGRID_API_KEY;
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'no-reply@voicebooking.com';

      const subject = `Booking Confirmed: ${confirmationCode}`;
      const text = `Hi ${name},\n\nYour appointment has been confirmed for ${startTime}.\nConfirmation Code: ${confirmationCode}\n\nThank you!`;
      const html = `<p>Hi <strong>${name}</strong>,</p><p>Your appointment has been confirmed for <strong>${startTime}</strong>.</p><p>Confirmation Code: <strong>${confirmationCode}</strong></p><p>Thank you!</p>`;

      if (apiKey) {
        try {
          const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to }] }],
              from: { email: fromEmail, name: 'Voice Booking Coordinator' },
              subject,
              content: [
                { type: 'text/plain', value: text },
                { type: 'text/html', value: html },
              ],
            }),
          });
          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`SendGrid API returned status ${res.status}: ${errBody}`);
          }
          console.log(`✔ Confirmation email sent via SendGrid to ${to}`);
          return { success: true };
        } catch (err) {
          console.error(`Failed to send confirmation email via SendGrid:`, err);
          throw err;
        }
      } else {
        console.log(`[SIMULATED EMAIL] Sending booking confirmation to ${to}:`);
        console.log(`Subject: ${subject}`);
        console.log(`Body: ${text}`);
        return { success: true };
      }
    },

    async sendCancellationEmail(params: {
      to: string;
      name: string;
      startTime: string;
      confirmationCode: string;
    }): Promise<{ success: boolean }> {
      const { to, name, startTime, confirmationCode } = params;
      const apiKey = process.env.SENDGRID_API_KEY;
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'no-reply@voicebooking.com';

      const subject = `Booking Cancelled: ${confirmationCode}`;
      const text = `Hi ${name},\n\nYour appointment scheduled for ${startTime} (Code: ${confirmationCode}) has been successfully cancelled.\n\nThank you!`;
      const html = `<p>Hi <strong>${name}</strong>,</p><p>Your appointment scheduled for <strong>${startTime}</strong> (Code: <strong>${confirmationCode}</strong>) has been successfully cancelled.</p><p>Thank you!</p>`;

      if (apiKey) {
        try {
          const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to }] }],
              from: { email: fromEmail, name: 'Voice Booking Coordinator' },
              subject,
              content: [
                { type: 'text/plain', value: text },
                { type: 'text/html', value: html },
              ],
            }),
          });
          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`SendGrid API returned status ${res.status}: ${errBody}`);
          }
          console.log(`✔ Cancellation email sent via SendGrid to ${to}`);
          return { success: true };
        } catch (err) {
          console.error(`Failed to send cancellation email via SendGrid:`, err);
          throw err;
        }
      } else {
        console.log(`[SIMULATED EMAIL] Sending cancellation notice to ${to}:`);
        console.log(`Subject: ${subject}`);
        console.log(`Body: ${text}`);
        return { success: true };
      }
    },
  };
}
