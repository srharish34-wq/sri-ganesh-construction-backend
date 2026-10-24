import { z } from 'zod';
import { MATERIAL_CATEGORIES, UNITS, INVENTORY_TXN_TYPE } from '../config/constants.js';
import {
  objectId, idParam, optional, phone, quantity, money, dateKey,
  pastOrTodayDateKey, boolQuery, paginationQuery, reason,
} from './common.validator.js';

const projectParam = z.object({ projectId: objectId });
const itemParams = z.object({ projectId: objectId, itemId: objectId });

const supplierBody = z.object({
  name: optional(z.string().trim().max(120)),
  phone: optional(phone),
});

export const createItemSchema = z.object({
  params: projectParam,
  body: z.object({
    name: z.string().trim().min(2, 'Enter the material name').max(100),
    category: z.enum(MATERIAL_CATEGORIES),
    unit: z.enum(UNITS),
    supplier: supplierBody.optional(),
    minStockThreshold: z.number().min(0).max(1000000000).optional(),
    // Only the admin may switch this on (the service enforces it)
    allowNegativeStock: z.boolean().optional(),
    // Creates an "opening" stock entry together with the item
    openingQuantity: quantity.optional(),
  }),
});

// The unit cannot change, because past entries are counted in it
export const updateItemSchema = z.object({
  params: itemParams,
  body: z
    .object({
      name: z.string().trim().min(2).max(100),
      category: z.enum(MATERIAL_CATEGORIES),
      supplier: supplierBody,
      minStockThreshold: z.number().min(0).max(1000000000),
      allowNegativeStock: z.boolean(),
      isActive: z.boolean(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

const { RECEIVED, USED, RETURNED, ADJUSTMENT } = INVENTORY_TXN_TYPE;

// "opening" is not allowed here. It is created with the item.
export const createTransactionSchema = z.object({
  params: projectParam,
  body: z
    .object({
      itemId: objectId,
      type: z.enum([RECEIVED, USED, RETURNED, ADJUSTMENT]),
      direction: z.enum(['increase', 'decrease']).optional(), // adjustments only
      quantity,
      transactionDate: pastOrTodayDateKey.optional(), // server uses today if missing
      reference: optional(z.string().trim().max(80)), // challan or bill number
      supplierName: optional(z.string().trim().max(120)),
      unitCost: optional(money),
      notes: optional(z.string().trim().max(500)),
      reason: optional(z.string().trim().max(300)),
    })
    .refine((d) => d.type !== ADJUSTMENT || d.direction, {
      path: ['direction'],
      message: 'Choose increase or decrease for an adjustment',
    })
    .refine((d) => d.type === ADJUSTMENT || !d.direction, {
      path: ['direction'],
      message: 'Direction is only for adjustments',
    })
    .refine((d) => d.type !== ADJUSTMENT || (d.reason && d.reason.length >= 5), {
      path: ['reason'],
      message: 'Explain the adjustment (at least 5 characters)',
    }),
});

// Mistakes are voided with a reason, never edited or deleted
export const voidTransactionSchema = z.object({
  params: z.object({ projectId: objectId, transactionId: objectId }),
  body: z.object({ reason: reason(5, 300) }),
});

export const listItemsSchema = z.object({
  params: projectParam,
  query: z.object({
    ...paginationQuery,
    search: z.string().trim().max(100).optional(),
    category: z.enum(MATERIAL_CATEGORIES).optional(),
    lowStock: boolQuery.optional(),
    isActive: boolQuery.optional(),
  }),
});

export const itemIdSchema = z.object({ params: itemParams });

export const listTransactionsSchema = z.object({
  params: projectParam,
  query: z.object({
    ...paginationQuery,
    itemId: objectId.optional(),
    type: z.enum(Object.values(INVENTORY_TXN_TYPE)).optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
    includeVoided: boolQuery.optional(),
  }),
});

// Recalculate a cached balance from the transactions (admin tool)
export const recalculateItemSchema = z.object({ params: itemParams });

export { idParam };