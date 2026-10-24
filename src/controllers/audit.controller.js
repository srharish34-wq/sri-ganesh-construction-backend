import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import { ROLES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage, escapeRegex } from '../utils/pagination.js';
import { dayStart, dayEnd } from '../utils/dates.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function adminOnly(req) {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new ApiError(403, 'Only the admin can view the audit log');
}

function idQuery(value, field, problems) {
  if (value === undefined) return undefined;
  if (!mongoose.isValidObjectId(value)) {
    problems.push({ field, message: 'Invalid ID' });
    return undefined;
  }
  return value;
}

/*
  GET /audit-logs   (admin only)
  Filters: projectId, entityType, entityId, actorId, action, from, to, page, limit
    action matches the start of the name, e.g. "customer_payment" finds every
    payment action and "project.status" finds status changes.
  To see the full history of one record, send entityType + entityId.
  The list leaves out the before/after details to stay small; open one entry to see them.
*/
export const listAuditLogs = asyncHandler(async (req, res) => {
  adminOnly(req);
  const q = req.query;
  const paging = getPagination(q);
  const problems = [];
  const filter = {};

  const project = idQuery(q.projectId, 'projectId', problems);
  const entityId = idQuery(q.entityId, 'entityId', problems);
  const actor = idQuery(q.actorId, 'actorId', problems);
  if (project) filter.project = project;
  if (entityId) filter.entityId = entityId;
  if (actor) filter.actor = actor;

  if (q.entityType) filter.entityType = String(q.entityType).slice(0, 60);
  if (q.action) filter.action = new RegExp(`^${escapeRegex(String(q.action).slice(0, 80))}`, 'i');

  for (const key of ['from', 'to']) {
    if (q[key] && !DATE_KEY.test(q[key])) problems.push({ field: key, message: 'Use YYYY-MM-DD' });
  }
  if (problems.length) throw new ApiError(400, 'Validation failed', problems);
  if (q.from || q.to) {
    filter.createdAt = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .select('-before -after')
      .populate('project', 'projectCode name'),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: buildPage(items, total, paging) });
});

// GET /audit-logs/:id   (admin only; includes the before and after values)
export const getAuditLog = asyncHandler(async (req, res) => {
  adminOnly(req);
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Entry not found');
  const entry = await AuditLog.findById(req.params.id).populate('project', 'projectCode name');
  if (!entry) throw new ApiError(404, 'Entry not found');
  res.json({ success: true, data: entry });
});

// GET /audit-logs/actions   (admin only; fills the "filter by action" dropdown)
export const listActions = asyncHandler(async (req, res) => {
  adminOnly(req);
  const actions = await AuditLog.distinct('action');
  res.json({ success: true, data: actions.sort() });
});