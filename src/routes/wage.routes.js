import { Router } from 'express';
import * as ctrl from '../controllers/wage.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  createWageSchema,
  updateWageSchema,
  wageIdSchema,
  reviewWageSchema,
  cancelWageSchema,
  recordWorkerPaymentSchema,
  workerPaymentIdSchema,
  confirmWorkerPaymentSchema,
  rejectWorkerPaymentSchema,
  cancelWorkerPaymentSchema,
  acknowledgeWorkerPaymentSchema,
  raiseWageDisputeSchema,
  raisePaymentDisputeSchema,
  resolveDisputeSchema,
  listWagesSchema,
  listWorkerPaymentsSchema,
  workerBalanceSchema,
} from '../validators/wage.validator.js';

const { SUPER_ADMIN, ENGINEER } = ROLES;

// Creating records needs a project in the body. Only the admin or an assigned engineer may do it.
const staffOnProject = projectAccess({ from: 'body', roles: [SUPER_ADMIN, ENGINEER] });

// ================= WAGES (what was earned) =================
const wages = Router();
wages.use(authenticate);

wages.get('/', validate(listWagesSchema), ctrl.listWages); // filtered by role in the controller
wages.post('/', validate(createWageSchema), staffOnProject, ctrl.createWage);

// Routes with :wageId. The controller checks project access and ownership itself.
wages.get('/:wageId', validate(wageIdSchema), ctrl.getWage);
wages.patch('/:wageId', validate(updateWageSchema), ctrl.updateWage);
wages.post('/:wageId/review', validate(reviewWageSchema), ctrl.reviewWage);
wages.post('/:wageId/cancel', validate(cancelWageSchema), ctrl.cancelWage);
wages.post('/:wageId/dispute', validate(raiseWageDisputeSchema), ctrl.raiseWageDispute);

// ================= WORKER PAYMENTS (what was paid) =================
const payments = Router();
payments.use(authenticate);

payments.get('/', validate(listWorkerPaymentsSchema), ctrl.listWorkerPayments);
payments.post('/', validate(recordWorkerPaymentSchema), staffOnProject, ctrl.recordWorkerPayment);

payments.get('/:paymentId', validate(workerPaymentIdSchema), ctrl.getWorkerPayment);
payments.post('/:paymentId/confirm', validate(confirmWorkerPaymentSchema), ctrl.confirmWorkerPayment);
payments.post('/:paymentId/reject', validate(rejectWorkerPaymentSchema), ctrl.rejectWorkerPayment);
payments.post('/:paymentId/cancel', validate(cancelWorkerPaymentSchema), ctrl.cancelWorkerPayment);
payments.post('/:paymentId/acknowledge', validate(acknowledgeWorkerPaymentSchema), ctrl.acknowledgeWorkerPayment);
payments.post('/:paymentId/dispute', validate(raisePaymentDisputeSchema), ctrl.raisePaymentDispute);

// ================= DISPUTES AND BALANCE =================
const disputes = Router();
disputes.use(authenticate);
// kind is "wage" or "payment"
disputes.post('/:kind/:id/resolve', validate(resolveDisputeSchema), ctrl.resolveDispute);

const workers = Router();
workers.use(authenticate);
workers.get('/:workerId/balance', validate(workerBalanceSchema), ctrl.getWorkerBalance);

// ================= Combined router (mount at the API root) =================
const router = Router();
router.use('/wages', wages);
router.use('/worker-payments', payments);
router.use('/disputes', disputes);
router.use('/workers', workers);

export default router;