import mongoose from 'mongoose';
import Milestone from '../models/Milestone.js';
import { recalculateProgress } from '../services/project.service.js';
import { logAudit } from '../services/audit.service.js';
import { ROLES, MILESTONE_STATUS } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const WEIGHT_LIMIT = 100.0001;
const round1 = (n) => Math.round(n * 10) / 10;

/*
  Customers do not see delayReason, because engineers write it as an internal
  note. (Later we can add an admin-approved customerDelayNote, the same way
  daily reports use customerSummary.)
*/
function shapeMilestone(milestone, role) {
  const obj = milestone.toJSON();
  if (role === ROLES.CUSTOMER) {
    delete obj.delayReason;
    delete obj.createdBy;
    delete obj.updatedBy;
    delete obj.completedBy;
  }
  return obj;
}

function assertNotArchived(project) {
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
}

async function findMilestoneOr404(projectId, milestoneId) {
  const milestone = await Milestone.findOne({ _id: milestoneId, project: projectId });
  if (!milestone) throw new ApiError(404, 'Milestone not found');
  return milestone;
}

const weightError = (left) =>
  new ApiError(400, 'Milestone weights cannot add up to more than 100%', [
    { field: 'weightPercent', message: `Only ${round1(Math.max(0, left))}% is left to assign` },
  ]);

// GET /projects/:projectId/milestones
export const listMilestones = asyncHandler(async (req, res) => {
  const role = req.user.role;
  const status = req.validated?.query?.status;
  const filter = { project: req.project._id };

  if (role === ROLES.CUSTOMER) filter.isCustomerVisible = true;
  if (status === 'overdue') {
    filter.status = { $ne: MILESTONE_STATUS.COMPLETED };
    filter.dueDate = { $lt: new Date() };
  } else if (status) {
    filter.status = status;
  }

  const milestones = await Milestone.find(filter).sort({ order: 1 });

  const data = {
    items: milestones.map((m) => shapeMilestone(m, role)),
    progressPercent: req.project.progressPercent,
  };

  if (role === ROLES.SUPER_ADMIN) {
    const [agg] = await Milestone.aggregate([
      { $match: { project: req.project._id } },
      { $group: { _id: null, total: { $sum: '$weightPercent' } } },
    ]);
    data.weightTotal = round1(agg?.total ?? 0);
  }

  res.json({ success: true, data });
});

// GET /projects/:projectId/milestones/:milestoneId
export const getMilestone = asyncHandler(async (req, res) => {
  const milestone = await findMilestoneOr404(req.project._id, req.params.milestoneId);
  if (req.user.role === ROLES.CUSTOMER && !milestone.isCustomerVisible) {
    throw new ApiError(404, 'Milestone not found');
  }
  res.json({ success: true, data: shapeMilestone(milestone, req.user.role) });
});

// POST /projects/:projectId/milestones   (admin only)
export const createMilestone = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);

  const existing = await Milestone.find({ project: project._id }).select('order weightPercent');
  const weightTotal = existing.reduce((sum, m) => sum + m.weightPercent, 0);
  const newWeight = req.body.weightPercent ?? 0;
  if (weightTotal + newWeight > WEIGHT_LIMIT) throw weightError(100 - weightTotal);

  const order = req.body.order ?? existing.reduce((max, m) => Math.max(max, m.order), 0) + 1;

  const milestone = await Milestone.create({
    ...req.body,
    order,
    project: project._id,
    createdBy: req.user._id,
  });
  await recalculateProgress(project._id);

  await logAudit(req, {
    action: 'milestone.create',
    entityType: 'Milestone',
    entityId: milestone._id,
    project: project._id,
    after: milestone,
  });

  res.status(201).json({ success: true, data: shapeMilestone(milestone, req.user.role) });
});

// POST /projects/:projectId/milestones/bulk   (admin only)
export const bulkCreateMilestones = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);
  const incoming = req.body.milestones;

  const existing = await Milestone.find({ project: project._id }).select('order weightPercent');
  const weightTotal =
    existing.reduce((sum, m) => sum + m.weightPercent, 0) +
    incoming.reduce((sum, m) => sum + (m.weightPercent ?? 0), 0);
  if (weightTotal > WEIGHT_LIMIT) {
    throw weightError(100 - existing.reduce((sum, m) => sum + m.weightPercent, 0));
  }

  // Orders already in use, plus any the admin chose explicitly
  const used = new Set(existing.map((m) => m.order));
  for (const m of incoming) {
    if (m.order === undefined) continue;
    if (used.has(m.order)) {
      throw new ApiError(400, 'Duplicate milestone order', [
        { field: 'order', message: `Order ${m.order} is already used` },
      ]);
    }
    used.add(m.order);
  }
  let next = existing.reduce((max, m) => Math.max(max, m.order), 0) + 1;
  const docs = incoming.map((m) => {
    let order = m.order;
    if (order === undefined) {
      while (used.has(next)) next += 1;
      order = next;
      used.add(order);
    }
    return { ...m, order, project: project._id, createdBy: req.user._id };
  });

  const created = await Milestone.insertMany(docs);
  await recalculateProgress(project._id);

  await logAudit(req, {
    action: 'milestone.bulk_create',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    after: created.map((m) => ({ id: m.id, title: m.title, order: m.order, weightPercent: m.weightPercent })),
  });

  res.status(201).json({
    success: true,
    data: created.sort((a, b) => a.order - b.order).map((m) => shapeMilestone(m, req.user.role)),
  });
});

// PATCH /projects/:projectId/milestones/:milestoneId   (admin only: edits the plan)
export const updateMilestone = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);
  const milestone = await findMilestoneOr404(project._id, req.params.milestoneId);
  const before = milestone.toJSON();

  if (req.body.weightPercent !== undefined) {
    const others = await Milestone.aggregate([
      { $match: { project: project._id, _id: { $ne: milestone._id } } },
      { $group: { _id: null, total: { $sum: '$weightPercent' } } },
    ]);
    const othersTotal = others[0]?.total ?? 0;
    if (othersTotal + req.body.weightPercent > WEIGHT_LIMIT) throw weightError(100 - othersTotal);
  }

  for (const [key, value] of Object.entries(req.body)) {
    if (value !== undefined) milestone.set(key, value);
  }
  const changed = milestone.modifiedPaths();
  if (changed.length === 0) {
    return res.json({ success: true, data: shapeMilestone(milestone, req.user.role) });
  }

  milestone.updatedBy = req.user._id;
  await milestone.save();
  if (changed.includes('weightPercent')) await recalculateProgress(project._id);

  await logAudit(req, {
    action: 'milestone.update',
    entityType: 'Milestone',
    entityId: milestone._id,
    project: project._id,
    before,
    after: milestone,
    note: `Changed: ${changed.join(', ')}`,
  });

  res.json({ success: true, data: shapeMilestone(milestone, req.user.role) });
});

/*
  PATCH /projects/:projectId/milestones/:milestoneId/progress   (admin or assigned engineer)
  Rules:
    completed    progress becomes 100
    pending      progress must be 0
    in_progress  progress must be below 100
    Only the admin can reopen a completed milestone.
*/
export const updateProgress = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);
  const isAdmin = req.user.role === ROLES.SUPER_ADMIN;
  const milestone = await findMilestoneOr404(project._id, req.params.milestoneId);
  const { status, progressPercent, delayReason } = req.body;

  const wasCompleted = milestone.status === MILESTONE_STATUS.COMPLETED;
  if (wasCompleted && status === MILESTONE_STATUS.COMPLETED) {
    throw new ApiError(409, 'This milestone is already completed');
  }
  if (wasCompleted && !isAdmin) {
    throw new ApiError(403, 'Only the admin can reopen a completed milestone');
  }

  const invalid = (message) =>
    new ApiError(400, message, [{ field: 'progressPercent', message }]);

  let progress;
  if (status === MILESTONE_STATUS.COMPLETED) {
    progress = 100;
  } else if (status === MILESTONE_STATUS.PENDING) {
    if (progressPercent > 0) throw invalid('A pending milestone must be 0%. Use in progress instead.');
    progress = 0;
  } else {
    progress = progressPercent ?? (wasCompleted ? undefined : milestone.progressPercent);
    if (progress === undefined) throw invalid('Enter the new progress for the reopened milestone');
    if (progress >= 100) throw invalid('Use the completed status for 100%');
  }

  const before = { status: milestone.status, progressPercent: milestone.progressPercent };

  milestone.status = status;
  milestone.progressPercent = progress;
  if (status === MILESTONE_STATUS.COMPLETED) {
    milestone.completedAt = new Date();
    milestone.completedBy = req.user._id;
  } else {
    milestone.completedAt = undefined;
    milestone.completedBy = undefined;
  }
  if (delayReason !== undefined) milestone.delayReason = delayReason;
  milestone.updatedBy = req.user._id;
  await milestone.save();

  const projectProgress = await recalculateProgress(project._id);

  await logAudit(req, {
    action: wasCompleted ? 'milestone.reopen' : 'milestone.progress',
    entityType: 'Milestone',
    entityId: milestone._id,
    project: project._id,
    before,
    after: { status: milestone.status, progressPercent: milestone.progressPercent },
    note: delayReason,
  });

  res.json({
    success: true,
    data: {
      milestone: shapeMilestone(milestone, req.user.role),
      projectProgress: projectProgress ?? req.project.progressPercent,
    },
  });
});

// DELETE /projects/:projectId/milestones/:milestoneId   (admin only)
// Only milestones that have not started can be deleted.
export const deleteMilestone = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);
  const milestone = await findMilestoneOr404(project._id, req.params.milestoneId);

  if (milestone.status !== MILESTONE_STATUS.PENDING || milestone.progressPercent > 0) {
    throw new ApiError(409, 'Only milestones that have not started can be deleted');
  }

  const before = milestone.toJSON();
  await milestone.deleteOne();
  await recalculateProgress(new mongoose.Types.ObjectId(String(project._id)));

  await logAudit(req, {
    action: 'milestone.delete',
    entityType: 'Milestone',
    entityId: milestone._id,
    project: project._id,
    before,
  });

  res.json({ success: true, message: 'Milestone deleted' });
});