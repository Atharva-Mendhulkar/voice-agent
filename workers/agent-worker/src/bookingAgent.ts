import {
  defineAgent,
  JobContext,
  voice,
  llm
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';

import * as silero from '@livekit/agents-plugin-silero';
import { PiiRedactor } from '@voice-agent/pii-redactor';
import * as z from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const roomId = ctx.room.name;
    const metadataStr = ctx.room.metadata;
    let tenantId = 'default';
    if (metadataStr) {
      try {
        const metadata = JSON.parse(metadataStr);
        if (metadata.tenantId) {
          tenantId = metadata.tenantId;
        }
      } catch (e) {
        // ignore
      }
    }

    const redis = (global as any).redis;
    const db = (global as any).db;
    const temporal = (global as any).temporal;

    let sysPrompt = 'You are a helpful scheduling assistant. When booking an appointment, you only need to ask the user for their name (along with date and time). Do not ask for their email address. Keep your responses short and conversational.';

    
    if (db) {
      try {
        const [row] = await db`SELECT * FROM tenants WHERE id = ${tenantId}`;
        if (row) {
          const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          if (config?.systemPrompt) sysPrompt = config.systemPrompt;

        }
      } catch (e) {
        console.warn('Could not fetch tenant config:', e);
      }
    }

    const tools = {
      checkAvailability: llm.tool({
        description: 'Check if a specific time slot is available on the calendar.',
        parameters: z.object({
          date: z.string().describe('Date in YYYY-MM-DD format.'),
          time: z.string().describe('Time in HH:MM (24-hour) format.'),
          calendarId: z.string().optional().describe('The calendar ID. Optional, defaults to primary.'),
        }),
        execute: async (args: any) => {
          if (!temporal) return 'Temporal not connected';
          try {
            const reqId = Date.now().toString();
            const handle = await temporal.workflow.start('CheckAvailabilityWorkflow', {
              taskQueue: 'booking-queue',
              workflowId: `avail-${roomId}-${reqId}`,
              args: [
                {
                  roomId,
                  tenantId,
                  date: args.date,
                  time: args.time,
                  calendarId: args.calendarId || 'primary',
                },
              ],
            });
            const result = await handle.result();
            return JSON.stringify(result);
          } catch (e: any) {
            return `Failed: ${e.message}`;
          }
        },
      }),

      bookAppointment: llm.tool({
        description: 'Book an appointment for a user.',
        parameters: z.object({
          date: z.string().describe('Date in YYYY-MM-DD format.'),
          time: z.string().describe('Time in HH:MM (24-hour) format.'),
          durationMinutes: z.number().default(30).describe('Duration in minutes. Default is 30.'),
          attendeeEmail: z.string().optional().describe('Attendee email address. Optional, use a dummy if not provided.'),
          attendeeName: z.string().describe('Attendee name.'),
          calendarId: z.string().optional().describe('The calendar ID. Optional, defaults to primary.'),
          timezone: z.string().optional().describe('Timezone, default UTC'),
        }),
        execute: async (args: any) => {
          if (!temporal) return 'Temporal not connected';
          try {
            const reqId = Date.now().toString();
            const handle = await temporal.workflow.start('BookingWorkflow', {
              taskQueue: 'booking-queue',
              workflowId: `book-${roomId}-${reqId}`,
              args: [
                {
                  roomId,
                  tenantId,
                  requestId: reqId,
                  appointment: {
                    date: args.date,
                    time: args.time,
                    durationMinutes: args.durationMinutes || 30,
                    attendeeEmail: args.attendeeEmail || 'no-reply@voicebooking.com',
                    attendeeName: args.attendeeName,
                    calendarId: args.calendarId || 'primary',
                    timezone: args.timezone || 'UTC',
                  },
                },
              ],
            });
            const result = await handle.result();
            return JSON.stringify(result);
          } catch (e: any) {
            return `Failed: ${e.message}`;
          }
        },
      }),

      cancelBooking: llm.tool({
        description: 'Cancel an existing booking using the confirmation code.',
        parameters: z.object({
          confirmationCode: z.string().describe('The booking confirmation code.'),
        }),
        execute: async (args: any) => {
          if (!temporal) return 'Temporal not connected';
          try {
            const reqId = Date.now().toString();
            const handle = await temporal.workflow.start('CancellationWorkflow', {
              taskQueue: 'booking-queue',
              workflowId: `cancel-${roomId}-${reqId}`,
              args: [
                {
                  roomId,
                  tenantId,
                  confirmationCode: args.confirmationCode,
                  requestId: reqId,
                },
              ],
            });
            const result = await handle.result();
            return JSON.stringify(result);
          } catch (e: any) {
            return `Failed: ${e.message}`;
          }
        },
      }),
    };

    const agent = new voice.Agent({
      instructions: sysPrompt,
      tools,
    });

    const vad = await silero.VAD.load({
      minSilenceDuration: 300, // Aggressive endpointing (default is often 500-700ms)
    });

    const session = new voice.AgentSession({
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new openai.TTS({ model: 'tts-1', voice: 'alloy' }),
      vad,
    });

    await session.start({
        agent,
        room: ctx.room
    });

    await session.say('Hello, thank you for calling. How can I help you book your appointment today?', {
      allowInterruptions: true
    });
  },
});
