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
import { getLangfuse, logger } from '@voice-agent/observability';
import * as z from 'zod';

import { createRedisClient } from '@voice-agent/redis-client';
import { createDbClient } from '@voice-agent/db-client';
import { Connection, Client as TemporalClient } from '@temporalio/client';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const roomId = ctx.room.name;
    const metadataStr = ctx.room.metadata;
    let tenantId = 'd3b07384-d113-4ec3-a558-e04e662e3f62'; // Default to Acme Hotels UUID instead of 'default' string
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

    let redis = (global as any).redis;
    let db = (global as any).db;
    let temporal = (global as any).temporal;

    if (!temporal) {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking';
      const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
      const temporalNamespace = process.env.TEMPORAL_NAMESPACE || 'default';

      redis = createRedisClient(redisUrl);
      db = createDbClient(dbUrl);
      
      const temporalConnection = await Connection.connect({ address: temporalAddress });
      temporal = new TemporalClient({
        connection: temporalConnection,
        namespace: temporalNamespace,
      });

      // Cache them for future runs in this thread
      (global as any).redis = redis;
      (global as any).db = db;
      (global as any).temporal = temporal;
    }

    let sysPrompt = 'You are a helpful scheduling assistant. When booking an appointment, you only need to ask the user for their name and phone number (to send a WhatsApp confirmation), along with the date and time. Do not ask for their email address. Keep your responses short and conversational.';

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

    // Inject current date context so the agent knows what year it is
    sysPrompt += `\n\nCRITICAL CONTEXT: The current date and time is ${new Date().toString()}. Always use this to resolve relative dates like "tomorrow" or "next week".`;

    const tools = {
      checkAvailability: llm.tool({
        description: 'Check if a specific time slot is available on the calendar.',
        parameters: z.object({
          date: z.string().describe('Date in YYYY-MM-DD format.'),
          time: z.string().describe('Time in HH:MM (24-hour) format.'),
          calendarId: z.string().nullable().optional().describe('The calendar ID. Optional, defaults to primary.'),
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
                  calendarId: args.calendarId || process.env.TARGET_CALENDAR_ID || 'primary',
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
          attendeeEmail: z.string().nullable().optional().describe('Attendee email address. Optional, use a dummy if not provided.'),
          attendeePhone: z.string().nullable().optional().describe('Attendee phone number in E.164 format. Optional but requested for WhatsApp confirmations.'),
          attendeeName: z.string().describe('Attendee name.'),
          calendarId: z.string().nullable().optional().describe('The calendar ID. Optional, defaults to primary.'),
          timezone: z.string().nullable().optional().describe('Timezone, default UTC'),
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
                    attendeePhone: args.attendeePhone || null,
                    attendeeName: args.attendeeName,
                    calendarId: args.calendarId || process.env.TARGET_CALENDAR_ID || 'primary',
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

    const baseLlm = new openai.LLM();
    const langfuse = getLangfuse();
    const originalChat = baseLlm.chat.bind(baseLlm);
    
    (baseLlm as any).chat = function(ctxParam: any, optsParam?: any) {
      let trace: any;
      let span: any;
      if (langfuse) {
        trace = langfuse.trace({
          name: 'agent-turn',
          sessionId: ctx.room.name,
        });
        span = trace.span({
          name: 'llm-completion',
          input: ctxParam,
        });
      }
      
      // @ts-ignore
      const stream = originalChat(ctxParam, optsParam);
      let outputText = '';

      const proxyStream = new Proxy(stream, {
        get(target, prop, receiver) {
          if (prop === Symbol.asyncIterator) {
            return async function* () {
              try {
                for await (const chunk of target[Symbol.asyncIterator]()) {
                  if ((chunk as any)?.content) {
                    outputText += (chunk as any).content;
                  } else if ((chunk as any)?.choices?.[0]?.delta?.content) {
                    outputText += (chunk as any).choices[0].delta.content;
                  }
                  yield chunk;
                }
              } finally {
                if (span) {
                  span.end({
                    output: outputText,
                  });
                }
                if (langfuse) {
                  langfuse.flushAsync().catch((err) => console.error('Langfuse flush error:', err));
                }
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      });
      
      return proxyStream;
    };

    const session = new voice.AgentSession({
      stt: new deepgram.STT(),
      llm: baseLlm,
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

    ctx.room.on('disconnected', async () => {
      logger.info({ roomId, tenantId }, 'Room disconnected, triggering PostCallWorkflow');
      try {
        const piiRedactor = new PiiRedactor();
        const chatCtx: any = agent.chatCtx;
        const messages = chatCtx?.messages || chatCtx?.getMessages?.() || [];
        const transcript = messages.map((m: any) => ({
          role: m.role,
          text: piiRedactor.redact(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
          ts: Date.now()
        }));

        const reqId = Date.now().toString();
        if (temporal) {
          await temporal.workflow.start('PostCallWorkflow', {
            taskQueue: 'booking-queue',
            workflowId: `postcall-${roomId}-${reqId}`,
            args: [{ roomId, tenantId, transcript }],
          });
          logger.info({ roomId }, 'PostCallWorkflow triggered successfully');
        } else {
          logger.warn('Temporal not connected, could not start PostCallWorkflow');
        }
      } catch (err) {
        logger.error({ err, roomId }, 'Failed to trigger PostCallWorkflow');
      }
    });
  },
});
