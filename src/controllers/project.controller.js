import Project from '../models/Project.js';
import User from '../models/User.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Milestone from '../models/Milestone.js';
import * as projectService from '../services/project.service.js';
import { logAudit } from '../services/audit.service.js';
import { accessibleProjectFilter } from '../middleware/projectAccess.js';
import { env } from '../config/env.js';
import { ROLES, PROJECT_STATUS } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage, escapeRegex } from '../utils/pagination.js';

const round2 = (n) => Math.round(n * 100) / 100;

async function requireActiveCustomer(customerId) {
  const customer = await User.findOne({ _id: customerId, role: ROLES.CUSTOMER, isActive: true });
  if (!customer) {
    throw new ApiError(400, 'Customer account not found or inactive', [
      { field: 'customerId', message: 'Select a valid customer' },
    ]);
  }
  return customer;
}

function assertNotArchived(project) {
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
}

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  deadline: { expectedEndDate: 1, _id: 1 },
  name: { name: 1, _id: 1 },
  progress: { progressPercent: -1, _id: 1 },
  contractValue: { contractValue: -1, _id: 1 },
};

// POST /projects   (admin only)
export const createProject = asyncHandler(async (req, res) => {
  const { customerId, ...rest } = req.body;
  const customer = await requireActiveCustomer(customerId);

  const project = await projectService.createProject({
    ...rest,
    budget: round2(rest.budget),
    contractValue: round2(rest.contractValue),
    customer: customer._id,
    createdBy: req.user._id,
  });

  await logAudit(req, {
    action: 'project.create',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    after: project,
  });

  res.status(201).json({ success: true, data: projectService.shapeProject(project, req.user.role) });
});

/*
  GET /projects
  The database filters by what this user may see, then by the search and
  filters, then pages the result. Nothing is loaded and hidden afterwards.
*/
export const listProjects = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const { user } = req;
  const role = user.role;
  const isAdmin = role === ROLES.SUPER_ADMIN;
  const canSeeCustomer = isAdmin || role === ROLES.ENGINEER;
  const paging = getPagination(q);

  const and = [await accessibleProjectFilter(user)];
  if (isAdmin) and.push({ isArchived: q.archived === true });
  if (q.status) and.push({ status: q.status });

  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    const or = [{ name: rx }, { projectCode: rx }, { 'address.line1': rx }, { 'address.city': rx }];
    if (isAdmin) {
      const customerIds = await User.find({ role: ROLES.CUSTOMER, name: rx }).distinct('_id');
      if (customerIds.length) or.push({ customer: { $in: customerIds } });
    }
    and.push({ $or: or });
  }

  if (q.from || q.to) {
    const range = {};
    if (q.from) range.$gte = q.from;
    if (q.to) range.$lte = q.to;
    and.push({ startDate: range });
  }

  if (isAdmin) {
    if (q.customerId) and.push({ customer: q.customerId });
    if (q.engineerId) {
      const ids = await ProjectAssignment.find({
        user: q.engineerId,
        role: ROLES.ENGINEER,
        isActive: true,
      }).distinct('project');
      and.push({ _id: { $in: ids } });
    }
  }

  // Sorting by contract value would reveal hidden amounts to non-admins
  const sortKey = q.sort === 'contractValue' && !isAdmin ? 'newest' : q.sort;
  const filter = { $and: and };

  let query = Project.find(filter).sort(SORTS[sortKey]).skip(paging.skip).limit(paging.limit);
  if (canSeeCustomer) query = query.populate('customer', 'name phone');

  const [projects, total] = await Promise.all([query, Project.countDocuments(filter)]);

  // One query for the engineers of all projects on this page
  const engineersByProject = {};
  if (isAdmin && projects.length) {
    const rows = await ProjectAssignment.find({
      project: { $in: projects.map((p) => p._id) },
      role: ROLES.ENGINEER,
      isActive: true,
    }).populate('user', 'name phone');
    for (const row of rows) {
      const key = row.project.toString();
      (engineersByProject[key] ||= []).push({ id: row.user?._id, name: row.user?.name });
    }
  }

  const items = projects.map((p) => ({
    ...projectService.shapeProject(p, role),
    ...(isAdmin && { engineers: engineersByProject[p._id.toString()] || [] }),
  }));

  res.json({ success: true, data: buildPage(items, total, paging) });
});

// GET /projects/:projectId   (route uses projectAccess(), which sets req.project)
export const getProject = asyncHandler(async (req, res) => {
  const { project } = req;
  const role = req.user.role;
  const isAdmin = role === ROLES.SUPER_ADMIN;
  const isEngineer = role === ROLES.ENGINEER;

  if (isAdmin || isEngineer) {
    await project.populate('customer', isAdmin ? 'name email phone' : 'name phone');
  }

  const data = projectService.shapeProject(project, role);

  if (isAdmin || isEngineer) {
    const [engineers, workerCount] = await Promise.all([
      ProjectAssignment.find({ project: project._id, role: ROLES.ENGINEER, isActive: true }).populate(
        'user',
        'name phone'
      ),
      ProjectAssignment.countDocuments({ project: project._id, role: ROLES.WORKER, isActive: true }),
    ]);
    data.team = {
      engineers: engineers.map((a) => ({ id: a.user?._id, name: a.user?.name, phone: a.user?.phone })),
      workerCount,
    };
  }

  const milestoneFilter = { project: project._id };
  if (role === ROLES.CUSTOMER) milestoneFilter.isCustomerVisible = true;
  const [total, completed, overdue] = await Promise.all([
    Milestone.countDocuments(milestoneFilter),
    Milestone.countDocuments({ ...milestoneFilter, status: 'completed' }),
    Milestone.countDocuments({
      ...milestoneFilter,
      status: { $ne: 'completed' },
      dueDate: { $lt: new Date() },
    }),
  ]);
  data.milestoneSummary = { total, completed, overdue };

  res.json({ success: true, data });
});

// PATCH /projects/:projectId   (admin only)
export const updateProject = asyncHandler(async (req, res) => {
  const { project } = req;
  assertNotArchived(project);

  if (req.body.status !== undefined) {
    throw new ApiError(400, 'Use the status endpoint to change the project status');
  }

  const { customerId, ...fields } = req.body;
  const before = project.toJSON();

  if (customerId && !project.customer.equals(customerId)) {
    project.customer = (await requireActiveCustomer(customerId))._id;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'budget' || key === 'contractValue') project.set(key, round2(value));
    else if (key === 'siteLocation') {
      project.set('siteLocation', {
        radiusMeters: project.siteLocation?.radiusMeters ?? env.DEFAULT_SITE_RADIUS_METERS,
        ...value,
      });
    } else project.set(key, value);
  }

  const changed = project.modifiedPaths();
  if (changed.length === 0) {
    return res.json({ success: true, data: projectService.shapeProject(project, req.user.role) });
  }

  project.updatedBy = req.user._id;
  await project.save();

  await logAudit(req, {
    action: 'project.update',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    before,
    after: project,
    note: `Changed: ${changed.join(', ')}`,
  });

  res.json({ success: true, data: projectService.shapeProject(project, req.user.role) });
});

// PATCH /projects/:projectId/status   (admin only)
export const changeStatus = asyncHandler(async (req, res) => {
  const { project } = req;
  const { status, reason } = req.body;
  assertNotArchived(project);

  if (project.status === status) {
    throw new ApiError(400, `Project is already ${status.replace('_', ' ')}`);
  }

  const before = { status: project.status, actualEndDate: project.actualEndDate };
  const warnings = [];

  project.status = status;
  if (status === PROJECT_STATUS.COMPLETED) {
    project.actualEndDate = new Date();
    const open = await Milestone.countDocuments({ project: project._id, status: { $ne: 'completed' } });
    if (open > 0) warnings.push(`${open} milestone(s) are not marked completed`);
  } else if (before.status === PROJECT_STATUS.COMPLETED) {
    project.actualEndDate = undefined; // project was reopened
  }
  project.updatedBy = req.user._id;
  await project.save();

  await logAudit(req, {
    action: 'project.status_change',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    before,
    after: { status: project.status, actualEndDate: project.actualEndDate },
    note: reason,
  });

  res.json({
    success: true,
    data: projectService.shapeProject(project, req.user.role),
    ...(warnings.length && { warnings }),
  });
});

// POST /projects/:projectId/archive   (admin only)
// Archived projects disappear for engineers, workers and customers. Nothing is deleted.
export const archiveProject = asyncHandler(async (req, res) => {
  const { project } = req;
  if (project.isArchived) throw new ApiError(409, 'Project is already archived');

  project.isArchived = true;
  project.archivedAt = new Date();
  project.updatedBy = req.user._id;
  await project.save();

  await logAudit(req, {
    action: 'project.archive',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    note: req.body.reason,
  });
  res.json({ success: true, data: projectService.shapeProject(project, req.user.role) });
});

// POST /projects/:projectId/unarchive   (admin only)
export const unarchiveProject = asyncHandler(async (req, res) => {
  const { project } = req;
  if (!project.isArchived) throw new ApiError(409, 'Project is not archived');

  project.isArchived = false;
  project.archivedAt = undefined;
  project.updatedBy = req.user._id;
  await project.save();

  await logAudit(req, {
    action: 'project.unarchive',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
  });
  res.json({ success: true, data: projectService.shapeProject(project, req.user.role) });
});