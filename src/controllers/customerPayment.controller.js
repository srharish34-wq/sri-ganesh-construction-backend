import CustomerPayment from '../models/CustomerPayment.js';
import * as finance from '../services/finance.service.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { projectFolder } from '../validators/media.validator.js';
import { ROLES, PAYMENT_STATUS as P, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd } from '../utils/dates.js';

const isAdmin = (user) => user.role === ROLES.SUPER_ADMIN;
const notFound = () => new ApiError(404, 'Payment not found');
const inr = (n) => `₹${n.toLocaleString('en-IN')}`;

function requireAdmin(req) {
  if (!isAdmin(req.user)) throw new ApiError(403, 'Only the admin can do this');
}

// Workers have no access to customer money at all
function blockWorker(req) {
  if (req.user.role === ROLES.WORKER) throw new ApiError(403, 'You do not have permission to do this');
}

/*
  Admin sees everything. An engineer sees only entries they recorded.
  A customer sees only CONFIRMED payments, without internal notes or who recorded them.
*/
function shapePayment(payment, role) {
  const obj = payment.toJSON();
  if (role === ROLES.SUPER_ADMIN) return obj;
  delete obj.proof;
  if (role === ROLES.CUSTOMER) {
    for (const key of ['notes', 'recordedBy', 'confirmedBy', 'rejectedBy', 'cancelledBy', 'rejectionReason', 'cancelReason', 'customer']) delete obj[key];
  }
  return obj;
}

async function findPayment(req) {
  const payment = await CustomerPayment.findOne({ _id: req.params.paymentId, project: req.project._id });
  if (!payment) throw notFound();
  const { role } = req.user;
  if (role === ROLES.CUSTOMER && payment.status !== P.CONFIRMED) throw notFound();
  if (role === ROLES.ENGINEER && !payment.recordedBy.equals(req.user._id)) throw notFound();
  return payment;
}

// POST /projects/:projectId/customer-payments   (admin or engineer)
// The entry starts as PENDING. It does not count as received until confirmed.
export const recordPayment = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }
  const { project, user } = { project: req.project, user: req.user };
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');

  if (req.body.proof && !req.body.proof.publicId.startsWith(projectFolder(project._id))) {
    throw new ApiError(400, 'The proof file was not uploaded to this project', [
      { field: 'proof', message: 'Upload the proof file again' },
    ]);
  }

  const payment = await CustomerPayment.create({
    ...req.body,
    paymentDate: dayStart(req.body.paymentDate),
    project: project._id,
    customer: project.customer,
    recordedBy: user._id,
    status: P.PENDING,
  });

  if (!isAdmin(user)) {
    await notifyAdmins({
      type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Customer payment to confirm',
      message: `${user.name} recorded ${inr(payment.amount)} for ${project.name}.`,
      project: project._id, entity: { kind: 'customer_payment', id: payment._id },
    });
  }
  await logAudit(req, {
    action: 'customer_payment.record', entityType: 'CustomerPayment', entityId: payment._id,
    project: project._id, after: payment,
  });
  res.status(201).json({ success: true, data: shapePayment(payment, user.role) });
});

// GET /projects/:projectId/customer-payments
export const listPayments = asyncHandler(async (req, res) => {
  blockWorker(req);
  const q = req.validated.query;
  const { role } = req.user;
  const paging = getPagination(q);
  const filter = { project: req.project._id };

  if (role === ROLES.CUSTOMER) filter.status = P.CONFIRMED;
  else {
    if (role === ROLES.ENGINEER) filter.recordedBy = req.user._id;
    if (q.status) filter.status = q.status;
  }
  if (q.type) filter.type = q.type;
  if (q.from || q.to) filter.paymentDate = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };

  const [rows, total] = await Promise.all([
    CustomerPayment.find(filter).sort({ paymentDate: -1, _id: -1 }).skip(paging.skip).limit(paging.limit),
    CustomerPayment.countDocuments(filter),
  ]);
  res.json({ success: true, data: buildPage(rows.map((p) => shapePayment(p, role)), total, paging) });
});

// GET /projects/:projectId/customer-payments/:paymentId
export const getPayment = asyncHandler(async (req, res) => {
  blockWorker(req);
  const payment = await findPayment(req);
  res.json({ success: true, data: shapePayment(payment, req.user.role) });
});

/*
  GET /projects/:projectId/customer-payments/summary
  Only CONFIRMED money counts as received. Engineers get no summary, because
  they cannot see the contract value.
*/
export const getSummary = asyncHandler(async (req, res) => {
  const { role } = req.user;
  if (role !== ROLES.SUPER_ADMIN && role !== ROLES.CUSTOMER) throw new ApiError(403, 'You do not have permission to do this');

  const totals = await finance.customerPaymentTotals(req.project._id);
  const contractValue = req.project.contractValue;
  const received = totals.confirmed.total;

  const data = {
    contractValue,
    received,
    outstanding: finance.round2(contractValue - received),
    percentPaid: contractValue > 0 ? Math.round((received / contractValue) * 1000) / 10 : 0,
    confirmedCount: totals.confirmed.count,
  };
  if (role === ROLES.SUPER_ADMIN) data.pending = totals.pending; // entered but not yet confirmed
  res.json({ success: true, data });
});

/*
  POST /projects/:projectId/customer-payments/:paymentId/confirm   (admin)
  Generates the receipt number. A payment that would take the total above the
  contract value is refused: raise the contract value first if there is a variation.
*/
export const confirmPayment = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const payment = await findPayment(req);
  if (payment.status !== P.PENDING) throw new ApiError(409, `This payment is already ${payment.status}`);

  const { confirmed } = await finance.customerPaymentTotals(req.project._id);
  if (confirmed.total + payment.amount > req.project.contractValue + 0.005) {
    throw new ApiError(
      409,
      `Confirming this would make the total received (${inr(finance.round2(confirmed.total + payment.amount))}) more than the contract value (${inr(req.project.contractValue)}). Update the contract value first if there is an extra work order.`
    );
  }

  payment.status = P.CONFIRMED;
  payment.confirmedBy = req.user._id;
  payment.confirmedAt = new Date();
  if (req.body.notes) payment.notes = [payment.notes, req.body.notes].filter(Boolean).join(' | ').slice(0, 500);

  for (let attempt = 0; ; attempt += 1) {
    payment.receiptNumber = await finance.nextReceiptNumber();
    try {
      await payment.save();
      break;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.receiptNumber && attempt < 4) continue;
      throw err;
    }
  }

  await notifyUsers([payment.customer, payment.recordedBy], {
    type: NOTIFICATION_TYPE.PAYMENT_UPDATE, title: 'Payment confirmed',
    message: `Payment of ${inr(payment.amount)} for ${req.project.name} is confirmed. Receipt ${payment.receiptNumber}.`,
    project: req.project._id, entity: { kind: 'customer_payment', id: payment._id },
  }, { exclude: req.user._id });
  await logAudit(req, {
    action: 'customer_payment.confirm', entityType: 'CustomerPayment', entityId: payment._id,
    project: req.project._id, after: { amount: payment.amount, receiptNumber: payment.receiptNumber },
  });
  res.json({ success: true, data: shapePayment(payment, req.user.role) });
});

// POST /projects/:projectId/customer-payments/:paymentId/reject   (admin)
export const rejectPayment = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const payment = await findPayment(req);
  if (payment.status !== P.PENDING) throw new ApiError(409, `Only pending payments can be rejected (this one is ${payment.status})`);

  payment.status = P.REJECTED;
  payment.rejectedBy = req.user._id;
  payment.rejectedAt = new Date();
  payment.rejectionReason = req.body.reason;
  await payment.save();

  await notifyUsers([payment.recordedBy], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT, title: 'Payment entry rejected',
    message: `The ${inr(payment.amount)} entry for ${req.project.name} was rejected: ${req.body.reason}`.slice(0, 500),
    project: req.project._id, entity: { kind: 'customer_payment', id: payment._id },
  }, { exclude: req.user._id });
  await logAudit(req, {
    action: 'customer_payment.reject', entityType: 'CustomerPayment', entityId: payment._id,
    project: req.project._id, note: req.body.reason,
  });
  res.json({ success: true, data: shapePayment(payment, req.user.role) });
});

/*
  POST /projects/:projectId/customer-payments/:paymentId/cancel   (admin)
  The only way to fix a confirmed payment: cancel it with a reason, then record
  the correct one. The receipt number stays on the cancelled record as history.
*/
export const cancelPayment = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const payment = await findPayment(req);
  if (![P.PENDING, P.CONFIRMED].includes(payment.status)) throw new ApiError(409, `This payment is already ${payment.status}`);

  const wasConfirmed = payment.status === P.CONFIRMED;
  payment.status = P.CANCELLED;
  payment.cancelledBy = req.user._id;
  payment.cancelledAt = new Date();
  payment.cancelReason = req.body.reason;
  await payment.save();

  if (wasConfirmed) {
    await notifyUsers([payment.customer], {
      type: NOTIFICATION_TYPE.PAYMENT_UPDATE, title: 'Payment entry cancelled',
      message: `A payment entry of ${inr(payment.amount)} for ${req.project.name} was cancelled. Please contact the office if you have questions.`,
      project: req.project._id, entity: { kind: 'customer_payment', id: payment._id },
    });
  }
  await logAudit(req, {
    action: 'customer_payment.cancel', entityType: 'CustomerPayment', entityId: payment._id,
    project: req.project._id, note: `${wasConfirmed ? 'Was confirmed. ' : ''}${req.body.reason}`,
  });
  res.json({ success: true, data: shapePayment(payment, req.user.role) });
});