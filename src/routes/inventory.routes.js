import { Router } from 'express';
import * as ctrl from '../controllers/inventory.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  createItemSchema,
  updateItemSchema,
  itemIdSchema,
  listItemsSchema,
  createTransactionSchema,
  voidTransactionSchema,
  listTransactionsSchema,
  recalculateItemSchema,
} from '../validators/inventory.validator.js';

// Mounted at /projects/:projectId/inventory, so :projectId comes from the parent path
const router = Router({ mergeParams: true });
router.use(authenticate);

// Inventory is for the admin and the project's engineers. The controller checks again.
const staff = projectAccess({ roles: [ROLES.SUPER_ADMIN, ROLES.ENGINEER] });

// ---- Materials ----
router.get('/items', validate(listItemsSchema), staff, ctrl.listItems);
router.post('/items', validate(createItemSchema), staff, ctrl.createItem);
router.get('/items/:itemId', validate(itemIdSchema), staff, ctrl.getItem);
router.patch('/items/:itemId', validate(updateItemSchema), staff, ctrl.updateItem);
router.post('/items/:itemId/recalculate', validate(recalculateItemSchema), staff, ctrl.recalculateItem);

// ---- Stock transactions (never edited or deleted, only voided) ----
router.get('/transactions', validate(listTransactionsSchema), staff, ctrl.listTransactions);
router.post('/transactions', validate(createTransactionSchema), staff, ctrl.createTransaction);
router.post('/transactions/:transactionId/void', validate(voidTransactionSchema), staff, ctrl.voidTransaction);

export default router;