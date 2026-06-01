import { z } from 'zod';

export const bookingSchema = z.object({
  callerNumber: z.string(),
  callerName: z.string(),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestedTime: z.string(),
  serviceType: z.enum(['consultation', 'follow_up', 'general']), // Add allowed types
  channel: z.string(),
});

export const sessionTokenSchema = z.object({
  roomName: z.string(),
  userId: z.string(),
  channel: z.string(),
  exp: z.number(),
});
