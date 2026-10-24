import DailyReport from '../models/DailyReport.js';
import Project from '../models/Project.js';
import Media from '../models/Media.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { resolveProjectAccess, accessibleProjectFilter } from '../middleware/projectAccess.js';
import { ROLES, APPROVAL_STATUS as S, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd } from '../utils/dates.js';

const notFound = () => new ApiError(404, 'Report not found');
const isAdmin = (user) => user.role === ROLES.SUPER_ADMIN;
const EDITABLE = ['workCompleted', 'workCategories', 'progressPercent', 'workersPresent', 'delays', 'issues', 'nextDayPlan', 'weather'];
const CUSTOMER_FIELDS = ['_id', 'project', 'reportDate', 'progressPercent', 'workCategories', 'weather', 'customerSummary', 'publishedAt'];

/*
  Customers get only the approved summary. workCompleted, delays, issues and
  nextDayPlan are internal and never leave the server for a customer.
*/
function shapeReport(report, role) {
  const obj = report.toJSON();
  if (role !== ROLES.CUSTOMER) return obj;
  return Object.fromEntries(CUSTOMER_FIELDS.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

async function loadReport(req, id) {
  const report = await DailyReport.findById(id);
  if (!report) throw notFound();
  const project = await Project.findById(report.project);
  const projectRole = project && (await resolveProjectAccess(req.user, project));
  if (!projectRole || (project.isArchived && !isAdmin(req.user))) throw notFound();

  const { role } = req.user;
  if (role === ROLES.WORKER) throw new ApiError(403, 'You do not have permission to do this');
  if (role === ROLES.CUSTOMER && report.status !== S.PUBLISHED) throw notFound();
  if (role === ROLES.ENGINEER && report.status === S.DRAFT && !report.author.equals(req.user._id)) throw notFound();
  return { report, project };
}

function assertAuthor(report, user) {
  if (!report.author.equals(user._id)) throw new ApiError(403, 'Only the engineer who wrote this report can change it');
}

// POST /reports   (engineer; route uses projectAccess({ from: 'body', roles: ['engineer'] }))
export const createReport = asyncHandler(async (req, res) => {
  const { projectId, reportDate, ...fields } = req.body;
  try {
    const report = await DailyReport.create({
      ...fields,
      project: req.project._id,
      author: req.user._id,
      reportDate: dayStart(reportDate),
      status: S.DRAFT,
    });
    res.status(201).json({ success: true, data: report });
  } catch (err) {
    if (err.code === 11000) {
      throw new ApiError(409, 'You already have a report for this project and date. Open it and edit it instead.');
    }
    throw err;
  }
});

// PATCH /reports/:reportId   (the author, while draft or rejected)
export const updateReport = asyncHandler(async (req, res) => {
  const { report } = await loadReport(req, req.params.reportId);
  assertAuthor(report, req.user);
  if (![S.DRAFT, S.REJECTED].includes(report.status)) {
    throw new ApiError(409, 'A submitted report cannot be edited');
  }
  for (const key of EDITABLE) if (req.body[key] !== undefined) report.set(key, req.body[key]);
  await report.save();
  res.json({ success: true, data: report });
});

// POST /reports/:reportId/submit   (the author)
export const submitReport = asyncHandler(async (req, res) => {
  const { report, project } = await loadReport(req, req.params.reportId);
  assertAuthor(report, req.user);
  if (![S.DRAFT, S.REJECTED].includes(report.status)) throw new ApiError(409, 'This report is already submitted');

  report.status = S.SUBMITTED;
  report.submittedAt = new Date();
  await report.save();

  await notifyAdmins({
    type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Daily report submitted',
    message: `${req.user.name} submitted a report for ${project.name}.`,
    project: project._id, entity: { kind: 'report', id: report._id },
  });
  await logAudit(req, { action: 'report.submit', entityType: 'DailyReport', entityId: report._id, project: project._id });
  res.json({ success: true, data: report });
});

// GET /reports/:reportId
export const getReport = asyncHandler(async (req, res) => {
  const { report } = await loadReport(req, req.params.reportId);
  const role = req.user.role;
  if (role !== ROLES.CUSTOMER) await report.populate([{ path: 'author', select: 'name' }, { path: 'reviewedBy', select: 'name' }]);

  const mediaCount = await Media.countDocuments({
    report: report._id, isDeleted: false, ...(role === ROLES.CUSTOMER && { isCustomerVisible: true }),
  });
  res.json({ success: true, data: { ...shapeReport(report, role), mediaCount } });
});

// GET /reports
export const listReports = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const { user } = req;
  const role = user.role;
  if (role === ROLES.WORKER) throw new ApiError(403, 'You do not have permission to do this');
  const paging = getPagination(q);
  const and = [];

  if (!isAdmin(user)) {
    const ids = await Project.find(await accessibleProjectFilter(user)).distinct('_id');
    if (q.projectId && !ids.some((id) => id.equals(q.projectId))) throw new ApiError(404, 'Project not found');
    and.push({ project: { $in: ids } });
  }
  if (q.projectId) and.push({ project: q.projectId });

  if (role === ROLES.CUSTOMER) {
    and.push({ status: S.PUBLISHED });
  } else {
    if (role === ROLES.ENGINEER) and.push({ $or: [{ author: user._id }, { status: { $ne: S.DRAFT } }] });
    if (q.status) and.push({ status: q.status });
    if (q.authorId) and.push({ author: q.authorId });
  }
  if (q.from) and.push({ reportDate: { $gte: dayStart(q.from) } });
  if (q.to) and.push({ reportDate: { $lte: dayEnd(q.to) } });

  const filter = and.length ? { $and: and } : {};
  const sort = q.sort === 'oldest' ? { reportDate: 1, _id: 1 } : { reportDate: -1, _id: -1 };

  let query = DailyReport.find(filter).sort(sort).skip(paging.skip).limit(paging.limit);
  if (role !== ROLES.CUSTOMER) query = query.populate('author', 'name').populate('project', 'projectCode name');
  const [rows, total] = await Promise.all([query, DailyReport.countDocuments(filter)]);

  res.json({ success: true, data: buildPage(rows.map((r) => shapeReport(r, role)), total, paging) });
});

// POST /reports/:reportId/review   (admin)
export const reviewReport = asyncHandler(async (req, res) => {
  const { report, project } = await loadReport(req, req.params.reportId);
  if (report.status !== S.SUBMITTED) throw new ApiError(409, 'Only submitted reports can be reviewed');
  const { decision, reviewNote, customerSummary } = req.body;

  report.status = decision === 'approved' ? S.APPROVED : S.REJECTED;
  report.reviewedBy = req.user._id;
  report.reviewedAt = new Date();
  report.reviewNote = reviewNote;
  if (customerSummary) report.customerSummary = customerSummary;
  await report.save();

  await notifyUsers([report.author], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT,
    title: `Report ${decision}`,
    message: `Your report for ${project.name} was ${decision}.${reviewNote ? ` ${reviewNote}` : ''}`.slice(0, 500),
    project: project._id, entity: { kind: 'report', id: report._id },
  });
  await logAudit(req, {
    action: `report.${decision === 'approved' ? 'approve' : 'reject'}`,
    entityType: 'DailyReport', entityId: report._id, project: project._id, note: reviewNote,
  });
  res.json({ success: true, data: report });
});

/*
  POST /reports/:reportId/publish   (admin)
  Makes the report visible to the customer, with the approved summary only.
  Photos are shown to the customer only if the admin has also marked them
  customer-visible (media update), so confidential photos are never exposed by accident.
*/
export const publishReport = asyncHandler(async (req, res) => {
  const { report, project } = await loadReport(req, req.params.reportId);
  if (![S.APPROVED, S.PUBLISHED].includes(report.status)) throw new ApiError(409, 'Approve the report before publishing it');
  if (project.isArchived) throw new ApiError(409, 'This project is archived');

  if (req.body.customerSummary) report.customerSummary = req.body.customerSummary;
  if (!report.customerSummary || report.customerSummary.length < 10) {
    throw new ApiError(400, 'Write a customer summary before publishing', [
      { field: 'customerSummary', message: 'The customer summary is required (at least 10 characters)' },
    ]);
  }

  const firstTime = report.status !== S.PUBLISHED;
  report.status = S.PUBLISHED;
  if (firstTime) report.publishedAt = new Date();
  await report.save();

  if (firstTime) {
    await notifyUsers([project.customer], {
      type: NOTIFICATION_TYPE.REPORT_PUBLISHED, title: 'New progress update',
      message: `A new progress update is available for ${project.name}.`,
      project: project._id, entity: { kind: 'report', id: report._id },
    });
  }
  await logAudit(req, {
    action: firstTime ? 'report.publish' : 'report.update_summary',
    entityType: 'DailyReport', entityId: report._id, project: project._id,
  });
  res.json({ success: true, data: report });
});

// POST /reports/:reportId/unpublish   (admin)
export const unpublishReport = asyncHandler(async (req, res) => {
  const { report, project } = await loadReport(req, req.params.reportId);
  if (report.status !== S.PUBLISHED) throw new ApiError(409, 'This report is not published');

  report.status = S.APPROVED;
  report.publishedAt = undefined;
  await report.save();

  await logAudit(req, {
    action: 'report.unpublish', entityType: 'DailyReport', entityId: report._id,
    project: project._id, note: req.body.reason,
  });
  res.json({ success: true, data: report });
});