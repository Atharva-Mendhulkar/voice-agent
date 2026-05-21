import postgres from 'postgres';
import { Redis } from 'ioredis';
import crypto from 'crypto';
import { TenantScopedDb } from '@voice-agent/db-client';
import { WorkflowResultBroker } from '@voice-agent/redis-client';
import { google } from 'googleapis';
import { ApplicationFailure } from '@temporalio/activity';

export interface ActivityContext {
  db: postgres.Sql;
  redis: Redis;
}

function getGoogleCalendar() {
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

  // Replace escaped newlines if any
  key = key.replace(/\\n/g, '\n');

  try {
    const auth = new google.auth.JWT({
      email,
      key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    return google.calendar({ version: 'v3', auth });
  } catch (err) {
    console.error('Failed to initialize Google Calendar client:', err);
    return null;
  }
}

export function createActivities(context: ActivityContext) {
  const scopedDb = new TenantScopedDb(context.db);
  const broker = new WorkflowResultBroker(context.redis, context.redis.duplicate());
  const googleCalendar = getGoogleCalendar();

  return {
    async checkCalendarAvailability(params: {
      tenantId: string;
      calendarId: string;
      date: string;
      time: string;
      durationMinutes?: number;
    }): Promise<{ available: boolean; proposedSlot?: string }> {
      const { tenantId, calendarId, date, time, durationMinutes = 30 } = params;
      const startTime = new Date(`${date}T${time}:00Z`);
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
      if (googleCalendar) {
        try {
          const freebusyRes = await googleCalendar.freebusy.query({
            requestBody: {
              timeMin: startTime.toISOString(),
              timeMax: endTime.toISOString(),
              items: [{ id: calendarId }],
            },
          });
          const busy = freebusyRes.data.calendars?.[calendarId]?.busy || [];
          if (busy.length > 0) {
            const proposedTime = new Date(startTime.getTime() + 30 * 60000);
            const proposedString = proposedTime.toISOString().substring(11, 16);
            return { available: false, proposedSlot: proposedString };
          }
        } catch (err) {
          console.warn('Google Calendar availability check failed, falling back to local DB:', (err as Error).message);
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

    async createBookingRecord(params: {
      tenantId: string;
      calendarId: string;
      attendeeEmail: string;
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
        attendeeName,
        date,
        time,
        durationMinutes = 30,
        timezone = 'UTC',
        workflowId,
      } = params;

      const confirmationCode = 'CONF-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const startTime = new Date(`${date}T${time}:00Z`);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Insert event into Google Calendar if configured
      let calendarEventId: string = crypto.randomUUID();
      if (googleCalendar) {
        try {
          const eventRes = await googleCalendar.events.insert({
            calendarId,
            requestBody: {
              summary: `Booking: ${attendeeName}`,
              description: `Confirmed reservation via SHIELD Voice Coordinator.`,
              start: { dateTime: startTime.toISOString(), timeZone: timezone },
              end: { dateTime: endTime.toISOString(), timeZone: timezone },
              attendees: [{ email: attendeeEmail, displayName: attendeeName }],
            },
          });
          if (eventRes.data.id) {
            calendarEventId = eventRes.data.id;
          }
        } catch (err) {
          console.warn('Google Calendar events.insert failed, creating local record only:', (err as Error).message);
        }
      }

      const [row] = await scopedDb.runTenantScoped(tenantId, async (tx) => {
        return tx`
          INSERT INTO bookings (
            tenant_id,
            confirmation_code,
            calendar_event_id,
            calendar_id,
            attendee_email,
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
