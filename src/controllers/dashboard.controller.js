import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Milestone from '../models/Milestone.js';
import Attendance from '../models/Attendance.js';
import DailyReport from '../models/DailyReport.js';
import Media from '../models/Media.js';
import InventoryItem from '../models/InventoryItem.js';
import Expense from '../models/Expense.js';
import CustomerPayment from '../models/CustomerPayment.js';
import WorkerWage from '../models/WorkerWage.js';
import WorkerPayment from '../models/WorkerPayment.js';
import Notification from '../models/Notification.js';
import { balanceFor } from './wage.controller.js';
import { accessibleProjectFilter } from '../middleware/projectAccess.js';
import { ROLES, APPROVAL_STATUS as S, PAYMENT_STATUS as P } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd, keyOf, todayKeyIST } from '../utils/dates.js';

const round2 = (n) => Math.round(n * 100) / 100;
const sumOf = (rows) => round2(rows[0]?.total ?? 0);
const lowStockExpr = { $and: [{ $gt: ['$minStockThreshold', 0] }, { $lte: ['$currentBalance', '$minStockThreshold'] }] };
const unreadCount = (user) => Notification.countDocuments({ user: user._id, isRead: false });

const overdueFilter = (projectIds) => ({
  project: { $in: projectIds },
  status: { $ne: 'completed' },
  dueDate: { $lt: new Date() },
});

// How many things are waiting for the admin. Used by the dashboard and the Approvals screen.
async function approvalCounts(projectFilter = {}) {
  const open = { 'dispute.status': 'open', ...projectFilter };
  const [report, expense, customerPayment, wage, workerPayment, aDisp, wDisp, pDisp] = await Promise.all([
    DailyReport.countDocuments({ status: S.SUBMITTED, ...projectFilter }),
    Expense.countDocuments({ status: S.SUBMITTED, isCancelled: false, ...projectFilter }),
    CustomerPayment.countDocuments({ status: P.PENDING, ...projectFilter }),
    WorkerWage.countDocuments({ status: S.SUBMITTED, isCancelled: false, ...projectFilter }),
    WorkerPayment.countDocuments({ status: P.PENDING, ...projectFilter }),
    Attendance.countDocuments(open),
    WorkerWage.countDocuments(open),
    WorkerPayment.countDocuments(open),
  ]);
  const counts = { report, expense, customer_payment: customerPayment, worker_wage: wage, worker_payment: workerPayment };
  const disputes = aDisp + wDisp + pDisp;
  return { ...counts, disputes, total: Object.values(counts).reduce((a, b) => a + b, 0) + disputes };
}

// ---------- Super Admin ----------
async function adminDashboard() {
  const now = new Date();
  const weekAgoKey = keyOf(new Date(Date.now() - 7 * 24 * 3600 * 1000));

  const [byStatus, delayedByDate, projectIds] = await Promise.all([
    Project.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: '$status', count: { $sum: 1 }, contractValue: { $sum: '$contractValue' }, budget: { $sum: '$budget' } } },
    ]),
    Project.countDocuments({ isArchived: false, status: { $ne: 'completed' }, expectedEndDate: { $lt: now } }),
    Project.find({ isArchived: false }).distinct('_id'),
  ]);

  const inProjects = { project: { $in: projectIds } };
  const [received, expensesPaid, workerPaid, approvals, overdueCount, overdueList, lowStockCount, flaggedAttendance, delayedProjects, unread] =
    await Promise.all([
      CustomerPayment.aggregate([{ $match: { ...inProjects, status: P.CONFIRMED } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $match: { ...inProjects, isCancelled: false, status: S.APPROVED, 'payment.status': P.CONFIRMED } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      WorkerPayment.aggregate([{ $match: { ...inProjects, status: P.CONFIRMED } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      approvalCounts(),
      Milestone.countDocuments(overdueFilter(projectIds)),
      Milestone.find(overdueFilter(projectIds)).sort({ dueDate: 1 }).limit(5).select('title dueDate project').populate('project', 'name projectCode'),
      InventoryItem.countDocuments({ ...inProjects, isActive: true, $expr: lowStockExpr }),
      Attendance.countDocuments({ ...inProjects, 'exception.flagged': true, isConfirmed: false, dateKey: { $gte: weekAgoKey } }),
      Project.find({ isArchived: false, status: { $ne: 'completed' }, $or: [{ status: 'delayed' }, { expectedEndDate: { $lt: now } }] })
        .sort({ expectedEndDate: 1 }).limit(5).select('projectCode name status expectedEndDate progressPercent'),
      unreadCount({ _id: undefined }),
    ]);

  const get = (s) => byStatus.find((r) => r._id === s)?.count ?? 0;
  const totalContract = round2(byStatus.reduce((t, r) => t + r.contractValue, 0));
  const totalBudget = round2(byStatus.reduce((t, r) => t + r.budget, 0));
  const receivedTotal = sumOf(received);

  return {
    projects: {
      total: byStatus.reduce((t, r) => t + r.count, 0),
      planning: get('planning'), active: get('active'), onHold: get('on_hold'),
      delayed: get('delayed'), completed: get('completed'),
      pastDeadline: delayedByDate, // not completed and past the expected end date
    },
    money: {
      totalContractValue: totalContract,
      totalBudget,
      received: receivedTotal,
      outstanding: round2(totalContract - receivedTotal),
      expensesPaid: sumOf(expensesPaid),
      workerPaid: sumOf(workerPaid),
      spent: round2(sumOf(expensesPaid) + sumOf(workerPaid)),
    },
    approvals,
    alerts: { overdueMilestones: overdueCount, lowStockItems: lowStockCount, flaggedAttendanceLast7Days: flaggedAttendance },
    overdueMilestones: overdueList,
    delayedProjects,
    unreadNotifications: unread,
  };
}

// ---------- Engineer ----------
async function engineerDashboard(user) {
  const today = todayKeyIST();
  const projectFilter = await accessibleProjectFilter(user);
  const projects = await Project.find(projectFilter)
    .sort({ expectedEndDate: 1 }).limit(50)
    .select('projectCode name status progressPercent expectedEndDate address.city');
  const ids = projects.map((p) => p._id);

  const [attendanceToday, reportsToday, overdueCount, overdueList, dueSoon, lowStock, myReports, myExpenses, unread] = await Promise.all([
    Attendance.find({ user: user._id, dateKey: today, project: { $in: ids } }).select('project checkIn checkOut exception'),
    DailyReport.find({ author: user._id, reportDate: dayStart(today), project: { $in: ids } }).select('project status'),
    Milestone.countDocuments(overdueFilter(ids)),
    Milestone.find(overdueFilter(ids)).sort({ dueDate: 1 }).limit(5).select('title dueDate project').populate('project', 'name projectCode'),
    Milestone.countDocuments({
      project: { $in: ids }, status: { $ne: 'completed' },
      dueDate: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
    }),
    InventoryItem.find({ project: { $in: ids }, isActive: true, $expr: lowStockExpr })
      .limit(5).select('name unit currentBalance minStockThreshold project').populate('project', 'name'),
    DailyReport.aggregate([{ $match: { author: user._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Expense.aggregate([{ $match: { submittedBy: user._id, isCancelled: false } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    unreadCount(user),
  ]);

  const checkedIn = new Set(attendanceToday.map((a) => String(a.project)));
  const reported = new Set(reportsToday.map((r) => String(r.project)));
  const count = (rows, s) => rows.find((r) => r._id === s)?.n ?? 0;
  const brief = (p) => ({ id: p._id, name: p.name, projectCode: p.projectCode });

  return {
    projects,
    today: {
      date: today,
      needsCheckIn: projects.filter((p) => !checkedIn.has(String(p._id))).map(brief),
      needsReport: projects.filter((p) => !reported.has(String(p._id))).map(brief),
      attendance: attendanceToday,
    },
    myReports: { draft: count(myReports, S.DRAFT), submitted: count(myReports, S.SUBMITTED), rejected: count(myReports, S.REJECTED) },
    myExpenses: { awaitingApproval: count(myExpenses, S.SUBMITTED), rejected: count(myExpenses, S.REJECTED) },
    alerts: { overdueMilestones: overdueCount, milestonesDueIn7Days: dueSoon, lowStockItems: lowStock.length },
    overdueMilestones: overdueList,
    lowStock,
    unreadNotifications: unread,
  };
}

// ---------- Worker ----------
async function workerDashboard(user) {
  const today = todayKeyIST();
  const monthStart = `${today.slice(0, 8)}01`;

  const [assignments, attendanceToday, monthRows, balance, openDisputes, unread] = await Promise.all([
    ProjectAssignment.find({ user: user._id, role: ROLES.WORKER, isActive: true })
      .populate('project', 'projectCode name status address isArchived'),
    Attendance.find({ user: user._id, dateKey: today }).populate('project', 'name'),
    Attendance.aggregate([
      { $match: { user: user._id, dateKey: { $gte: monthStart, $lte: today } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    balanceFor(user._id),
    Attendance.countDocuments({ user: user._id, 'dispute.status': 'open' }),
    unreadCount(user),
  ]);

  const get = (s) => monthRows.find((r) => r._id === s)?.n ?? 0;
  return {
    projects: assignments.map((a) => a.project).filter((p) => p && !p.isArchived),
    today: { date: today, attendance: attendanceToday },
    thisMonth: { present: get('present'), halfDay: get('half_day'), absent: get('absent') },
    wages: balance,
    openDisputes,
    unreadNotifications: unread,
  };
}

// ---------- Customer ----------
async function customerDashboard(user) {
  const project = await Project.findOne({ customer: user._id, isArchived: false })
    .sort({ createdAt: -1 })
    .select('-budget -siteLocation -customer -createdBy -updatedBy');
  const unread = await unreadCount(user);
  if (!project) return { project: null, unreadNotifications: unread };

  const visible = { project: project._id, isCustomerVisible: true };
  const publishedIds = await DailyReport.find({ project: project._id, status: S.PUBLISHED }).distinct('_id');

  const [total, completed, upcoming, latestReport, mediaCount, paidRows, lastPayment] = await Promise.all([
    Milestone.countDocuments(visible),
    Milestone.countDocuments({ ...visible, status: 'completed' }),
    Milestone.find({ ...visible, status: { $ne: 'completed' } }).sort({ dueDate: 1 }).limit(3)
      .select('title dueDate status progressPercent order'),
    DailyReport.findOne({ project: project._id, status: S.PUBLISHED }).sort({ reportDate: -1 })
      .select('reportDate progressPercent workCategories weather customerSummary publishedAt'),
    Media.countDocuments({ ...visible, isDeleted: false, $or: [{ report: null }, { report: { $in: publishedIds } }] }),
    CustomerPayment.aggregate([{ $match: { project: project._id, status: P.CONFIRMED } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    CustomerPayment.findOne({ project: project._id, status: P.CONFIRMED }).sort({ paymentDate: -1 })
      .select('amount paymentDate receiptNumber type'),
  ]);

  const received = sumOf(paidRows);
  const now = Date.now();
  return {
    project,
    milestones: {
      total, completed,
      upcoming: upcoming.map((m) => ({ ...m.toJSON(), isOverdue: m.dueDate.getTime() < now })),
    },
    latestReport,
    gallery: { visibleItems: mediaCount },
    payments: {
      contractValue: project.contractValue,
      received,
      outstanding: round2(project.contractValue - received),
      lastPayment,
    },
    unreadNotifications: unread,
  };
}

// GET /dashboard   (any logged-in user; the content depends on the role)
export const getDashboard = asyncHandler(async (req, res) => {
  const { user } = req;
  let data;
  if (user.role === ROLES.SUPER_ADMIN) {
    data = await adminDashboard();
    data.unreadNotifications = await unreadCount(user);
  } else if (user.role === ROLES.ENGINEER) data = await engineerDashboard(user);
  else if (user.role === ROLES.WORKER) data = await workerDashboard(user);
  else data = await customerDashboard(user);
  res.json({ success: true, data: { role: user.role, ...data } });
});

// ---------- Admin: approvals queue ----------
const KINDS = {
  report: {
    model: DailyReport, filter: { status: S.SUBMITTED }, sort: { submittedAt: 1 },
    populate: [['author', 'name'], ['project', 'name projectCode']],
    map: (d) => ({ title: `Daily report for ${keyOf(d.reportDate)}`, by: d.author?.name, at: d.submittedAt }),
  },
  expense: {
    model: Expense, filter: { status: S.SUBMITTED, isCancelled: false }, sort: { createdAt: 1 },
    populate: [['submittedBy', 'name'], ['project', 'name projectCode']],
    map: (d) => ({ title: `${d.category}: ${d.description.slice(0, 60)}`, by: d.submittedBy?.name, at: d.createdAt, amount: d.amount }),
  },
  customer_payment: {
    model: CustomerPayment, filter: { status: P.PENDING }, sort: { createdAt: 1 },
    populate: [['recordedBy', 'name'], ['project', 'name projectCode']],
    map: (d) => ({ title: `Customer ${d.type} payment (${d.mode})`, by: d.recordedBy?.name, at: d.createdAt, amount: d.amount }),
  },
  worker_wage: {
    model: WorkerWage, filter: { status: S.SUBMITTED, isCancelled: false }, sort: { createdAt: 1 },
    populate: [['worker', 'name'], ['createdBy', 'name'], ['project', 'name projectCode']],
    map: (d) => ({ title: `Wage for ${d.worker?.name} (${keyOf(d.periodStart)} to ${keyOf(d.periodEnd)})`, by: d.createdBy?.name, at: d.createdAt, amount: d.netAmount }),
  },
  worker_payment: {
    model: WorkerPayment, filter: { status: P.PENDING }, sort: { createdAt: 1 },
    populate: [['worker', 'name'], ['recordedBy', 'name'], ['project', 'name projectCode']],
    map: (d) => ({ title: `${d.isAdvance ? 'Advance' : 'Payment'} to ${d.worker?.name}`, by: d.recordedBy?.name, at: d.createdAt, amount: d.amount }),
  },
};

async function fetchKind(kind, { projectId, skip = 0, limit }) {
  const cfg = KINDS[kind];
  const filter = { ...cfg.filter, ...(projectId && { project: projectId }) };
  let query = cfg.model.find(filter).sort(cfg.sort).skip(skip).limit(limit);
  for (const [path, select] of cfg.populate) query = query.populate(path, select);
  const rows = await query;
  return rows.map((d) => {
    const { title, by, at, amount = null } = cfg.map(d);
    return { kind, id: d._id, project: d.project, title, amount, submittedBy: by ?? null, submittedAt: at, status: d.status };
  });
}

// GET /dashboard/approvals?kind=expense&page=1   (admin)
// Oldest first, so the longest-waiting item is on top.
export const getPendingApprovals = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new ApiError(403, 'Only the admin can do this');
  const q = req.validated.query;
  const projectFilter = q.projectId ? { project: q.projectId } : {};
  const counts = await approvalCounts(projectFilter);

  if (q.kind) {
    const paging = getPagination(q);
    const items = await fetchKind(q.kind, { projectId: q.projectId, skip: paging.skip, limit: paging.limit });
    return res.json({ success: true, data: { counts, ...buildPage(items, counts[q.kind], paging) } });
  }

  // No kind chosen: the 5 oldest of each type, without paging
  const groups = await Promise.all(Object.keys(KINDS).map((kind) => fetchKind(kind, { projectId: q.projectId, limit: 5 })));
  const items = groups.flat().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  res.json({ success: true, data: { counts, items, pagination: null } });
});

// ---------- Admin: company finance ----------
// GET /dashboard/finance?from=&to=   (admin)
// "period" follows from/to. "projects" is always lifetime, so outstanding balances stay correct.
export const getCompanyFinance = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new ApiError(403, 'Only the admin can do this');
  const { from, to } = req.validated.query;
  const range = (field) =>
    from || to ? { [field]: { ...(from && { $gte: dayStart(from) }), ...(to && { $lte: dayEnd(to) }) } } : {};

  const confirmedExpense = { isCancelled: false, status: S.APPROVED, 'payment.status': P.CONFIRMED };
  const unpaidExpense = { isCancelled: false, status: S.APPROVED, 'payment.status': { $ne: P.CONFIRMED } };
  const byProject = (match) => [{ $match: match }, { $group: { _id: '$project', total: { $sum: '$amount' } } }];

  const [projects, pReceived, pPaid, pUnpaid, pWorker, periodReceived, periodExpense, periodWorker] = await Promise.all([
    Project.find({ isArchived: false }).sort({ name: 1 }).limit(500)
      .select('projectCode name status contractValue budget'),
    CustomerPayment.aggregate(byProject({ status: P.CONFIRMED })),
    Expense.aggregate(byProject(confirmedExpense)),
    Expense.aggregate(byProject(unpaidExpense)),
    WorkerPayment.aggregate(byProject({ status: P.CONFIRMED })),
    CustomerPayment.aggregate([{ $match: { status: P.CONFIRMED, ...range('paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { ...confirmedExpense, ...range('payment.paidAt') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    WorkerPayment.aggregate([{ $match: { status: P.CONFIRMED, ...range('paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);

  const map = (rows) => new Map(rows.map((r) => [String(r._id), r.total]));
  const [recv, paid, unpaid, worker] = [map(pReceived), map(pPaid), map(pUnpaid), map(pWorker)];

  const rows = projects.map((p) => {
    const id = String(p._id);
    const received = round2(recv.get(id) ?? 0);
    const expensesPaid = round2(paid.get(id) ?? 0);
    const workerPaid = round2(worker.get(id) ?? 0);
    const spent = round2(expensesPaid + workerPaid);
    return {
      id: p._id, projectCode: p.projectCode, name: p.name, status: p.status,
      contractValue: p.contractValue, budget: p.budget,
      received, outstanding: round2(p.contractValue - received),
      expensesPaid, workerPaid, spent,
      expensesApprovedUnpaid: round2(unpaid.get(id) ?? 0),
      budgetRemaining: round2(p.budget - spent),
      isOverBudget: spent > p.budget,
    };
  });

  const total = (key) => round2(rows.reduce((t, r) => t + r[key], 0));
  res.json({
    success: true,
    data: {
      period: {
        from: from ?? null, to: to ?? null,
        received: sumOf(periodReceived),
        expensesPaid: sumOf(periodExpense),
        workerPaid: sumOf(periodWorker),
        net: round2(sumOf(periodReceived) - sumOf(periodExpense) - sumOf(periodWorker)),
      },
      totals: {
        contractValue: total('contractValue'), budget: total('budget'), received: total('received'),
        outstanding: total('outstanding'), spent: total('spent'),
        expensesApprovedUnpaid: total('expensesApprovedUnpaid'),
      },
      projects: rows.sort((a, b) => b.outstanding - a.outstanding),
    },
  });
});