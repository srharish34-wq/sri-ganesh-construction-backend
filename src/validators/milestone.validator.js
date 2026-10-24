import { z } from 'zod';
import {
  objectId, idParam, optional, dateField, percent,
} from './common.validator.js';

// 'overdue' is not allowed here. The server works it out from the due date.
const settableStatus = z.enum(['pending', 'in_progress', 'completed']);

const milestoneFields = z.object({
  title: z.string().trim().min(3, 'Enter a milestone title').max(150),
  description: optional(z.string().trim().max(1000)),
  order: z.number().int().min(1).max(500), // if omitted, the server uses the next number
  dueDate: dateField,
  weightPercent: percent, // share of the whole project
  isCustomerVisible: z.boolean(),
});

const projectParam = z.object({ projectId: objectId });
const milestoneParams = z.object({ projectId: objectId, milestoneId: objectId });

export const createMilestoneSchema = z.object({
  params: projectParam,
  body: milestoneFields.partial({
    description: true,
    order: true,
    weightPercent: true,
    isCustomerVisible: true,
  }),
});

// Create a whole plan in one go. The weights must not add up to more than 100.
export const bulkCreateMilestonesSchema = z.object({
  params: projectParam,
  body: z.object({
    milestones: z
      .array(
        milestoneFields.partial({
          description: true,
          order: true,
          weightPercent: true,
          isCustomerVisible: true,
        })
      )
      .min(1)
      .max(40)
      .refine(
        (list) => list.reduce((sum, m) => sum + (m.weightPercent ?? 0), 0) <= 100.0001,
        'Milestone weights cannot add up to more than 100%'
      ),
  }),
});

// Admin edit of the plan
export const updateMilestoneSchema = z.object({
  params: milestoneParams,
  body: milestoneFields
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

// Engineer progress update
export const updateMilestoneProgressSchema = z.object({
  params: milestoneParams,
  body: z
    .object({
      status: settableStatus,
      progressPercent: percent.optional(),
      delayReason: optional(z.string().trim().max(500)),
    })
    .refine((d) => d.status !== 'completed' || d.progressPercent === undefined || d.progressPercent === 100, {
      path: ['progressPercent'],
      message: 'A completed milestone must be 100%',
    }),
});

export const milestoneParamsSchema = z.object({ params: milestoneParams });
export const projectMilestonesSchema = z.object({
  params: projectParam,
  query: z.object({
    status: z.enum(['pending', 'in_progress', 'completed', 'overdue']).optional(),
  }),
});

export { idParam };