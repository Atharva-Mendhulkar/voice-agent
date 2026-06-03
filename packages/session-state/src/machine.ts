import { createMachine } from 'xstate';

const SESSION_TIMEOUT_MS = 300000; // 5 minutes

export interface SessionContext {
  roomId: string;
  tenantId: string;
  reconnectAttempts: number;
  error?: string;
}

export type SessionMachineEvent =
  | { type: 'CONNECTED' }
  | { type: 'USER_SPEECH_START' }
  | { type: 'USER_SPEECH_END' }
  | { type: 'AGENT_SPEECH_START' }
  | { type: 'AGENT_SPEECH_END' }
  | { type: 'USER_BARGE_IN' }
  | { type: 'TRIGGER_TOOL' }
  | { type: 'TOOL_START' }
  | { type: 'TOOL_SUCCESS' }
  | { type: 'TOOL_ERROR'; error?: string }
  | { type: 'CONNECTION_LOST' }
  | { type: 'RECONNECTED' }
  | { type: 'RECONNECT_TIMEOUT' }
  | { type: 'CRITICAL_ERROR'; error?: string }
  | { type: 'SESSION_END' };

export const sessionMachine = createMachine<SessionContext, SessionMachineEvent>(
  {
    id: 'session',
    predictableActionArguments: true,
    initial: 'CONNECTING',
    context: {
      roomId: '',
      tenantId: '',
      reconnectAttempts: 0,
    },
    states: {
      CONNECTING: {
        on: {
          CONNECTED: 'LISTENING',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
        after: {
          [SESSION_TIMEOUT_MS]: 'DISCONNECTED',
        }
      },
      LISTENING: {
        on: {
          USER_SPEECH_START: 'LISTENING',
          USER_SPEECH_END: 'THINKING',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
        after: {
          [SESSION_TIMEOUT_MS]: 'DISCONNECTED',
        }
      },
      THINKING: {
        on: {
          AGENT_SPEECH_START: 'SPEAKING',
          TRIGGER_TOOL: 'TOOL_PENDING',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
        after: {
          [SESSION_TIMEOUT_MS]: 'DISCONNECTED',
        }
      },
      SPEAKING: {
        on: {
          AGENT_SPEECH_END: 'LISTENING',
          USER_BARGE_IN: 'INTERRUPTED',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
      },
      INTERRUPTED: {
        entry: ['cancelSpeech', 'cancelLlm'],
        on: {
          USER_SPEECH_END: 'THINKING',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
      },
      TOOL_PENDING: {
        on: {
          TOOL_START: 'TOOL_EXECUTING',
          USER_BARGE_IN: 'TOOL_CANCELLED',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
        after: {
          [SESSION_TIMEOUT_MS]: 'DISCONNECTED',
        }
      },
      TOOL_EXECUTING: {
        on: {
          TOOL_SUCCESS: 'THINKING',
          TOOL_ERROR: 'THINKING',
          USER_BARGE_IN: 'TOOL_CANCELLED',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
        after: {
          [SESSION_TIMEOUT_MS]: 'DISCONNECTED',
        }
      },
      TOOL_CANCELLED: {
        entry: ['cancelToolExecution'],
        on: {
          USER_SPEECH_END: 'THINKING',
          CONNECTION_LOST: 'RECONNECTING',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
      },
      RECONNECTING: {
        entry: ['incrementReconnect'],
        on: {
          RECONNECTED: 'LISTENING',
          RECONNECT_TIMEOUT: 'DEGRADED_MODE',
          CRITICAL_ERROR: 'DEGRADED_MODE',
          SESSION_END: 'DISCONNECTED',
        },
      },
      DEGRADED_MODE: {
        entry: ['setDegradedMessage'],
        on: {
          SESSION_END: 'DISCONNECTED',
        },
      },
      DISCONNECTED: {
        type: 'final',
      },
    },
  },
  {
    actions: {
      cancelSpeech: () => {},
      cancelLlm: () => {},
      cancelToolExecution: () => {},
      incrementReconnect: (context) => {
        context.reconnectAttempts += 1;
      },
      setDegradedMessage: (context, event: any) => {
        context.error = event.error || 'Connection failure, fallback to manual routing.';
      },
    },
  }
);
