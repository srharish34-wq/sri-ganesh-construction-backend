import Project from '../models/Project.js';
import CustomerPayment from '../models/CustomerPayment.js';
import Expense from '../models/Expense.js';
import Attendance from '../models/Attendance.js';
import InventoryItem from '../models/InventoryItem.js';
import InventoryTransaction from '../models/InventoryTransaction.js';
import WorkerWage from '../models/WorkerWage.js';
import WorkerPayment from '../models/WorkerPayment.js';
import { logAudit } from '../services/audit.service.js';
import { ROLES, PAYMENT_STATUS as P } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { dayStart, dayEnd, keyOf, todayKeyIST } from '../utils/dates.js';

const MAX_ROWS = 10000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const OID = /^[a-f\d]{24}$/i;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const fmtDate = (d) => (d ? keyOf(new Date(d)) : '');
const fmtDateTime = (d) =>
  d ? new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) : '';
const yesNo = (b) => (b ? 'Yes' : 'No');
const num = (n) => (n == null ? '' : Math.round(n * 100) / 100);

// One CSV cell. Text starting with = + - @ is prefixed with ' so Excel cannot run it as a formula.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDateTime(v);
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('\uFEFF' + lines.join('\r\n')); // BOM so Excel reads rupee signs and Tamil text correctly
}

async function fetchRows(query) {
  const rows = await query.limit(MAX_ROWS + 1).lean();
  if (rows.length > MAX_ROWS) {
    throw new ApiError(413, `Too many rows (more than ${MAX_ROWS}). Choose a shorter date range.`);
  }
  return rows;
}

const between = (field, q) =>
  q.from || q.to ? { [field]: { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) } } : {};

/*
  Each builder returns { headers, rows } for one report type.
  b = { project, q }  (project is null for the 'projects' report)
*/
const BUILDERS = {
  async projects() {
    const [projects, received] = await Promise.all([
      fetchRows(Project.find({ isArchived: false }).sort({ projectCode: 1 }).populate('customer', 'name')),
      CustomerPayment.aggregate([
        { $match: { status: P.CONFIRMED } },
        { $group: { _id: '$project', total: { $sum: '$amount' } } },
      ]),
    ]);
    const got = new Map(received.map((r) => [String(r._id), r.total]));
    return {
      headers: ['Project code', 'Name', 'Customer', 'City', 'Status', 'Progress %', 'Start date', 'Expected end', 'Budget', 'Contract value', 'Received', 'Outstanding'],
      rows: projects.map((p) => {
        const rec = got.get(String(p._id)) ?? 0;
        return [p.projectCode, p.name, p.customer?.name, p.address?.city, p.status, p.progressPercent,
          fmtDate(p.startDate), fmtDate(p.expectedEndDate), num(p.budget), num(p.contractValue), num(rec), num(p.contractValue - rec)];
      }),
    };
  },

  async 'customer-payments'({ project, q }) {
    const rows = await fetchRows(
      CustomerPayment.find({ project: project._id, ...between('paymentDate', q) })
        .sort({ paymentDate: 1, _id: 1 }).populate('recordedBy', 'name').populate('confirmedBy', 'name')
    );
    return {
      headers: ['Receipt no', 'Date', 'Type', 'Mode', 'Reference', 'Amount', 'Status', 'Recorded by', 'Confirmed by', 'Confirmed at', 'Notes'],
      rows: rows.map((r) => [r.receiptNumber, fmtDate(r.paymentDate), r.type, r.mode, r.reference, num(r.amount),
        r.status, r.recordedBy?.name, r.confirmedBy?.name, r.confirmedAt, r.notes]),
    };
  },

  async expenses({ project, q }) {
    const rows = await fetchRows(
      Expense.find({ project: project._id, ...between('expenseDate', q) })
        .sort({ expenseDate: 1, _id: 1 }).populate('submittedBy', 'name')
    );
    return {
      headers: ['Date', 'Category', 'Description', 'Vendor', 'Bill no', 'Amount', 'Approval', 'Payment', 'Paid on', 'Mode', 'Reference', 'Submitted by', 'Cancelled'],
      rows: rows.map((r) => [fmtDate(r.expenseDate), r.category, r.description, r.vendorName, r.billNumber, num(r.amount),
        r.status, r.payment?.status, fmtDate(r.payment?.paidAt), r.payment?.mode, r.payment?.reference,
        r.submittedBy?.name, yesNo(r.isCancelled)]),
    };
  },

  async attendance({ project, q }) {
    const dateKey = q.from || q.to ? { dateKey: { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) } } : {};
    const rows = await fetchRows(
      Attendance.find({ project: project._id, ...dateKey }).sort({ dateKey: 1, _id: 1 }).populate('user', 'name role')
    );
    const withinText = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Not checked');
    return {
      headers: ['Date', 'Name', 'Role', 'Status', 'Check-in', 'Check-out', 'Hours', 'Source', 'Within site radius (in)', 'Distance in (m)', 'Flagged', 'Exception reason', 'Confirmed'],
      rows: rows.map((r) => {
        const hours = r.checkIn?.time && r.checkOut?.time ? (new Date(r.checkOut.time) - new Date(r.checkIn.time)) / 36e5 : null;
        return [r.dateKey, r.user?.name, r.user?.role, r.status, r.checkIn?.time, r.checkOut?.time, num(hours), r.source,
          withinText(r.checkIn?.withinRadius), r.checkIn?.distanceFromSiteMeters, yesNo(r.exception?.flagged), r.exception?.reason, yesNo(r.isConfirmed)];
      }),
    };
  },

  async inventory({ project }) {
    const rows = await fetchRows(InventoryItem.find({ project: project._id, isActive: true }).sort({ name: 1 }));
    return {
      headers: ['Material', 'Category', 'Unit', 'Current balance', 'Minimum stock', 'Low stock', 'Supplier', 'Supplier phone'],
      rows: rows.map((r) => [r.name, r.category, r.unit, r.currentBalance, r.minStockThreshold,
        yesNo(r.minStockThreshold > 0 && r.currentBalance <= r.minStockThreshold), r.supplier?.name, r.supplier?.phone]),
    };
  },

  async 'inventory-transactions'({ project, q }) {
    const rows = await fetchRows(
      InventoryTransaction.find({ project: project._id, ...between('transactionDate', q) })
        .sort({ transactionDate: 1, _id: 1 }).populate('item', 'name unit').populate('recordedBy', 'name')
    );
    return {
      headers: ['Date', 'Material', 'Type', 'Quantity (+/-)', 'Unit', 'Balance after', 'Reference', 'Supplier', 'Unit cost', 'Status', 'Recorded by', 'Void reason'],
      rows: rows.map((r) => [fmtDate(r.transactionDate), r.item?.name, r.type, r.signedQuantity, r.item?.unit, r.balanceAfter,
        r.reference, r.supplierName, num(r.unitCost), r.status, r.recordedBy?.name, r.voidReason]),
    };
  },

  async 'worker-wages'({ project, q }) {
    const overlap = {
      ...(q.from && { periodEnd: { $gte: dayStart(q.from) } }),
      ...(q.to && { periodStart: { $lte: dayEnd(q.to) } }),
    };
    const rows = await fetchRows(
      WorkerWage.find({ project: project._id, ...overlap }).sort({ periodStart: 1, _id: 1 }).populate('worker', 'name trade')
    );
    return {
      headers: ['Period start', 'Period end', 'Worker', 'Trade', 'Days worked', 'Daily rate', 'Gross', 'Additions', 'Deductions', 'Net', 'Status', 'Cancelled', 'Note'],
      rows: rows.map((r) => [fmtDate(r.periodStart), fmtDate(r.periodEnd), r.worker?.name, r.worker?.trade, r.daysWorked,
        num(r.dailyRate), num(r.grossAmount), num(r.additions), num(r.deductions), num(r.netAmount), r.status, yesNo(r.isCancelled), r.adjustmentNote]),
    };
  },

  async 'worker-payments'({ project, q }) {
    const rows = await fetchRows(
      WorkerPayment.find({ project: project._id, ...between('paymentDate', q) })
        .sort({ paymentDate: 1, _id: 1 }).populate('worker', 'name').populate('recordedBy', 'name')
    );
    return {
      headers: ['Date', 'Worker', 'Amount', 'Advance', 'Mode', 'Reference', 'Status', 'Worker acknowledged', 'Recorded by', 'Notes'],
      rows: rows.map((r) => [fmtDate(r.paymentDate), r.worker?.name, num(r.amount), yesNo(r.isAdvance), r.mode, r.reference,
        r.status, r.workerAcknowledgedAt ? fmtDateTime(r.workerAcknowledgedAt) : 'No', r.recordedBy?.name, r.notes]),
    };
  },
};

const NEEDS_PROJECT = (type) => type !== 'projects';

/*
  GET /exports/:type?projectId=...&from=YYYY-MM-DD&to=YYYY-MM-DD   (admin only)
  Types: projects, customer-payments, expenses, attendance, inventory,
         inventory-transactions, worker-wages, worker-payments
  The app downloads this with its normal Authorization header.
*/
export const exportCsv = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new ApiError(403, 'Only the admin can export reports');

  const { type } = req.params;
  const build = BUILDERS[type];
  if (!build) throw new ApiError(404, `Unknown report. Choose one of: ${Object.keys(BUILDERS).join(', ')}`);

  const { projectId, from, to } = req.query;
  const problems = [];
  if (from && !DATE_KEY.test(from)) problems.push({ field: 'from', message: 'Use YYYY-MM-DD' });
  if (to && !DATE_KEY.test(to)) problems.push({ field: 'to', message: 'Use YYYY-MM-DD' });
  if (from && to && to < from) problems.push({ field: 'to', message: 'End date is before the start date' });
  if (NEEDS_PROJECT(type) && !(typeof projectId === 'string' && OID.test(projectId))) {
    problems.push({ field: 'projectId', message: 'Choose a project' });
  }
  if (problems.length) throw new ApiError(400, 'Validation failed', problems);

  const project = NEEDS_PROJECT(type) ? await Project.findById(projectId).select('projectCode name') : null;
  if (NEEDS_PROJECT(type) && !project) throw new ApiError(404, 'Project not found');

  const { headers, rows } = await build({ project, q: { from, to } });

  await logAudit(req, {
    action: `export.${type}`, entityType: 'Export', project: project?._id,
    note: `${rows.length} rows${from || to ? `, ${from ?? '...'} to ${to ?? '...'}` : ''}`,
  });

  const name = `${project?.projectCode ?? 'SGC'}_${type}_${todayKeyIST()}.csv`;
  sendCsv(res, name, headers, rows);
});