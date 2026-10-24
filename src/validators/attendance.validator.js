import { z } from 'zod';
import { ATTENDANCE_STATUS_LIST } from '../config/constants.js';
import {
  objectId, idParam, optional, dateField, dateKey, boolQuery,
  latitude, longitude, paginationQuery,
} from './common.validator.js';

/*
  The check-in time and the date are set by the SERVER, so they are not
  accepted from the app. The phone only sends its GPS reading.
  GPS is optional so that "location denied" can still be recorded, but the
  record is then flagged as an exception for review.
*/
const gpsBody = z
  .object({
    projectId: objectId,
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    accuracyMeters: z.number().min(0).max(100000).optional(),
    notes: optional(z.string().trim().max(300)),
  })
  .refine((d) => (d.latitude === undefined) === (d.longitude === undefined), {
    path: ['latitude'],
    message: 'Send both latitude and longitude, or neither',
  });

export const checkInSchema = z.object({ body: gpsBody });
export const checkOutSchema = z.object({ body: gpsBody });

// Engineer records attendance for a worker
export const recordWorkerAttendanceSchema = z.object({
  body: z
    .object({
      projectId: objectId,
      workerId: objectId,
      date: dateKey,
      status: z.enum(ATTENDANCE_STATUS_LIST),
      checkInTime: optional(dateField),
      checkOutTime: optional(dateField),
      notes: optional(z.string().trim().max(300)),
    })
    .refine((d) => !d.checkInTime || !d.checkOutTime || d.checkOutTime >= d.checkInTime, {
      path: ['checkOutTime'],
      message: 'Check-out cannot be earlier than check-in',
    }),
});

// Recording attendance for many workers at once (max 100)
export const bulkWorkerAttendanceSchema = z.object({
  body: z.object({
    projectId: objectId,
    date: dateKey,
    entries: z
      .array(
        z.object({
          workerId: objectId,
          status: z.enum(ATTENDANCE_STATUS_LIST),
          notes: optional(z.string().trim().max(300)),
        })
      )
      .min(1)
      .max(100)
      .refine((e) => new Set(e.map((x) => x.workerId)).size === e.length, 'A worker is listed twice'),
  }),
});

// A correction always needs a reason. It is saved in the record's history.
export const correctAttendanceSchema = z.object({
  params: idParam('id'),
  body: z
    .object({
      status: z.enum(ATTENDANCE_STATUS_LIST).optional(),
      checkInTime: dateField.optional(),
      checkOutTime: dateField.optional(),
      reason: z.string().trim().min(5, 'Explain why this is being corrected').max(500),
    })
    .refine((d) => d.status || d.checkInTime || d.checkOutTime, {
      path: ['status'],
      message: 'Change at least one value',
    })
    .refine((d) => !d.checkInTime || !d.checkOutTime || d.checkOutTime >= d.checkInTime, {
      path: ['checkOutTime'],
      message: 'Check-out cannot be earlier than check-in',
    }),
});

export const confirmAttendanceSchema = z.object({ params: idParam('id') });

// Worker raises a dispute
export const raiseDisputeSchema = z.object({
  params: idParam('id'),
  body: z.object({ reason: z.string().trim().min(10, 'Please describe the problem').max(500) }),
});

export const resolveDisputeSchema = z.object({
  params: idParam('id'),
  body: z.object({
    status: z.enum(['resolved', 'rejected']),
    resolutionNote: z.string().trim().min(5, 'Add a short note').max(500),
  }),
});

export const listAttendanceSchema = z.object({
  query: z.object({
    ...paginationQuery,
    projectId: objectId.optional(),
    userId: objectId.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
    flagged: boolQuery.optional(), // only exceptions
    disputed: boolQuery.optional(),
    status: z.enum(ATTENDANCE_STATUS_LIST).optional(),
  }),
});