import Expense from '../models/Expense.js';
import WorkerPayment from '../models/WorkerPayment.js';
import cloudinary, { isCloudinaryConfigured } from '../config/cloudinary.js';
import * as mediaService from '../services/media.service.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { projectFolder } from '../validators/media.validator.js';
import { ROLES, APPROVAL_STATUS as S, PAYMENT_STATUS as P, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd } from '../utils/dates.js';

const isAdmin = (u) => u.role === ROLES.SUPER_ADMIN;
const round2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => `₹${n.toLocaleString('en-IN')}`;

// Expenses are for the admin and the project's engineers only
function staffOnly(req) {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }
}
function adminOnly(req) {
  if (!isAdmin(req.user)) throw new ApiError(403, 'Only the admin can do this');
}
function assertWritable(project) {
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
}

// Receipts are private files. The app gets signed links, never the stored URL.
function receiptLink(r) {
  if (!isCloudinaryConfigured) return null;
  return cloudinary.url(r.publicId, {
    resource_type: r.resourceType === 'raw' ? 'raw' : 'image',
    type: 'authenticated',
    sign_url: true,
    secure: true,
  });
}

function shapeExpense(expense) {
  const obj = expense.toJSON();
  obj.receipts = (expense.receipts || []).map((r) => ({
    publicId: r.publicId,
    resourceType: r.resourceType,
    url: receiptLink(r),
  }));
  return obj;
}

// Receipts must sit in this project's folder AND really exist in Cloudinary
async function checkReceipts(project, receipts = []) {
  for (const r of receipts) {
    if (r.resourceType !== 'image' || !r.publicId.startsWith(projectFolder(project._id))) {
      throw new ApiError(400, 'A receipt was not uploaded to this project', [
        { field: 'receipts', message: 'Upload the receipt again' },
      ]);
    }
  }
  if (receipts.length) {
    await Promise.all(receipts.map((r) => mediaService.verifyUpload(r.publicId, 'image')));
  }
}

async function findExpense(req) {
  const expense = await Expense.findOne({ _id: req.params.expenseId, project: req.project._id });
  const foreign = req.user.role === ROLES.ENGINEER && expense && !expense.submittedBy.equals(req.user._id);
  if (!expense || foreign) throw new ApiError(404, 'Expense not found');
  return expense;
}

// POST /projects/:projectId/expenses   (admin or engineer)
export const createExpense = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const { receipts = [], expenseDate, ...fields } = req.body;
  await checkReceipts(req.project, receipts);

  // The same vendor bill cannot be entered twice
  if (fields.billNumber && fields.vendorName) {
    const dup = await Expense.findOne({
      project: req.project._id,
      vendorName: fields.vendorName,
      billNumber: fields.billNumber,
      isCancelled: false,
      status: { $ne: S.REJECTED },
    });
    if (dup) throw new ApiError(409, 'An expense with this vendor and bill number already exists');
  }

  const expense = await Expense.create({
    ...fields,
    receipts,
    expenseDate: dayStart(expenseDate),
    project: req.project._id,
    submittedBy: req.user._id,
    status: S.SUBMITTED,
  });

  if (!isAdmin(req.user)) {
    await notifyAdmins({
      type: NOTIFICATION_TYPE.APPROVAL_PENDING,
      title: 'Expense to approve',
      message: `${req.user.name} submitted ${inr(expense.amount)} (${expense.category}) for ${req.project.name}.`,
      project: req.project._id,
      entity: { kind: 'expense', id: expense._id },
    });
  }
  await logAudit(req, {
    action: 'expense.submit', entityType: 'Expense', entityId: expense._id,
    project: req.project._id, after: expense,
  });
  res.status(201).json({ success: true, data: shapeExpense(expense) });
});

// GET /projects/:projectId/expenses   (engineers see only their own)
export const listExpenses = asyncHandler(async (req, res) => {
  staffOnly(req);
  const q = req.validated.query;
  const paging = getPagination(q);
  const filter = { project: req.project._id };

  if (req.user.role === ROLES.ENGINEER) filter.submittedBy = req.user._id;
  else if (q.submittedBy) filter.submittedBy = q.submittedBy;
  if (q.status) filter.status = q.status;
  if (q.category) filter.category = q.category;
  if (q.paid === true) { filter.status = S.APPROVED; filter['payment.status'] = P.CONFIRMED; }
  if (q.paid === false) filter['payment.status'] = { $ne: P.CONFIRMED };
  if (q.from || q.to) {
    filter.expenseDate = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };
  }

  const [rows, total] = await Promise.all([
    Expense.find(filter)
      .sort({ expenseDate: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .populate('submittedBy', 'name'),
    Expense.countDocuments(filter),
  ]);
  res.json({ success: true, data: buildPage(rows.map(shapeExpense), total, paging) });
});

// GET /projects/:projectId/expenses/:expenseId
export const getExpense = asyncHandler(async (req, res) => {
  staffOnly(req);
  const expense = await findExpense(req);
  await expense.populate([
    { path: 'submittedBy', select: 'name' },
    { path: 'reviewedBy', select: 'name' },
  ]);
  res.json({ success: true, data: shapeExpense(expense) });
});

/*
  PATCH /projects/:projectId/expenses/:expenseId
  Only the person who submitted it, and only while it is submitted or rejected.
  Editing a rejected expense sends it for approval again.
*/
export const updateExpense = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const expense = await findExpense(req);

  if (!expense.submittedBy.equals(req.user._id)) throw new ApiError(403, 'Only the person who submitted this expense can edit it');
  if (expense.isCancelled) throw new ApiError(409, 'This expense is cancelled');
  if (![S.SUBMITTED, S.REJECTED].includes(expense.status)) {
    throw new ApiError(409, 'An approved expense cannot be edited. Ask the admin to cancel it.');
  }

  const before = expense.toJSON();
  if (req.body.receipts) await checkReceipts(req.project, req.body.receipts);
  for (const [key, value] of Object.entries(req.body)) {
    if (value === undefined) continue;
    expense.set(key, key === 'expenseDate' ? dayStart(value) : value);
  }

  const wasRejected = expense.status === S.REJECTED;
  if (wasRejected) {
    expense.status = S.SUBMITTED;
    expense.reviewedBy = undefined;
    expense.reviewedAt = undefined;
    expense.reviewNote = undefined;
  }
  await expense.save();

  if (wasRejected && !isAdmin(req.user)) {
    await notifyAdmins({
      type: NOTIFICATION_TYPE.APPROVAL_PENDING,
      title: 'Expense resubmitted',
      message: `${req.user.name} corrected and resubmitted an expense for ${req.project.name}.`,
      project: req.project._id,
      entity: { kind: 'expense', id: expense._id },
    });
  }
  await logAudit(req, {
    action: wasRejected ? 'expense.resubmit' : 'expense.update', entityType: 'Expense',
    entityId: expense._id, project: req.project._id, before: { ...before, receipts: undefined }, after: { ...expense.toJSON(), receipts: undefined },
  });
  res.json({ success: true, data: shapeExpense(expense) });
});

// POST /projects/:projectId/expenses/:expenseId/review   (admin)
export const reviewExpense = asyncHandler(async (req, res) => {
  adminOnly(req);
  const expense = await findExpense(req);
  if (expense.isCancelled) throw new ApiError(409, 'This expense is cancelled');
  if (expense.status !== S.SUBMITTED) throw new ApiError(409, 'Only submitted expenses can be reviewed');

  const { decision, reviewNote } = req.body;
  expense.status = decision === 'approved' ? S.APPROVED : S.REJECTED;
  expense.reviewedBy = req.user._id;
  expense.reviewedAt = new Date();
  expense.reviewNote = reviewNote;
  await expense.save();

  await notifyUsers([expense.submittedBy], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT,
    title: `Expense ${decision}`,
    message: `Your ${inr(expense.amount)} expense for ${req.project.name} was ${decision}.${reviewNote ? ` ${reviewNote}` : ''}`.slice(0, 500),
    project: req.project._id,
    entity: { kind: 'expense', id: expense._id },
  }, { exclude: req.user._id });
  await logAudit(req, {
    action: `expense.${decision === 'approved' ? 'approve' : 'reject'}`, entityType: 'Expense',
    entityId: expense._id, project: req.project._id, note: reviewNote,
  });
  res.json({ success: true, data: shapeExpense(expense) });
});

// POST /projects/:projectId/expenses/:expenseId/pay   (admin)
// Stage 2: only an approved expense can be marked as paid. Until then it is a pending payment.
export const markPaid = asyncHandler(async (req, res) => {
  adminOnly(req);
  const expense = await findExpense(req);
  if (expense.isCancelled) throw new ApiError(409, 'This expense is cancelled');
  if (expense.status !== S.APPROVED) throw new ApiError(409, 'Approve the expense before marking it as paid');
  if (expense.payment?.status === P.CONFIRMED) throw new ApiError(409, 'This expense is already marked as paid');

  const { mode, reference, paidAt } = req.body;
  expense.payment = {
    status: P.CONFIRMED,
    mode,
    reference,
    paidAt: dayStart(paidAt),
    confirmedBy: req.user._id,
  };
  await expense.save();

  await notifyUsers([expense.submittedBy], {
    type: NOTIFICATION_TYPE.PAYMENT_UPDATE,
    title: 'Expense paid',
    message: `Your ${inr(expense.amount)} expense for ${req.project.name} has been paid.`,
    project: req.project._id,
    entity: { kind: 'expense', id: expense._id },
  }, { exclude: req.user._id });
  await logAudit(req, {
    action: 'expense.mark_paid', entityType: 'Expense', entityId: expense._id,
    project: req.project._id, after: { amount: expense.amount, mode, reference, paidAt },
  });
  res.json({ success: true, data: shapeExpense(expense) });
});

/*
  POST /projects/:projectId/expenses/:expenseId/cancel
  Admin: any expense. Engineer: their own, only before it is approved.
  Cancelled expenses stay in the history but never count in totals.
*/
export const cancelExpense = asyncHandler(async (req, res) => {
  staffOnly(req);
  const expense = await findExpense(req);
  if (expense.isCancelled) throw new ApiError(409, 'This expense is already cancelled');
  if (!isAdmin(req.user) && ![S.SUBMITTED, S.REJECTED].includes(expense.status)) {
    throw new ApiError(403, 'Only the admin can cancel an approved expense');
  }

  const wasPaid = expense.payment?.status === P.CONFIRMED;
  expense.isCancelled = true;
  expense.cancelReason = req.body.reason;
  expense.cancelledBy = req.user._id;
  await expense.save();

  await logAudit(req, {
    action: 'expense.cancel', entityType: 'Expense', entityId: expense._id,
    project: req.project._id, note: `${wasPaid ? 'Was paid. ' : ''}${req.body.reason}`,
  });
  res.json({ success: true, data: shapeExpense(expense) });
});

/*
  GET /projects/:projectId/expenses/summary   (admin)
  "Spent" = paid expenses + confirmed worker payments. Approved but unpaid
  expenses are shown separately as pending payments.
*/
export const getSummary = asyncHandler(async (req, res) => {
  adminOnly(req);
  const match = { project: req.project._id, isCancelled: false };

  const [rows, byCategory, workerRows] = await Promise.all([
    Expense.aggregate([
      { $match: match },
      { $group: { _id: { status: '$status', paid: '$payment.status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { ...match, status: S.APPROVED } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
    WorkerPayment.aggregate([
      { $match: { project: req.project._id, status: P.CONFIRMED } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const total = (fn) => round2(rows.filter(fn).reduce((t, r) => t + r.total, 0));
  const count = (fn) => rows.filter(fn).reduce((t, r) => t + r.count, 0);
  const paid = (r) => r._id.status === S.APPROVED && r._id.paid === P.CONFIRMED;
  const unpaid = (r) => r._id.status === S.APPROVED && r._id.paid !== P.CONFIRMED;
  const waiting = (r) => r._id.status === S.SUBMITTED;

  const expensesPaid = total(paid);
  const workerPaid = round2(workerRows[0]?.total ?? 0);
  const spent = round2(expensesPaid + workerPaid);
  const { budget } = req.project;

  res.json({
    success: true,
    data: {
      budget,
      expensesPaid,
      workerPaid,
      spent,
      budgetRemaining: round2(budget - spent),
      percentOfBudgetUsed: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0,
      isOverBudget: spent > budget,
      approvedUnpaid: { total: total(unpaid), count: count(unpaid) },
      awaitingApproval: { total: total(waiting), count: count(waiting) },
      byCategory: byCategory.map((c) => ({ category: c._id, total: round2(c.total), count: c.count })),
    },
  });
});