export interface BookingInput {
  roomId: string;
  tenantId: string;
  requestId: string; // Idempotency key
  appointment: {
    date: string;       // YYYY-MM-DD
    time: string;       // HH:MM (24-hour)
    durationMinutes: number;
    attendeeEmail: string;
    attendeePhone?: string | null;
    attendeeName: string;
    timezone: string;
    calendarId: string;
  };
}

export interface BookingResult {
  eventId: string;
  confirmationCode: string;
  startTime: string;
  endTime: string;
  meetLink?: string;
}

export interface CancellationInput {
  roomId: string;
  tenantId: string;
  confirmationCode: string;
  requestId: string;
}

export interface BookingDetails {
  id: string;
  tenantId: string;
  sessionId?: string;
  confirmationCode: string;
  calendarEventId: string;
  calendarId: string;
  attendeeEmail: string;
  attendeePhone?: string | null;
  attendeeName: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  timezone: string;
  status: 'confirmed' | 'cancelled' | 'rescheduled' | 'no_show';
  temporalWorkflowId?: string;
  idempotencyKey?: string;
  meetLink?: string;
  notes?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}
