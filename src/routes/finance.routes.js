import { Router } from 'express';
import * as payments from '../controllers/customerPayment.controller.js';
import * as expenses from '../controllers/expense.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  recordCustomerPaymentSchema,
  customerPaymentIdSchema,
  confirmCustomerPaymentSchema,
  rejectCustomerPaymentSchema,
  cancelCustomerPaymentSchema,
  listCustomerPaymentsSchema,
  createExpenseSchema,
  updateExpenseSchema,
  expenseIdSchema,
  reviewExpenseSchema,
  markExpensePaidSchema,
  cancelExpenseSchema,
  listExpensesSchema,
  projectFinanceSummarySchema,
} from '../validators/finance.validator.js';

const { SUPER_ADMIN, ENGINEER, CUSTOMER } = ROLES;

// ================= CUSTOMER PAYMENTS (money coming in) =================
// Mounted under /projects/:projectId/customer-payments
// Workers have no access. The customer sees only confirmed payments. The controller enforces the details.
const paymentsRouter = Router({ mergeParams: true });
paymentsRouter.use(authenticate);
const paymentUsers = projectAccess({ roles: [SUPER_ADMIN, ENGINEER, CUSTOMER] });

paymentsRouter.get('/', validate(listCustomerPaymentsSchema), paymentUsers, payments.listPayments);
paymentsRouter.post('/', validate(recordCustomerPaymentSchema), paymentUsers, payments.recordPayment);
// "summary" must come before "/:paymentId", or it would be read as an ID
paymentsRouter.get('/summary', validate(projectFinanceSummarySchema), paymentUsers, payments.getSummary);
paymentsRouter.get('/:paymentId', validate(customerPaymentIdSchema), paymentUsers, payments.getPayment);
paymentsRouter.post('/:paymentId/confirm', validate(confirmCustomerPaymentSchema), paymentUsers, payments.confirmPayment);
paymentsRouter.post('/:paymentId/reject', validate(rejectCustomerPaymentSchema), paymentUsers, payments.rejectPayment);
paymentsRouter.post('/:paymentId/cancel', validate(cancelCustomerPaymentSchema), paymentUsers, payments.cancelPayment);

// ================= EXPENSES (money going out) =================
// Mounted under /projects/:projectId/expenses
// Admin and the project's engineers only. Customers and workers never see expenses.
const expensesRouter = Router({ mergeParams: true });
expensesRouter.use(authenticate);
const expenseStaff = projectAccess({ roles: [SUPER_ADMIN, ENGINEER] });

expensesRouter.get('/', validate(listExpensesSchema), expenseStaff, expenses.listExpenses);
expensesRouter.post('/', validate(createExpenseSchema), expenseStaff, expenses.createExpense);
// "summary" must come before "/:expenseId"
expensesRouter.get('/summary', validate(projectFinanceSummarySchema), expenseStaff, expenses.getSummary);
expensesRouter.get('/:expenseId', validate(expenseIdSchema), expenseStaff, expenses.getExpense);
expensesRouter.patch('/:expenseId', validate(updateExpenseSchema), expenseStaff, expenses.updateExpense);
expensesRouter.post('/:expenseId/review', validate(reviewExpenseSchema), expenseStaff, expenses.reviewExpense);
expensesRouter.post('/:expenseId/pay', validate(markExpensePaidSchema), expenseStaff, expenses.markPaid);
expensesRouter.post('/:expenseId/cancel', validate(cancelExpenseSchema), expenseStaff, expenses.cancelExpense);

// ================= Combined router =================
const router = Router({ mergeParams: true });
router.use('/customer-payments', paymentsRouter);
router.use('/expenses', expensesRouter);

export default router;