import { z } from 'zod';
import { PROJECT_STATUS_LIST } from '../config/constants.js';
import {
  objectId, idParam, optional, dateField, money, pincode,
  latitude, longitude, boolQuery, paginationQuery,
} from './common.validator.js';

const addressBody = z.object({
  line1: z.string().trim().min(3, 'Enter the site address').max(200),
  city: optional(z.string().trim().max(80)),
  state: optional(z.string().trim().max(80)),
  pincode: optional(pincode),
});

// GPS position of the site, used to check attendance. Both coordinates or neither.
const siteLocationBody = z
  .object({
    latitude,
    longitude,
    radiusMeters: z.number().min(10).max(5000).optional(),
  })
  .strict();

const projectFields = z.object({
  name: z.string().trim().min(3, 'Enter the project name').max(150),
  description: optional(z.string().trim().max(2000)),
  address: addressBody,
  siteLocation: siteLocationBody.optional(),
  customerId: objectId,
  budget: money,
  contractValue: money,
  startDate: dateField,
  expectedEndDate: dateField,
  status: z.enum(PROJECT_STATUS_LIST),
});

const datesInOrder = (d) => !d.startDate || !d.expectedEndDate || d.expectedEndDate >= d.startDate;
const datesMessage = {
  path: ['expectedEndDate'],
  message: 'Completion date cannot be before the start date',
};

// projectCode and progressPercent are NOT accepted here:
// the server generates the code and calculates the progress.
export const createProjectSchema = z.object({
  body: projectFields
    .partial({ description: true, siteLocation: true, status: true })
    .refine(datesInOrder, datesMessage),
});

export const updateProjectSchema = z.object({
  params: idParam('projectId'),
  body: projectFields
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' })
    .refine(datesInOrder, datesMessage),
});

export const projectIdSchema = z.object({ params: idParam('projectId') });

// Delayed and On Hold projects must explain why
export const changeStatusSchema = z.object({
  params: idParam('projectId'),
  body: z
    .object({
      status: z.enum(PROJECT_STATUS_LIST),
      reason: optional(z.string().trim().max(500)),
    })
    .refine((d) => !['on_hold', 'delayed'].includes(d.status) || (d.reason && d.reason.length >= 5), {
      path: ['reason'],
      message: 'Please give a reason (at least 5 characters)',
    }),
});

export const archiveProjectSchema = z.object({
  params: idParam('projectId'),
  body: z.object({ reason: optional(z.string().trim().max(300)) }),
});

export const listProjectsSchema = z.object({
  query: z.object({
    ...paginationQuery,
    search: z.string().trim().max(100).optional(),
    status: z.enum(PROJECT_STATUS_LIST).optional(),
    engineerId: objectId.optional(),
    customerId: objectId.optional(),
    from: dateField.optional(), // start date on or after
    to: dateField.optional(), // start date on or before
    archived: boolQuery.optional(), // admin only
    sort: z
      .enum(['newest', 'oldest', 'deadline', 'name', 'progress', 'contractValue'])
      .default('newest'),
  }),
});

// Assign or remove engineers and workers
export const assignUsersSchema = z.object({
  params: idParam('projectId'),
  body: z.object({
    userIds: z
      .array(objectId)
      .min(1, 'Select at least one person')
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate people in the list'),
  }),
});

export const unassignUserSchema = z.object({
  params: z.object({ projectId: objectId, userId: objectId }),
});