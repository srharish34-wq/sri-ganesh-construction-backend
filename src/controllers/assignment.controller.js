import User from '../models/User.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Notification from '../models/Notification.js';
import { logAudit } from '../services/audit.service.js';
import { ROLES, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';

/*
  POST /projects/:projectId/assignments   (admin only; route uses projectAccess)
  Body: { userIds: [...] }  Engineers and workers only.
  All-or-nothing: if any person is invalid, nobody is assigned.
*/
export const assignUsers = asyncHandler(async (req, res) => {
  const { project } = req;
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');

  const userIds = req.body.userIds.map((id) => id.toLowerCase());
  const users = await User.find({ _id: { $in: userIds } });
  const byId = new Map(users.map((u) => [u.id, u]));

  const problems = [];
  for (const id of userIds) {
    const user = byId.get(id);
    if (!user) problems.push({ field: 'userIds', message: `User ${id} was not found` });
    else if (!user.isActive) problems.push({ field: 'userIds', message: `${user.name} is deactivated` });
    else if (user.role !== ROLES.ENGINEER && user.role !== ROLES.WORKER) {
      problems.push({ field: 'userIds', message: `${user.name} is a ${user.role} and cannot be assigned` });
    }
  }
  if (problems.length) throw new ApiError(400, 'Some people cannot be assigned', problems);

  const alreadyIds = new Set(
    (
      await ProjectAssignment.find({
        project: project._id,
        user: { $in: userIds },
        isActive: true,
      }).distinct('user')
    ).map(String)
  );
  const toAssign = userIds.filter((id) => !alreadyIds.has(id)).map((id) => byId.get(id));

  if (toAssign.length === 0) {
    return res.json({
      success: true,
      message: 'Everyone selected is already assigned to this project',
      data: { assigned: [], alreadyAssigned: alreadyIds.size },
    });
  }

  const created = await ProjectAssignment.insertMany(
    toAssign.map((u) => ({
      project: project._id,
      user: u._id,
      role: u.role,
      assignedBy: req.user._id,
    }))
  );

  // Tell each person. A failure here must not undo the assignment.
  try {
    await Notification.insertMany(
      toAssign.map((u) => ({
        user: u._id,
        type: NOTIFICATION_TYPE.TASK_ASSIGNED,
        title: 'New project assignment',
        message: `You have been assigned to ${project.name} (${project.projectCode}).`,
        project: project._id,
        entity: { kind: 'project', id: project._id },
      }))
    );
  } catch (err) {
    console.error('⚠️ Assignment notification failed:', err.message);
  }

  await logAudit(req, {
    action: 'project.assign',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    after: { assigned: toAssign.map((u) => ({ id: u.id, name: u.name, role: u.role })) },
  });

  res.status(201).json({
    success: true,
    data: { assigned: created, alreadyAssigned: alreadyIds.size },
  });
});

// DELETE /projects/:projectId/assignments/:userId   (admin only)
// The record is kept as history; the person loses access immediately.
export const unassignUser = asyncHandler(async (req, res) => {
  const { project } = req;

  const assignment = await ProjectAssignment.findOne({
    project: project._id,
    user: req.params.userId,
    isActive: true,
  }).populate('user', 'name role');
  if (!assignment) throw new ApiError(404, 'This person is not assigned to the project');

  assignment.isActive = false;
  assignment.unassignedAt = new Date();
  assignment.unassignedBy = req.user._id;
  await assignment.save();

  await logAudit(req, {
    action: 'project.unassign',
    entityType: 'Project',
    entityId: project._id,
    project: project._id,
    before: { id: assignment.user?.id, name: assignment.user?.name, role: assignment.role },
  });

  res.json({ success: true, message: 'Person removed from the project' });
});

/*
  GET /projects/:projectId/team?role=worker&page=1   (admin and engineer)
  Engineers see only the people on their own project (projectAccess checks that).
*/
export const listProjectTeam = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (role !== ROLES.SUPER_ADMIN && role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }

  const paging = getPagination(req.query);
  const filter = { project: req.project._id, isActive: true };
  if (req.query.role === ROLES.ENGINEER || req.query.role === ROLES.WORKER) filter.role = req.query.role;

  const fields =
    role === ROLES.SUPER_ADMIN
      ? 'name email phone trade dailyWageRate isActive'
      : 'name phone trade dailyWageRate isActive';

  const [rows, total] = await Promise.all([
    ProjectAssignment.find(filter)
      .sort({ role: 1, assignedAt: -1, _id: 1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .populate('user', fields),
    ProjectAssignment.countDocuments(filter),
  ]);

  const items = rows.map((a) => ({
    assignmentId: a._id,
    role: a.role,
    assignedAt: a.assignedAt,
    user: a.user,
  }));
  res.json({ success: true, data: buildPage(items, total, paging) });
});