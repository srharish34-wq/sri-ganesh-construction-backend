import { z } from 'zod';
import { PAYMENT_MODE_LIST, PAYMENT_STATUS_LIST, APPROVAL_STATUS_LIST } from '../config/constants.js';
import {
  objectId, optional, dateKey, pastOrTodayDateKey, positiveMoney, money,
  paginationQuery, reason, boolQuery,
} from './common.validator.js';

/*
  Two separate records:
    WorkerWage     what the worker EARNED for a period  (approved by the admin)
    WorkerPayment  what was PAID to the worker          (counts only when confirmed)
  Pending balance = approved wages - confirmed payments.
  The app never sends grossAmount or netAmount: the server calculates them.
*/

const NEEDS_REFERENCE = ['upi', 'bank_transfer', 'cheque'];

// Whole days or half days only (0, 0.5, 1, 1.5 ...)
const halfDays = z
  .number({ invalid_type_error: 'Enter the days worked' })
  .min(0)
  .max(366)
  .refine((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9, 'Use whole or half days (for example 5 or 5.5)');

const wageFields = z.object({
  projectId: objectId,
  workerId: objectId,
  periodStart: dateKey,
  periodEnd: dateKey,
  daysWorked: halfDays,
  dailyRate: positiveMoney,
  additions: money.default(0), // overtime, bonus
  deductions: money.default(0), // advance recovered, penalty
  adjustmentNote: optional(z.string().trim().max(300)),
});

const periodInOrder = (d) => !d.periodStart || !d.periodEnd || d.periodEnd >= d.periodStart;
const periodMessage = { path: ['periodEnd'], message: 'Period end cannot be before period start' };
const noteRule = [
  (d) => !(d.additions > 0 || d.deductions > 0) || (d.adjustmentNote && d.adjustmentNote.length >= 3),
  { path: ['adjustmentNote'], message: 'Explain the addition or deduction' },
];

export const createWageSchema = z.object({
  body: wageFields.refine(periodInOrder, periodMessage).refine(...noteRule),
});

// Allowed only before approval (the service checks)
export const updateWageSchema = z.object({
  params: z.object({ wageId: objectId }),
  body: wageFields
    .omit({ projectId: true, workerId: true })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' })
    .refine(periodInOrder, periodMessage),
});

export const wageIdSchema = z.object({ params: z.object({ wageId: objectId }) });

export const reviewWageSchema = z.object({
  params: z.object({ wageId: objectId }),
  body: z
    .object({
      decision: z.enum(['approved', 'rejected']),
      reviewNote: optional(z.string().trim().max(500)),
    })
    .refine((d) => d.decision !== 'rejected' || (d.reviewNote && d.reviewNote.length >= 5), {
      path: ['reviewNote'],
      message: 'Please explain why the wage record is rejected (at least 5 characters)',
    }),
});

export const cancelWageSchema = z.object({
  params: z.object({ wageId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

// ============ PAYMENTS TO WORKERS ============

export const recordWorkerPaymentSchema = z.object({
  body: z
    .object({
      projectId: objectId,
      workerId: objectId,
      wageId: optional(objectId), // pays a specific wage record
      isAdvance: z.boolean().default(false), // an advance has no wage record
      amount: positiveMoney,
      mode: z.enum(PAYMENT_MODE_LIST),
      paymentDate: pastOrTodayDateKey,
      reference: optional(z.string().trim().max(80)),
      notes: optional(z.string().trim().max(300)),
    })
    .refine((d) => !(d.wageId && d.isAdvance), {
      path: ['isAdvance'],
      message: 'A payment is either against a wage record or an advance, not both',
    })
    .refine((d) => !NEEDS_REFERENCE.includes(d.mode) || (d.reference && d.reference.length >= 3), {
      path: ['reference'],
      message: 'Enter the transaction or cheque reference for this payment mode',
    }),
});

export const workerPaymentIdSchema = z.object({ params: z.object({ paymentId: objectId }) });

export const confirmWorkerPaymentSchema = z.object({
  params: z.object({ paymentId: objectId }),
  body: z.object({ notes: optional(z.string().trim().max(300)) }),
});

export const rejectWorkerPaymentSchema = z.object({
  params: z.object({ paymentId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

export const cancelWorkerPaymentSchema = z.object({
  params: z.object({ paymentId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

// The worker confirms "I received this money". They cannot edit the record.
export const acknowledgeWorkerPaymentSchema = z.object({
  params: z.object({ paymentId: objectId }),
});

// ============ DISPUTES (worker raises, admin or engineer resolves) ============

export const raiseWageDisputeSchema = z.object({
  params: z.object({ wageId: objectId }),
  body: z.object({ reason: reason(10, 500) }),
});

export const raisePaymentDisputeSchema = z.object({
  params: z.object({ paymentId: objectId }),
  body: z.object({ reason: reason(10, 500) }),
});

export const resolveDisputeSchema = z.object({
  params: z.object({ kind: z.enum(['wage', 'payment']), id: objectId }),
  body: z.object({
    status: z.enum(['resolved', 'rejected']),
    resolutionNote: reason(5, 500),
  }),
});

// ============ LISTS AND BALANCES ============

export const listWagesSchema = z.object({
  query: z.object({
    ...paginationQuery,
    projectId: objectId.optional(),
    workerId: objectId.optional(), // workers are limited to themselves by the server
    status: z.enum(APPROVAL_STATUS_LIST).optional(),
    disputed: boolQuery.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
  }),
});

export const listWorkerPaymentsSchema = z.object({
  query: z.object({
    ...paginationQuery,
    projectId: objectId.optional(),
    workerId: objectId.optional(),
    status: z.enum(PAYMENT_STATUS_LIST).optional(),
    isAdvance: boolQuery.optional(),
    disputed: boolQuery.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
  }),
});

export const workerBalanceSchema = z.object({
  params: z.object({ workerId: objectId }),
  query: z.object({ projectId: objectId.optional() }),
});