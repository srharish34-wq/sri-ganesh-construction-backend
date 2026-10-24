import { z } from 'zod';
import { PAGINATION } from '../config/constants.js';

// ---------- IDs ----------
export const objectId = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Invalid ID');

export const idParam = (name = 'id') => z.object({ [name]: objectId });

// ---------- Form helpers ----------
// Turns '' or null from a form into "not provided"
export const optional = (schema) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

// Required explanation text (rejections, voids, corrections, cancellations)
export const reason = (min = 5, max = 300) =>
  z
    .string()
    .trim()
    .min(min, `Please give a reason (at least ${min} characters)`)
    .max(max);

export const uniqueList = (list) => new Set(list).size === list.length;

// ---------- Dates ----------
// ISO date or date-time string -> Date object
export const dateField = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date')
  .transform((v) => new Date(v));

// 'YYYY-MM-DD'
export const dateKey = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');

// Today's date in Indian time as 'YYYY-MM-DD'
export const todayKey = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Today or earlier (reports, payments and expenses cannot be dated in the future)
export const pastOrTodayDateKey = dateKey.refine((v) => v <= todayKey(), 'Date cannot be in the future');

// ---------- Contact ----------
export const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{10,15}$/, 'Enter a valid phone number'));

export const email = z.string().trim().toLowerCase().email('Enter a valid email').max(150);
export const pincode = z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits');

// ---------- Numbers ----------
const hasAtMostDecimals = (places) => (v) =>
  Math.abs(v * 10 ** places - Math.round(v * 10 ** places)) < 1e-6;

// Rupees, can be zero
export const money = z
  .number({ invalid_type_error: 'Enter an amount' })
  .min(0, 'Amount cannot be negative')
  .max(100000000000, 'Amount is too large');

// Rupees that must be more than zero, with at most 2 decimals
export const positiveMoney = z
  .number({ invalid_type_error: 'Enter an amount' })
  .min(0.01, 'Enter an amount greater than zero')
  .max(100000000000, 'Amount is too large')
  .refine(hasAtMostDecimals(2), 'Use at most 2 decimal places');

// Material quantity: more than zero, at most 4 decimals
export const quantity = z
  .number({ invalid_type_error: 'Enter a quantity' })
  .positive('Quantity must be greater than zero')
  .max(1000000000, 'Quantity is too large')
  .refine(hasAtMostDecimals(4), 'Use at most 4 decimal places');

export const percent = z.number().min(0).max(100);
export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);

// ---------- Query strings ----------
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION.MAX_LIMIT)
    .default(PAGINATION.DEFAULT_LIMIT),
};

// ---------- Passwords ----------
// 8-72 characters (bcrypt only reads the first 72), a letter and a number
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password needs at least one letter')
  .regex(/\d/, 'Password needs at least one number');