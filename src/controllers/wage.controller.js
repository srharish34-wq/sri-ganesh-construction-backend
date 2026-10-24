import mongoose from 'mongoose';
import WorkerWage from '../models/WorkerWage.js';
import WorkerPayment from '../models/WorkerPayment.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Attendance from '../models/Attendance.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyProjectEngineers, notifyUsers } from '../services/notification.service.js';
import { resolveProjectAccess, accessibleProjectFilter } from '../middleware/projectAccess.js';
import { ROLES, APPROVAL_STATUS as S, PAYMENT_STATUS as P, ATTENDANCE_STATUS as A, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd, keyOf } from '../utils/dates.js';

const isAdmin = (u) => u.role === ROLES.SUPER_ADMIN;
const round2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
const toId = (id) => new mongoose.Types.ObjectId(String(id));
const notFound = () => new ApiError(404, 'Record not found');
const EPS = 0.005;

function staffOnly(req) {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }
}
function adminOnly(req) {
  if (!isAdmin(req.user)) throw new ApiError(403, 'Only the admin can do this');
}
function workerOnly(req) {
  if (req.user.role !== ROLES.WORKER) throw new ApiError(403, 'Only workers can do this');
}

// Workers see their own figures but not the internal review details
const WORKER_HIDDEN = [
  'createdBy', 'reviewedBy', 'reviewedAt', 'reviewNote',
  'recordedBy', 'confirmedBy', 'rejectedBy', 'rejectionReason', 'cancelReason',
];
function shape(doc, user) {
  const obj = doc.toJSON();
  if (user.role === ROLES.WORKER) WORKER_HIDDEN.forEach((k) => delete obj[k]);
  return obj;
}

// Staff must have access to the project. A worker may always see their OWN records,
// even after being moved off the project, because wages can still be owed.
async function openProject(req, projectId) {
  const project = await Project.findById(projectId);
  if (req.user.role === ROLES.WORKER) {
    if (!project) throw notFound();
    return project;
  }
  const access = project && (await resolveProjectAccess(req.user, project));
  if (!access || (project.isArchived && !isAdmin(req.user))) throw new ApiError(404, 'Project not found');
  return project;
}

async function loadWage(req, id) {
  const wage = await WorkerWage.findById(id);
  if (!wage) throw notFound();
  const { user } = req;
  if (user.role === ROLES.CUSTOMER) throw notFound();
  if (user.role === ROLES.WORKER && (!wage.worker.equals(user._id) || wage.status !== S.APPROVED || wage.isCancelled)) {
    throw notFound();
  }
  const project = await openProject(req, wage.project);
  return { wage, project };
}

async function loadPayment(req, id) {
  const payment = await WorkerPayment.findById(id);
  if (!payment) throw notFound();
  const { user } = req;
  if (user.role === ROLES.CUSTOMER) throw notFound();
  if (user.role === ROLES.WORKER && (!payment.worker.equals(user._id) || payment.status !== P.CONFIRMED)) {
    throw notFound();
  }
  const project = await openProject(req, payment.project);
  if (user.role === ROLES.ENGINEER && !payment.recordedBy.equals(user._id)) {
    // Engineers may see any payment on their projects (they manage the workers)
  }
  return { payment, project };
}

// Money already paid (or waiting to be confirmed) against one wage record
async function wagePaidTotals(wageId) {
  const rows = await WorkerPayment.aggregate([
    { $match: { wage: wageId, status: { $in: [P.PENDING, P.CONFIRMED] } } },
    { $group: { _id: '$status', total: { $sum: '$amount' } } },
  ]);
  const get = (s) => round2(rows.find((r) => r._id === s)?.total ?? 0);
  return { confirmed: get(P.CONFIRMED), pending: get(P.PENDING) };
}

// Days the attendance records show (present = 1, half day = 0.5)
async function attendanceDays(projectId, workerId, startKey, endKey) {
  const rows = await Attendance.aggregate([
    {
      $match: {
        project: toId(projectId), user: toId(workerId),
        dateKey: { $gte: startKey, $lte: endKey },
        status: { $in: [A.PRESENT, A.HALF_DAY] },
      },
    },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const get = (s) => rows.find((r) => r._id === s)?.n ?? 0;
  return get(A.PRESENT) + get(A.HALF_DAY) * 0.5;
}

const daysInPeriod = (startKey, endKey) =>
  Math.round((new Date(endKey) - new Date(startKey)) / 86400000) + 1;

async function assertNoOverlap(project, worker, start, end, excludeId) {
  const clash = await WorkerWage.findOne({
    project, worker, isCancelled: false, status: { $ne: S.REJECTED },
    periodStart: { $lte: end }, periodEnd: { $gte: start },
    ...(excludeId && { _id: { $ne: excludeId } }),
  });
  if (clash) {
    throw new ApiError(409, `A wage record already covers part of this period (${keyOf(clash.periodStart)} to ${keyOf(clash.periodEnd)})`);
  }
}

async function assertWorkerOnProject(project, workerId) {
  const ok = await ProjectAssignment.exists({ project, user: workerId, role: ROLES.WORKER });
  if (!ok) {
    throw new ApiError(400, 'This worker has never been assigned to the project', [
      { field: 'workerId', message: 'Select a worker from this project' },
    ]);
  }
}

/*
  Earned vs paid for one worker.
    earned  = approved wages (cancelled ones excluded)
    paid    = CONFIRMED payments (including advances)
    balance = earned - paid. If negative, it is an advance not yet recovered.
  Pending (unconfirmed) payments are shown separately and never reduce the balance.
  Exported because the dashboard uses it too.
*/
export async function balanceFor(workerId, projectFilter = {}) {
  const worker = toId(workerId);
  const [wages, pays] = await Promise.all([
    WorkerWage.aggregate([
      { $match: { worker, status: S.APPROVED, isCancelled: false, ...projectFilter } },
      { $group: { _id: null, total: { $sum: '$netAmount' }, count: { $sum: 1 } } },
    ]),
    WorkerPayment.aggregate([
      { $match: { worker, ...projectFilter } },
      { $group: { _id: { status: '$status', adv: '$isAdvance' }, total: { $sum: '$amount' } } },
    ]),
  ]);
  const sum = (fn) => round2(pays.filter(fn).reduce((t, r) => t + r.total, 0));
  const earned = round2(wages[0]?.total ?? 0);
  const paid = sum((r) => r._id.status === P.CONFIRMED);
  const balance = round2(earned - paid);
  return {
    earned,
    wageRecords: wages[0]?.count ?? 0,
    paid,
    advancesPaid: sum((r) => r._id.status === P.CONFIRMED && r._id.adv),
    awaitingConfirmation: sum((r) => r._id.status === P.PENDING),
    pendingBalance: Math.max(0, balance),
    advanceNotRecovered: Math.max(0, -balance),
  };
}

// ============ WAGES (what was earned) ============

// POST /wages   (route uses projectAccess({ from: 'body', roles: ['super_admin','engineer'] }))
export const createWage = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { project, user } = req;
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
  const b = req.body;

  await assertWorkerOnProject(project._id, b.workerId);
  const maxDays = daysInPeriod(b.periodStart, b.periodEnd);
  if (b.daysWorked > maxDays) {
    throw new ApiError(400, `The period has only ${maxDays} day(s)`, [{ field: 'daysWorked', message: `Cannot be more than ${maxDays}` }]);
  }
  const start = dayStart(b.periodStart);
  const end = dayStart(b.periodEnd);
  await assertNoOverlap(project._id, b.workerId, start, end);

  const wage = await WorkerWage.create({
    project: project._id,
    worker: b.workerId,
    periodStart: start,
    periodEnd: end,
    daysWorked: b.daysWorked,
    dailyRate: b.dailyRate,
    grossAmount: round2(b.daysWorked * b.dailyRate),
    additions: b.additions,
    deductions: b.deductions,
    adjustmentNote: b.adjustmentNote,
    status: S.SUBMITTED,
    createdBy: user._id,
  });

  // Compare with attendance. This is a warning, not a block.
  const warnings = [];
  const attended = await attendanceDays(project._id, b.workerId, b.periodStart, b.periodEnd);
  if (b.daysWorked > attended + 0.0001) {
    warnings.push(`Attendance records show ${attended} day(s) but ${b.daysWorked} were entered. The admin will see this.`);
  }

  if (!isAdmin(user)) {
    await notifyAdmins({
      type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Wage record to approve',
      message: `${user.name} submitted a wage of ${inr(wage.netAmount)} for ${project.name}.`,
      project: project._id, entity: { kind: 'wage', id: wage._id },
    });
  }
  await logAudit(req, { action: 'wage.submit', entityType: 'WorkerWage', entityId: wage._id, project: project._id, after: wage });
  res.status(201).json({ success: true, data: shape(wage, user), ...(warnings.length && { warnings }) });
});

// PATCH /wages/:wageId   (the person who created it, while submitted or rejected)
export const updateWage = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { wage, project } = await loadWage(req, req.params.wageId);
  if (!wage.createdBy.equals(req.user._id)) throw new ApiError(403, 'Only the person who created this record can edit it');
  if (wage.isCancelled) throw new ApiError(409, 'This wage record is cancelled');
  if (![S.SUBMITTED, S.REJECTED].includes(wage.status)) throw new ApiError(409, 'An approved wage record cannot be edited. Ask the admin to cancel it.');

  const b = req.body;
  const startKey = b.periodStart ?? keyOf(wage.periodStart);
  const endKey = b.periodEnd ?? keyOf(wage.periodEnd);
  const days = b.daysWorked ?? wage.daysWorked;
  const rate = b.dailyRate ?? wage.dailyRate;

  if (endKey < startKey) throw new ApiError(400, 'Period end cannot be before period start');
  if (days > daysInPeriod(startKey, endKey)) throw new ApiError(400, 'Days worked is more than the days in the period');
  await assertNoOverlap(project._id, wage.worker, dayStart(startKey), dayStart(endKey), wage._id);

  const before = wage.toJSON();
  wage.periodStart = dayStart(startKey);
  wage.periodEnd = dayStart(endKey);
  wage.daysWorked = days;
  wage.dailyRate = rate;
  wage.grossAmount = round2(days * rate);
  if (b.additions !== undefined) wage.additions = b.additions;
  if (b.deductions !== undefined) wage.deductions = b.deductions;
  if (b.adjustmentNote !== undefined) wage.adjustmentNote = b.adjustmentNote;
  if ((wage.additions > 0 || wage.deductions > 0) && !wage.adjustmentNote) {
    throw new ApiError(400, 'Explain the addition or deduction', [{ field: 'adjustmentNote', message: 'Explain the addition or deduction' }]);
  }

  const wasRejected = wage.status === S.REJECTED;
  if (wasRejected) {
    wage.status = S.SUBMITTED;
    wage.reviewedBy = undefined;
    wage.reviewedAt = undefined;
    wage.reviewNote = undefined;
  }
  await wage.save();

  if (wasRejected) {
    await notifyAdmins({
      type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Wage record resubmitted',
      message: `${req.user.name} corrected a wage record for ${project.name}.`,
      project: project._id, entity: { kind: 'wage', id: wage._id },
    });
  }
  await logAudit(req, { action: wasRejected ? 'wage.resubmit' : 'wage.update', entityType: 'WorkerWage', entityId: wage._id, project: project._id, before, after: wage });
  res.json({ success: true, data: shape(wage, req.user) });
});

// POST /wages/:wageId/review   (admin)
export const reviewWage = asyncHandler(async (req, res) => {
  adminOnly(req);
  const { wage, project } = await loadWage(req, req.params.wageId);
  if (wage.isCancelled) throw new ApiError(409, 'This wage record is cancelled');
  if (wage.status !== S.SUBMITTED) throw new ApiError(409, 'Only submitted wage records can be reviewed');

  const { decision, reviewNote } = req.body;
  wage.status = decision === 'approved' ? S.APPROVED : S.REJECTED;
  wage.reviewedBy = req.user._id;
  wage.reviewedAt = new Date();
  wage.reviewNote = reviewNote;
  await wage.save();

  const recipients = [wage.createdBy];
  if (decision === 'approved') recipients.push(wage.worker);
  await notifyUsers(recipients, {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT,
    title: decision === 'approved' ? 'Wage approved' : 'Wage record rejected',
    message: `Wage of ${inr(wage.netAmount)} for ${project.name} (${keyOf(wage.periodStart)} to ${keyOf(wage.periodEnd)}) was ${decision}.`.slice(0, 500),
    project: project._id, entity: { kind: 'wage', id: wage._id },
  }, { exclude: req.user._id });
  await logAudit(req, { action: `wage.${decision === 'approved' ? 'approve' : 'reject'}`, entityType: 'WorkerWage', entityId: wage._id, project: project._id, note: reviewNote });
  res.json({ success: true, data: shape(wage, req.user) });
});

/*
  POST /wages/:wageId/cancel
  Admin: any. Engineer: own, only before approval.
  A wage with payments against it cannot be cancelled until those are cancelled.
*/
export const cancelWage = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { wage, project } = await loadWage(req, req.params.wageId);
  if (wage.isCancelled) throw new ApiError(409, 'Already cancelled');
  if (!isAdmin(req.user)) {
    if (!wage.createdBy.equals(req.user._id)) throw new ApiError(403, 'You can cancel only your own records');
    if (![S.SUBMITTED, S.REJECTED].includes(wage.status)) throw new ApiError(403, 'Only the admin can cancel an approved wage record');
  }
  const paid = await wagePaidTotals(wage._id);
  if (paid.confirmed + paid.pending > 0) throw new ApiError(409, 'Payments exist for this wage. Cancel those payments first.');

  wage.isCancelled = true;
  wage.cancelReason = req.body.reason;
  await wage.save();
  await logAudit(req, { action: 'wage.cancel', entityType: 'WorkerWage', entityId: wage._id, project: project._id, note: req.body.reason });
  res.json({ success: true, data: shape(wage, req.user) });
});

// GET /wages/:wageId
export const getWage = asyncHandler(async (req, res) => {
  const { wage } = await loadWage(req, req.params.wageId);
  const data = shape(wage, req.user);
  const paid = await wagePaidTotals(wage._id);
  data.paidConfirmed = paid.confirmed;
  data.balance = round2(wage.netAmount - paid.confirmed);
  if (req.user.role !== ROLES.WORKER) {
    data.attendanceDays = await attendanceDays(wage.project, wage.worker, keyOf(wage.periodStart), keyOf(wage.periodEnd));
    data.paidPending = paid.pending;
    await wage.populate([{ path: 'worker', select: 'name trade' }, { path: 'createdBy', select: 'name' }]);
    data.worker = wage.worker;
    data.createdBy = wage.createdBy;
  }
  res.json({ success: true, data });
});

// GET /wages
export const listWages = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const { user } = req;
  if (user.role === ROLES.CUSTOMER) throw new ApiError(403, 'You do not have permission to do this');
  const paging = getPagination(q);
  const filter = {};

  if (user.role === ROLES.WORKER) {
    Object.assign(filter, { worker: user._id, status: S.APPROVED, isCancelled: false });
    if (q.projectId) filter.project = q.projectId;
  } else {
    if (!isAdmin(user)) {
      const ids = await Project.find(await accessibleProjectFilter(user)).distinct('_id');
      if (q.projectId && !ids.some((id) => id.equals(q.projectId))) throw new ApiError(404, 'Project not found');
      filter.project = { $in: ids };
    }
    if (q.projectId) filter.project = q.projectId;
    if (q.workerId) filter.worker = q.workerId;
    if (q.status) filter.status = q.status;
  }
  if (q.disputed) filter['dispute.status'] = 'open';
  if (q.from) filter.periodEnd = { $gte: dayStart(q.from) };
  if (q.to) filter.periodStart = { $lte: dayEnd(q.to) };

  let query = WorkerWage.find(filter).sort({ periodEnd: -1, _id: -1 }).skip(paging.skip).limit(paging.limit);
  if (user.role !== ROLES.WORKER) query = query.populate('worker', 'name trade').populate('project', 'projectCode name');
  else query = query.populate('project', 'projectCode name');
  const [rows, total] = await Promise.all([query, WorkerWage.countDocuments(filter)]);
  res.json({ success: true, data: buildPage(rows.map((w) => shape(w, user)), total, paging) });
});

// ============ PAYMENTS (what was paid) ============

/*
  POST /worker-payments   (route uses projectAccess({ from: 'body', roles: ['super_admin','engineer'] }))
  Starts as PENDING. It counts as paid only when the admin confirms it.
*/
export const recordWorkerPayment = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { project, user } = req;
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
  const b = req.body;

  if (!b.wageId && !b.isAdvance) {
    throw new ApiError(400, 'Select the wage record being paid, or mark this as an advance', [
      { field: 'wageId', message: 'Select a wage record or choose advance' },
    ]);
  }
  await assertWorkerOnProject(project._id, b.workerId);

  if (b.wageId) {
    const wage = await WorkerWage.findOne({ _id: b.wageId, project: project._id, worker: b.workerId });
    if (!wage || wage.isCancelled || wage.status !== S.APPROVED) {
      throw new ApiError(400, 'Choose an approved wage record of this worker', [{ field: 'wageId', message: 'Wage record not available' }]);
    }
    const paid = await wagePaidTotals(wage._id);
    const remaining = round2(wage.netAmount - paid.confirmed - paid.pending);
    if (b.amount > remaining + EPS) {
      throw new ApiError(409, `This wage has only ${inr(remaining)} left to pay`, [{ field: 'amount', message: `Maximum ${inr(remaining)}` }]);
    }
  }

  if (b.reference) {
    const dup = await WorkerPayment.findOne({ project: project._id, reference: b.reference, status: { $in: [P.PENDING, P.CONFIRMED] } });
    if (dup) throw new ApiError(409, 'A payment with this reference was already entered');
  }

  const payment = await WorkerPayment.create({
    project: project._id,
    worker: b.workerId,
    wage: b.wageId,
    amount: b.amount,
    isAdvance: b.isAdvance,
    mode: b.mode,
    paymentDate: dayStart(b.paymentDate),
    reference: b.reference,
    notes: b.notes,
    status: P.PENDING,
    recordedBy: user._id,
  });

  await notifyAdmins({
    type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Worker payment to confirm',
    message: `${user.name} recorded ${inr(payment.amount)}${b.isAdvance ? ' (advance)' : ''} for ${project.name}.`,
    project: project._id, entity: { kind: 'worker_payment', id: payment._id },
  }, { exclude: user._id });
  await logAudit(req, { action: 'worker_payment.record', entityType: 'WorkerPayment', entityId: payment._id, project: project._id, after: payment });
  res.status(201).json({ success: true, data: shape(payment, user) });
});

// GET /worker-payments
export const listWorkerPayments = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const { user } = req;
  if (user.role === ROLES.CUSTOMER) throw new ApiError(403, 'You do not have permission to do this');
  const paging = getPagination(q);
  const filter = {};

  if (user.role === ROLES.WORKER) {
    Object.assign(filter, { worker: user._id, status: P.CONFIRMED }); // only money actually paid
    if (q.projectId) filter.project = q.projectId;
  } else {
    if (!isAdmin(user)) {
      const ids = await Project.find(await accessibleProjectFilter(user)).distinct('_id');
      if (q.projectId && !ids.some((id) => id.equals(q.projectId))) throw new ApiError(404, 'Project not found');
      filter.project = { $in: ids };
    }
    if (q.projectId) filter.project = q.projectId;
    if (q.workerId) filter.worker = q.workerId;
    if (q.status) filter.status = q.status;
  }
  if (q.isAdvance !== undefined) filter.isAdvance = q.isAdvance;
  if (q.disputed) filter['dispute.status'] = 'open';
  if (q.from || q.to) filter.paymentDate = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };

  let query = WorkerPayment.find(filter).sort({ paymentDate: -1, _id: -1 }).skip(paging.skip).limit(paging.limit);
  query = user.role === ROLES.WORKER
    ? query.populate('project', 'projectCode name')
    : query.populate('worker', 'name').populate('project', 'projectCode name');
  const [rows, total] = await Promise.all([query, WorkerPayment.countDocuments(filter)]);
  res.json({ success: true, data: buildPage(rows.map((p) => shape(p, user)), total, paging) });
});

// GET /worker-payments/:paymentId
export const getWorkerPayment = asyncHandler(async (req, res) => {
  const { payment } = await loadPayment(req, req.params.paymentId);
  res.json({ success: true, data: shape(payment, req.user) });
});

// POST /worker-payments/:paymentId/confirm   (admin)
export const confirmWorkerPayment = asyncHandler(async (req, res) => {
  adminOnly(req);
  const { payment, project } = await loadPayment(req, req.params.paymentId);
  if (payment.status !== P.PENDING) throw new ApiError(409, `This payment is already ${payment.status}`);

  if (payment.wage) {
    const wage = await WorkerWage.findById(payment.wage);
    if (!wage || wage.isCancelled || wage.status !== S.APPROVED) throw new ApiError(409, 'The wage record is no longer approved');
    const paid = await wagePaidTotals(wage._id);
    if (paid.confirmed + payment.amount > wage.netAmount + EPS) {
      throw new ApiError(409, `Confirming this would pay more than the wage amount (${inr(wage.netAmount)})`);
    }
  }

  payment.status = P.CONFIRMED;
  payment.confirmedBy = req.user._id;
  payment.confirmedAt = new Date();
  if (req.body.notes) payment.notes = [payment.notes, req.body.notes].filter(Boolean).join(' | ').slice(0, 300);
  await payment.save();

  await notifyUsers([payment.worker, payment.recordedBy], {
    type: NOTIFICATION_TYPE.PAYMENT_UPDATE, title: 'Payment recorded',
    message: `Payment of ${inr(payment.amount)}${payment.isAdvance ? ' (advance)' : ''} for ${project.name} is confirmed.`,
    project: project._id, entity: { kind: 'worker_payment', id: payment._id },
  }, { exclude: req.user._id });
  await logAudit(req, { action: 'worker_payment.confirm', entityType: 'WorkerPayment', entityId: payment._id, project: project._id, after: { amount: payment.amount, isAdvance: payment.isAdvance } });
  res.json({ success: true, data: shape(payment, req.user) });
});

// POST /worker-payments/:paymentId/reject   (admin)
export const rejectWorkerPayment = asyncHandler(async (req, res) => {
  adminOnly(req);
  const { payment, project } = await loadPayment(req, req.params.paymentId);
  if (payment.status !== P.PENDING) throw new ApiError(409, `Only pending payments can be rejected (this one is ${payment.status})`);

  payment.status = P.REJECTED;
  payment.rejectedBy = req.user._id;
  payment.rejectionReason = req.body.reason;
  await payment.save();

  await notifyUsers([payment.recordedBy], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT, title: 'Payment entry rejected',
    message: `The ${inr(payment.amount)} entry for ${project.name} was rejected: ${req.body.reason}`.slice(0, 500),
    project: project._id, entity: { kind: 'worker_payment', id: payment._id },
  }, { exclude: req.user._id });
  await logAudit(req, { action: 'worker_payment.reject', entityType: 'WorkerPayment', entityId: payment._id, project: project._id, note: req.body.reason });
  res.json({ success: true, data: shape(payment, req.user) });
});

// POST /worker-payments/:paymentId/cancel   (admin; the way to fix a confirmed payment)
export const cancelWorkerPayment = asyncHandler(async (req, res) => {
  adminOnly(req);
  const { payment, project } = await loadPayment(req, req.params.paymentId);
  if (![P.PENDING, P.CONFIRMED].includes(payment.status)) throw new ApiError(409, `This payment is already ${payment.status}`);

  const wasConfirmed = payment.status === P.CONFIRMED;
  payment.status = P.CANCELLED;
  payment.cancelReason = req.body.reason;
  await payment.save();

  if (wasConfirmed) {
    await notifyUsers([payment.worker], {
      type: NOTIFICATION_TYPE.PAYMENT_UPDATE, title: 'Payment entry cancelled',
      message: `A payment entry of ${inr(payment.amount)} for ${project.name} was cancelled. Please contact your engineer.`,
      project: project._id, entity: { kind: 'worker_payment', id: payment._id },
    });
  }
  await logAudit(req, { action: 'worker_payment.cancel', entityType: 'WorkerPayment', entityId: payment._id, project: project._id, note: `${wasConfirmed ? 'Was confirmed. ' : ''}${req.body.reason}` });
  res.json({ success: true, data: shape(payment, req.user) });
});

// POST /worker-payments/:paymentId/acknowledge   (the worker says "I received this")
export const acknowledgeWorkerPayment = asyncHandler(async (req, res) => {
  workerOnly(req);
  const { payment, project } = await loadPayment(req, req.params.paymentId);
  if (payment.workerAcknowledgedAt) throw new ApiError(409, 'You already confirmed receiving this payment');

  payment.workerAcknowledgedAt = new Date();
  await payment.save();
  await logAudit(req, { action: 'worker_payment.acknowledge', entityType: 'WorkerPayment', entityId: payment._id, project: project._id });
  res.json({ success: true, data: shape(payment, req.user) });
});

// ============ DISPUTES ============

async function raiseDispute(req, doc, project, kind, label) {
  if (doc.dispute?.status === 'open') throw new ApiError(409, 'A dispute is already open on this record');
  doc.dispute = { status: 'open', reason: req.body.reason, raisedAt: new Date() };
  await doc.save();

  const payload = {
    type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: `${label} dispute`,
    message: `${req.user.name} raised a dispute on a ${label.toLowerCase()} for ${project.name}.`,
    project: project._id, entity: { kind, id: doc._id },
  };
  await notifyProjectEngineers(project._id, payload);
  await notifyAdmins(payload);
  await logAudit(req, { action: `${kind}.dispute_raised`, entityType: doc.constructor.modelName, entityId: doc._id, project: project._id, note: req.body.reason });
}

// POST /wages/:wageId/dispute   (worker, own approved wage)
export const raiseWageDispute = asyncHandler(async (req, res) => {
  workerOnly(req);
  const { wage, project } = await loadWage(req, req.params.wageId);
  await raiseDispute(req, wage, project, 'wage', 'Wage');
  res.status(201).json({ success: true, data: shape(wage, req.user) });
});

// POST /worker-payments/:paymentId/dispute   (worker, own confirmed payment)
export const raisePaymentDispute = asyncHandler(async (req, res) => {
  workerOnly(req);
  const { payment, project } = await loadPayment(req, req.params.paymentId);
  await raiseDispute(req, payment, project, 'worker_payment', 'Payment');
  res.status(201).json({ success: true, data: shape(payment, req.user) });
});

/*
  POST /disputes/:kind/:id/resolve   (admin or the project's engineer)
  kind = 'wage' or 'payment'. Resolving records the outcome. If an amount was
  wrong, fix it by cancelling and entering a new record.
*/
export const resolveDispute = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { kind, id } = req.params;
  const { doc, project } =
    kind === 'wage'
      ? await loadWage(req, id).then(({ wage, project: p }) => ({ doc: wage, project: p }))
      : await loadPayment(req, id).then(({ payment, project: p }) => ({ doc: payment, project: p }));

  if (doc.dispute?.status !== 'open') throw new ApiError(409, 'There is no open dispute on this record');
  doc.dispute.status = req.body.status;
  doc.dispute.resolvedBy = req.user._id;
  doc.dispute.resolvedAt = new Date();
  doc.dispute.resolutionNote = req.body.resolutionNote;
  await doc.save();

  await notifyUsers([doc.worker], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT, title: 'Your dispute was answered',
    message: `Your ${kind} dispute for ${project.name} was ${req.body.status}. ${req.body.resolutionNote}`.slice(0, 500),
    project: project._id, entity: { kind: kind === 'wage' ? 'wage' : 'worker_payment', id: doc._id },
  }, { exclude: req.user._id });
  await logAudit(req, {
    action: `${kind}.dispute_resolved`, entityType: doc.constructor.modelName, entityId: doc._id,
    project: project._id, note: `${req.body.status}: ${req.body.resolutionNote}`,
  });
  res.json({ success: true, data: shape(doc, req.user) });
});

// ============ BALANCE ============

// GET /workers/:workerId/balance?projectId=...
export const getWorkerBalance = asyncHandler(async (req, res) => {
  const { user } = req;
  const { workerId } = req.params;
  const { projectId } = req.validated.query;
  if (user.role === ROLES.CUSTOMER) throw new ApiError(403, 'You do not have permission to do this');

  let projectFilter = projectId ? { project: toId(projectId) } : {};

  if (user.role === ROLES.WORKER) {
    if (!user._id.equals(workerId)) throw notFound();
  } else if (user.role === ROLES.ENGINEER) {
    const ids = await Project.find(await accessibleProjectFilter(user)).distinct('_id');
    if (projectId && !ids.some((id) => id.equals(projectId))) throw new ApiError(404, 'Project not found');
    const onProject = await ProjectAssignment.exists({ user: workerId, role: ROLES.WORKER, project: { $in: ids } });
    if (!onProject) throw notFound();
    if (!projectId) projectFilter = { project: { $in: ids } }; // only their own projects
  }

  const worker = await mongoose.model('User').findOne({ _id: workerId, role: ROLES.WORKER }).select('name trade dailyWageRate');
  if (!worker) throw notFound();

  res.json({ success: true, data: { worker, ...(await balanceFor(workerId, projectFilter)) } });
});