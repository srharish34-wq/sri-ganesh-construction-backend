import { z } from 'zod';
import { WORK_CATEGORIES, APPROVAL_STATUS_LIST } from '../config/constants.js';
import {
  objectId, idParam, optional, dateKey, pastOrTodayDateKey, percent,
  paginationQuery, uniqueList, reason,
} from './common.validator.js';

/*
  Report flow:  draft -> submitted -> approved or rejected -> published
  1. Engineer creates the report as a DRAFT.
  2. Engineer uploads media linked to the report (media.validator.js).
  3. Engineer submits it.
  4. Admin approves or rejects, then publishes it with a customer summary.
  The customer sees only the customerSummary and the visible media of a
  published report. delays, issues and nextDayPlan stay internal.
*/

const reportFields = z.object({
  projectId: objectId,
  reportDate: pastOrTodayDateKey,
  workCompleted: z
    .string()
    .trim()
    .min(10, 'Describe the work completed (at least 10 characters)')
    .max(3000),
  workCategories: z
    .array(z.enum(WORK_CATEGORIES))
    .min(1, 'Select at least one work category')
    .max(8)
    .refine(uniqueList, 'A category is listed twice'),
  progressPercent: percent,
  workersPresent: z.number().int().min(0).max(5000),
  delays: optional(z.string().trim().max(1500)),
  issues: optional(z.string().trim().max(1500)),
  nextDayPlan: optional(z.string().trim().max(1500)),
  weather: optional(z.string().trim().max(60)),
});

export const createReportSchema = z.object({
  body: reportFields.partial({
    workersPresent: true,
    delays: true,
    issues: true,
    nextDayPlan: true,
    weather: true,
  }),
});

// The project and the date cannot be changed after creation
export const updateReportSchema = z.object({
  params: idParam('reportId'),
  body: reportFields
    .omit({ projectId: true, reportDate: true })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

export const reportIdSchema = z.object({ params: idParam('reportId') });

export const reviewReportSchema = z.object({
  params: idParam('reportId'),
  body: z
    .object({
      decision: z.enum(['approved', 'rejected']),
      reviewNote: optional(z.string().trim().max(500)),
      customerSummary: optional(z.string().trim().min(10).max(1500)),
    })
    .refine((d) => d.decision !== 'rejected' || (d.reviewNote && d.reviewNote.length >= 5), {
      path: ['reviewNote'],
      message: 'Please explain why the report is rejected (at least 5 characters)',
    }),
});

// Makes the report visible to the customer.
// The service refuses to publish if no customerSummary exists yet.
export const publishReportSchema = z.object({
  params: idParam('reportId'),
  body: z.object({
    customerSummary: optional(z.string().trim().min(10, 'Summary is too short').max(1500)),
  }),
});

// Admin takes a published report back from the customer
export const unpublishReportSchema = z.object({
  params: idParam('reportId'),
  body: z.object({ reason: reason(5, 300) }),
});

export const listReportsSchema = z.object({
  query: z.object({
    ...paginationQuery,
    projectId: objectId.optional(),
    authorId: objectId.optional(),
    status: z.enum(APPROVAL_STATUS_LIST).optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
  }),
});