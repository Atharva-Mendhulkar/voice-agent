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
      
      const originalIterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = (async function* () {
        let outputText = '';
        try {
          for await (const chunk of originalIterator()) {
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
            await langfuse.flushAsync();
          }
        }
      }) as any;
      
      return stream;
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
