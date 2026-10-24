import { z } from 'zod';
import {
  PAYMENT_TYPE_LIST, PAYMENT_MODE_LIST, PAYMENT_STATUS_LIST,
  EXPENSE_CATEGORIES, APPROVAL_STATUS_LIST,
} from '../config/constants.js';
import {
  objectId, idParam, optional, positiveMoney, pastOrTodayDateKey, dateKey,
  paginationQuery, reason, boolQuery,
} from './common.validator.js';

const projectParam = z.object({ projectId: objectId });

// Cash can have no reference. UPI, bank transfers and cheques must have one,
// so the money can be traced and the same entry cannot be made twice.
const NEEDS_REFERENCE = ['upi', 'bank_transfer', 'cheque'];
const referenceRule = [
  (d) => !NEEDS_REFERENCE.includes(d.mode) || (d.reference && d.reference.length >= 3),
  { path: ['reference'], message: 'Enter the transaction or cheque reference for this payment mode' },
];

// A file already uploaded to Cloudinary. The service checks that it exists
// and sits inside the project folder.
const fileRef = z.object({
  publicId: z.string().trim().min(5).max(250),
  secureUrl: z
    .string()
    .trim()
    .url()
    .max(600)
    .refine((u) => u.startsWith('https://res.cloudinary.com/'), 'Must be a Cloudinary HTTPS link'),
});

// ============ CUSTOMER PAYMENTS (money coming in) ============
// A payment counts as received ONLY after it is confirmed.

export const recordCustomerPaymentSchema = z.object({
  params: projectParam,
  body: z
    .object({
      type: z.enum(PAYMENT_TYPE_LIST),
      amount: positiveMoney,
      mode: z.enum(PAYMENT_MODE_LIST),
      paymentDate: pastOrTodayDateKey,
      reference: optional(z.string().trim().max(80)),
      notes: optional(z.string().trim().max(500)),
      proof: fileRef.optional(),
    })
    .refine(...referenceRule),
});

export const customerPaymentIdSchema = z.object({
  params: z.object({ projectId: objectId, paymentId: objectId }),
});

export const confirmCustomerPaymentSchema = z.object({
  params: z.object({ projectId: objectId, paymentId: objectId }),
  body: z.object({ notes: optional(z.string().trim().max(300)) }),
});

export const rejectCustomerPaymentSchema = z.object({
  params: z.object({ projectId: objectId, paymentId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

// Cancelling a confirmed payment is the only way to fix a mistake
export const cancelCustomerPaymentSchema = z.object({
  params: z.object({ projectId: objectId, paymentId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

export const listCustomerPaymentsSchema = z.object({
  params: projectParam,
  query: z.object({
    ...paginationQuery,
    status: z.enum(PAYMENT_STATUS_LIST).optional(),
    type: z.enum(PAYMENT_TYPE_LIST).optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
  }),
});

// ============ EXPENSES (money going out) ============
// Stage 1: approval (submitted -> approved or rejected)
// Stage 2: payment (pending -> confirmed). Both are needed before it counts as spent.

const expenseFields = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().trim().min(3, 'Describe the expense').max(500),
  amount: positiveMoney,
  expenseDate: pastOrTodayDateKey,
  vendorName: optional(z.string().trim().max(120)),
  billNumber: optional(z.string().trim().max(60)),
  receipts: z.array(fileRef.extend({ resourceType: z.enum(['image', 'raw']).default('image') })).max(5),
});

export const createExpenseSchema = z.object({
  params: projectParam,
  body: expenseFields.partial({ vendorName: true, billNumber: true, receipts: true }),
});

// Allowed only while the expense is submitted or rejected (the service checks)
export const updateExpenseSchema = z.object({
  params: z.object({ projectId: objectId, expenseId: objectId }),
  body: expenseFields
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

export const expenseIdSchema = z.object({
  params: z.object({ projectId: objectId, expenseId: objectId }),
});

export const reviewExpenseSchema = z.object({
  params: z.object({ projectId: objectId, expenseId: objectId }),
  body: z
    .object({
      decision: z.enum(['approved', 'rejected']),
      reviewNote: optional(z.string().trim().max(500)),
    })
    .refine((d) => d.decision !== 'rejected' || (d.reviewNote && d.reviewNote.length >= 5), {
      path: ['reviewNote'],
      message: 'Please explain why the expense is rejected (at least 5 characters)',
    }),
});

export const markExpensePaidSchema = z.object({
  params: z.object({ projectId: objectId, expenseId: objectId }),
  body: z
    .object({
      mode: z.enum(PAYMENT_MODE_LIST),
      reference: optional(z.string().trim().max(80)),
      paidAt: pastOrTodayDateKey,
    })
    .refine(...referenceRule),
});

export const cancelExpenseSchema = z.object({
  params: z.object({ projectId: objectId, expenseId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

export const listExpensesSchema = z.object({
  params: projectParam,
  query: z.object({
    ...paginationQuery,
    status: z.enum(APPROVAL_STATUS_LIST).optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    paid: boolQuery.optional(),
    submittedBy: objectId.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
  }),
});

// ============ SUMMARIES AND APPROVAL QUEUE ============

export const projectFinanceSummarySchema = z.object({ params: projectParam });

export const companyFinanceSummarySchema = z.object({
  query: z.object({ from: dateKey.optional(), to: dateKey.optional() }),
});

// Admin "Approvals" screen: everything waiting for a decision, across projects
export const pendingApprovalsSchema = z.object({
  query: z.object({
    ...paginationQuery,
    kind: z
      .enum(['report', 'expense', 'customer_payment', 'worker_wage', 'worker_payment'])
      .optional(),
    projectId: objectId.optional(),
  }),
});

export { idParam };