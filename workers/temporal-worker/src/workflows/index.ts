import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const {
  checkCalendarAvailability,
  holdCalendarSlot,
  releaseCalendarHold,
  createBookingRecord,
  cancelBookingRecord,
  deleteBookingRecord,
  chargePayment,
  confirmCalendarSlot,
  notifyBroker,
  saveTranscriptAndEvents,
  sendConfirmationEmail,
  sendCancellationEmail,
} = proxyActivities<ReturnType<typeof activities.createActivities>>({
  startToCloseTimeout: '1 minute',
});

export async function BookingWorkflow(params: {
  roomId: string;
  tenantId: string;
  requestId: string;
  appointment: {
    date: string;
    time: string;
    durationMinutes: number;
    attendeeEmail: string;
    attendeeName: string;
    calendarId: string;
    timezone: string;
  };
}): Promise<void> {
  const { roomId, tenantId, appointment } = params;
  const { date, time, calendarId } = appointment;

  const avail = await checkCalendarAvailability({
    tenantId,
    calendarId,
    date,
    time,
    durationMinutes: appointment.durationMinutes,
  });

  if (!avail.available) {
    await notifyBroker({
      roomId,
      event: {
        type: 'SLOT_UNAVAILABLE',
        roomId,
        proposedSlot: avail.proposedSlot || '',
      },
    });
    return;
  }

  const held = await holdCalendarSlot({ calendarId, date, time });
  if (!held.success) {
    await notifyBroker({
      roomId,
      event: {
        type: 'BOOKING_FAILED',
        roomId,
        reason: 'slot_held_by_other',
      },
    });
    return;
  }

  let bookingId: string | null = null;
  let confirmationCode = '';

  try {
    const booking = await createBookingRecord({
      tenantId,
      calendarId,
      attendeeEmail: appointment.attendeeEmail,
      attendeeName: appointment.attendeeName,
      date,
      time,
      durationMinutes: appointment.durationMinutes,
      timezone: appointment.timezone,
    });
    bookingId = booking.id;
    confirmationCode = booking.confirmationCode;

    await chargePayment({ attendeeName: appointment.attendeeName });

    await confirmCalendarSlot({ calendarId, date, time });

    await sendConfirmationEmail({
      to: appointment.attendeeEmail,
      name: appointment.attendeeName,
      startTime: `${date}T${time}:00Z`,
      confirmationCode,
    });

    await notifyBroker({
      roomId,
      event: {
        type: 'BOOKING_CONFIRMED',
        roomId,
        result: {
          bookingId,
          confirmationCode,
        },
      },
    });
  } catch (err) {
    console.error('Booking Saga failed, executing compensation steps:', err);
    if (bookingId) {
      await deleteBookingRecord({ tenantId, bookingId });
    }
    await releaseCalendarHold({ calendarId, date, time });

    const causeMessage = err && typeof err === 'object' && 'cause' in err && err.cause && typeof err.cause === 'object' && 'message' in err.cause ? (err.cause.message as string) : undefined;
    await notifyBroker({
      roomId,
      event: {
        type: 'BOOKING_FAILED',
        roomId,
        reason: causeMessage || (err as Error).message || 'saga_execution_failed',
      },
    });
  }
}

export async function CancellationWorkflow(params: {
  roomId: string;
  tenantId: string;
  confirmationCode: string;
}): Promise<void> {
  const { roomId, tenantId, confirmationCode } = params;
  const cancelRes = await cancelBookingRecord({ tenantId, confirmationCode });

  if (cancelRes.success && cancelRes.attendeeEmail) {
    await sendCancellationEmail({
      to: cancelRes.attendeeEmail,
      name: cancelRes.attendeeName || 'Guest',
      startTime: cancelRes.startTime || '',
      confirmationCode,
    });
  }

  await notifyBroker({
    roomId,
    event: {
      type: 'CANCELLATION_CONFIRMED',
      roomId,
      confirmationCode,
    },
  });
}

export async function CheckAvailabilityWorkflow(params: {
  roomId: string;
  tenantId: string;
  date: string;
  time: string;
  calendarId: string;
}): Promise<void> {
  const { roomId, tenantId, date, time, calendarId } = params;
  const avail = await checkCalendarAvailability({
    tenantId,
    calendarId,
    date,
    time,
  });

  await notifyBroker({
    roomId,
    event: {
      type: 'AVAILABILITY_RESULT',
      roomId,
      isAvailable: avail.available,
      proposedSlot: avail.proposedSlot || '',
    },
  });
}

export async function PostCallWorkflow(params: {
  roomId: string;
  tenantId: string;
  transcript: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
}): Promise<void> {
  const { roomId, tenantId, transcript } = params;
  await saveTranscriptAndEvents({ roomId, tenantId, transcript });
}
