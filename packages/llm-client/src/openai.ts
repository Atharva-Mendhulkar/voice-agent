import OpenAI from 'openai';

export const BOOKING_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Check if a specific time slot is available on the calendar.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format.' },
          time: { type: 'string', description: 'Time in HH:MM (24-hour) format.' },
          calendarId: { type: 'string', description: 'The calendar ID to check.' },
        },
        required: ['date', 'time', 'calendarId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bookAppointment',
      description: 'Book an appointment for a user.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format.' },
          time: { type: 'string', description: 'Time in HH:MM (24-hour) format.' },
          durationMinutes: { type: 'number', description: 'Duration in minutes. Default is 30.' },
          attendeeEmail: { type: 'string', description: 'Attendee email address.' },
          attendeeName: { type: 'string', description: 'Attendee name.' },
          calendarId: { type: 'string', description: 'The calendar ID to book onto.' },
        },
        required: ['date', 'time', 'attendeeEmail', 'attendeeName', 'calendarId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelBooking',
      description: 'Cancel an existing booking using the confirmation code.',
      parameters: {
        type: 'object',
        properties: {
          confirmationCode: { type: 'string', description: 'The booking confirmation code.' },
        },
        required: ['confirmationCode'],
      },
    },
  },
];

export interface LlmStreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, any>, id: string) => void;
  onComplete: (fullText: string) => void;
  onError: (err: Error) => void;
}

export class OpenAIStreamingClient {
  private openai: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = 'gpt-4o') {
    this.openai = new OpenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  async streamCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    callbacks: LlmStreamCallbacks,
    signal?: AbortSignal,
    model?: string
  ): Promise<void> {
    try {
      const stream = await this.openai.chat.completions.create(
        {
          model: model || this.defaultModel,
          messages,
          tools: BOOKING_TOOLS,
          tool_choice: 'auto',
          stream: true,
        },
        { signal }
      );

      let fullText = '';
      const toolCallsMap: Record<number, { id?: string; name?: string; arguments: string }> = {};

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new DOMException('LLM stream aborted by user request.', 'AbortError');
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const token = choice.delta?.content;
        if (token) {
          fullText += token;
          callbacks.onToken(token);
        }

        const toolCalls = choice.delta?.tool_calls;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const index = tc.index;
            if (toolCallsMap[index] === undefined) {
              toolCallsMap[index] = { arguments: '' };
            }
            const accum = toolCallsMap[index];
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) accum.arguments += tc.function.arguments;
          }
        }
      }

      for (const index of Object.keys(toolCallsMap).map(Number)) {
        const accum = toolCallsMap[index];
        if (accum.name && accum.id) {
          try {
            const parsedArgs = JSON.parse(accum.arguments);
            callbacks.onToolCall(accum.name, parsedArgs, accum.id);
          } catch (err) {
            callbacks.onError(new Error(`Failed to parse tool call arguments: ${accum.arguments}`));
          }
        }
      }

      callbacks.onComplete(fullText);
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'DOMException') {
        return;
      }
      callbacks.onError(err as Error);
    }
  }
}
