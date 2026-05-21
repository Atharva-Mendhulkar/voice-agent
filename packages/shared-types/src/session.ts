export type SessionState =
  | 'CONNECTING'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'INTERRUPTED'
  | 'TOOL_PENDING'
  | 'TOOL_EXECUTING'
  | 'TOOL_CANCELLED'
  | 'RECONNECTING'
  | 'DEGRADED_MODE'
  | 'DISCONNECTED';

export interface TranscriptEntry {
  role: 'user' | 'agent';
  text: string;
  ts: number;
}

export interface TenantConfig {
  tenantId: string;
  name: string;
  slug: string;
  calendarId: string;
  voiceId: string;
  systemPrompt: string;
  voiceModel?: string; // e.g. 'sonic-2'
  sttLanguage?: string; // e.g. 'en-US'
  createdAt: string;
  updatedAt: string;
}

export interface SavedSessionState {
  state: SessionState;
  tenantId: string;
  startedAt: number;
  turnCount: number;
  transcript: TranscriptEntry[];
  activeWorkflowId?: string;
  updatedAt: number;
}
