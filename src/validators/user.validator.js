import { z } from 'zod';
import { ROLES } from '../config/constants.js';
import {
  objectId, idParam, optional, email, phone, pincode, money, password,
  boolQuery, paginationQuery,
} from './common.validator.js';

// Roles an admin can create through the API. The Super Admin is created
// only by the seed script, so nobody can create another one through the app.
const creatableRole = z.enum([ROLES.ENGINEER, ROLES.WORKER, ROLES.CUSTOMER]);

const addressBody = z.object({
  line1: optional(z.string().trim().max(200)),
  city: optional(z.string().trim().max(80)),
  state: optional(z.string().trim().max(80)),
  pincode: optional(pincode),
});

// Extra details stored for customers
const customerProfileBody = z.object({
  companyName: optional(z.string().trim().max(150)),
  alternatePhone: optional(phone),
  address: addressBody.optional(),
  internalNotes: optional(z.string().trim().max(2000)),
});

const createUserBody = z
  .object({
    name: z.string().trim().min(2, 'Enter the full name').max(100),
    role: creatableRole,
    email: optional(email),
    phone: optional(phone),
    password,
    // Workers only
    trade: optional(z.string().trim().max(60)),
    dailyWageRate: optional(money),
    // Customers only
    customerProfile: customerProfileBody.optional(),
  })
  .refine((d) => d.email || d.phone, {
    path: ['email'],
    message: 'Provide an email or a phone number so the person can log in',
  });

export const createUserSchema = z.object({ body: createUserBody });

const updateUserBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: optional(email),
    phone: optional(phone),
    isActive: z.boolean(),
    trade: optional(z.string().trim().max(60)),
    dailyWageRate: optional(money),
    customerProfile: customerProfileBody,
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' });

// The role cannot be changed after the account is created
export const updateUserSchema = z.object({
  params: idParam('id'),
  body: updateUserBody,
});

export const userIdSchema = z.object({ params: idParam('id') });

// Admin sets a new password for a user who is locked out
export const adminResetPasswordSchema = z.object({
  params: idParam('id'),
  body: z.object({ newPassword: password }),
});

export const listUsersSchema = z.object({
  query: z.object({
    ...paginationQuery,
    role: z.enum([ROLES.ENGINEER, ROLES.WORKER, ROLES.CUSTOMER, ROLES.SUPER_ADMIN]).optional(),
    isActive: boolQuery.optional(),
    search: z.string().trim().max(100).optional(),
    projectId: objectId.optional(), // only people assigned to this project
  }),
});