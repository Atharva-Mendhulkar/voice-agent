import {
  defineAgent,
  JobContext,
  voice,
  llm
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';

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
    const metadata: Record<string, any> = {};
    for (const metadataStr of [(ctx as any).job?.metadata, ctx.room.metadata]) {
      if (!metadataStr) continue;
      try {
        Object.assign(metadata, JSON.parse(metadataStr));
      } catch (e) {
        // ignore
      }
    }
    let tenantId =
      metadata.tenantId ||
      process.env.DEFAULT_TENANT_ID ||
      process.env.TWILIO_DEFAULT_TENANT_ID ||
      'd3b07384-d113-4ec3-a558-e04e662e3f62';
    let tenantCalendarId = process.env.TARGET_CALENDAR_ID || 'primary';

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

    let sysPrompt = 'You are a helpful scheduling assistant. When booking an appointment, you only need to ask the user for their name, along with the date and time. Do not ask for their email address, phone number, or calendar details. Keep your responses short and conversational. After you have successfully booked the appointment and provided the confirmation to the user, immediately say a short goodbye and then call the `endCall` tool to hang up.';

    if (db) {
      try {
        const [row] = await db`SELECT * FROM tenants WHERE id = ${tenantId}`;
        if (row) {
          const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          if (config?.systemPrompt) sysPrompt = config.systemPrompt;
          if (config?.calendarId) tenantCalendarId = config.calendarId;

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
          timezone: z.string().nullable().optional().describe('IANA timezone, default UTC.'),
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
                  calendarId: tenantCalendarId,
                  timezone: args.timezone || 'UTC',
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
          attendeeName: z.string().describe('Attendee name.'),
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
                    durationMinutes: 30,
                    attendeeEmail: 'no-reply@voicebooking.com',
                    attendeePhone: null,
                    attendeeName: args.attendeeName,
                    calendarId: tenantCalendarId,
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

      endCall: llm.tool({
        description: 'End the phone call. Call this ONLY after confirming a successful booking and explicitly saying goodbye to the user.',
        parameters: z.object({}),
        execute: async () => {
          // Give TTS some time to finish the goodbye message before forcefully disconnecting
          setTimeout(() => {
            ctx.room.disconnect();
          }, 5000);
          return 'Call ending...';
        },
      }),
    };

    const agent = new voice.Agent({
      instructions: sysPrompt,
      tools,
    });

    const vad = await silero.VAD.load({
      minSilenceDuration: 250, // Extremely aggressive endpointing for snappy response
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
      tts: new cartesia.TTS({ voice: process.env.CARTESIA_VOICE_ID || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' }),
      vad,
      turnHandling: {
        preemptiveGeneration: {
          enabled: true,
        },
        interruption: {
          mode: 'vad',
          minDuration: 150,
        },
      },
    });

    await session.start({
        agent,
        room: ctx.room
    });

    let greeting = 'Hello, thank you for calling. How can I help you book your appointment today?';
    
    // Parse room metadata for channel info
    try {
      if (metadata.channel === 'whatsapp' || ctx.room?.name?.startsWith('wa-call-')) {
        greeting = 'Hello, thank you for calling us on WhatsApp. How can I help you book your appointment today?';
      }
    } catch (e) {
      // Ignore metadata parse error
    }

    await session.say(greeting, {
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
