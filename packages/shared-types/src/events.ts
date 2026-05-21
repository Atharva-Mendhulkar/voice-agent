import { BookingResult } from './booking.js';

export type WorkflowResultType =
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_FAILED'
  | 'SLOT_UNAVAILABLE'
  | 'CANCELLATION_CONFIRMED'
  | 'AVAILABILITY_RESULT';

export interface BookingConfirmedEvent {
  type: 'BOOKING_CONFIRMED';
  roomId: string;
  result: BookingResult;
}

export interface BookingFailedEvent {
  type: 'BOOKING_FAILED';
  roomId: string;
  reason: 'calendar_error' | 'database_error' | 'timeout' | 'cancelled_by_user';
}

export interface SlotUnavailableEvent {
  type: 'SLOT_UNAVAILABLE';
  roomId: string;
  proposedSlot: string;
}

export interface CancellationConfirmedEvent {
  type: 'CANCELLATION_CONFIRMED';
  roomId: string;
  confirmationCode: string;
}

export interface AvailabilityResultEvent {
  type: 'AVAILABILITY_RESULT';
  roomId: string;
  isAvailable: boolean;
  proposedSlot: string;
}

export type WorkflowResultEvent =
  | BookingConfirmedEvent
  | BookingFailedEvent
  | SlotUnavailableEvent
  | CancellationConfirmedEvent
  | AvailabilityResultEvent;

export interface SessionEvent {
  type: 'SESSION_STATE' | 'DEGRADED_MODE_MESSAGE' | 'AGENT_HANDOFF';
  roomId: string;
  payload: Record<string, any>;
  timestamp: number;
}
