import User from '../models/User.js';
import CustomerProfile from '../models/CustomerProfile.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import * as authService from '../services/auth.service.js';
import { logAudit } from '../services/audit.service.js';
import { ROLES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage, escapeRegex } from '../utils/pagination.js';

const isSelf = (req, user) => user._id.equals(req.user._id);

async function findUserOr404(id) {
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

// POST /users   (admin only)
export const createUser = asyncHandler(async (req, res) => {
  const { customerProfile, password, ...fields } = req.body;

  if (fields.role !== ROLES.WORKER) {
    delete fields.trade;
    delete fields.dailyWageRate;
  }

  const user = await User.create({
    ...fields,
    passwordHash: await authService.hashPassword(password),
    mustChangePassword: true, // they choose their own password on first login
    createdBy: req.user._id,
  });

  let profile;
  if (user.role === ROLES.CUSTOMER) {
    try {
      profile = await CustomerProfile.create({ user: user._id, ...(customerProfile || {}) });
    } catch (err) {
      await User.deleteOne({ _id: user._id }); // do not leave a half-created account
      throw err;
    }
  }

  await logAudit(req, {
    action: 'user.create',
    entityType: 'User',
    entityId: user._id,
    after: user,
    note: `Role: ${user.role}`,
  });

  res.status(201).json({
    success: true,
    data: { ...user.toJSON(), ...(profile && { customerProfile: profile.toJSON() }) },
  });
});

// GET /users   (admin only)
export const listUsers = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const paging = getPagination(q);
  const filter = {};

  if (q.role) filter.role = q.role;
  if (q.isActive !== undefined) filter.isActive = q.isActive;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  if (q.projectId) {
    filter._id = {
      $in: await ProjectAssignment.find({ project: q.projectId, isActive: true }).distinct('user'),
    };
  }

  const [items, total] = await Promise.all([
    User.find(filter).sort({ name: 1, _id: 1 }).skip(paging.skip).limit(paging.limit),
    User.countDocuments(filter),
  ]);

  res.json({ success: true, data: buildPage(items, total, paging) });
});

// GET /users/:id   (admin only)
export const getUser = asyncHandler(async (req, res) => {
  const user = await findUserOr404(req.params.id);
  const data = user.toJSON();

  if (user.role === ROLES.CUSTOMER) {
    data.customerProfile = await CustomerProfile.findOne({ user: user._id }).select('+internalNotes');
  }
  if (user.role === ROLES.ENGINEER || user.role === ROLES.WORKER) {
    data.assignments = await ProjectAssignment.find({ user: user._id, isActive: true }).populate(
      'project',
      'projectCode name status'
    );
  }
  res.json({ success: true, data });
});

/*
  PATCH /users/:id   (admin only)
  The role cannot be changed. The address inside customerProfile is replaced
  as a whole, so send the complete address.
*/
export const updateUser = asyncHandler(async (req, res) => {
  const user = await findUserOr404(req.params.id);
  const { customerProfile, ...fields } = req.body;

  if (user.role === ROLES.SUPER_ADMIN && !isSelf(req, user)) {
    throw new ApiError(403, 'You cannot change another Super Admin account');
  }
  if (isSelf(req, user) && fields.isActive === false) {
    throw new ApiError(400, 'You cannot deactivate your own account');
  }
  if ((fields.trade !== undefined || fields.dailyWageRate !== undefined) && user.role !== ROLES.WORKER) {
    throw new ApiError(400, 'Only workers have a trade or daily wage rate');
  }
  if (customerProfile && user.role !== ROLES.CUSTOMER) {
    throw new ApiError(400, 'Only customers have a customer profile');
  }

  const before = user.toJSON();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) user.set(key, value);
  }
  await user.save();

  if (customerProfile) {
    const profile = (await CustomerProfile.findOne({ user: user._id })) || new CustomerProfile({ user: user._id });
    profile.set(customerProfile);
    await profile.save();
  }

  if (before.isActive && !user.isActive) await authService.revokeAllSessions(user._id);

  let action = 'user.update';
  if (before.isActive && !user.isActive) action = 'user.deactivate';
  else if (!before.isActive && user.isActive) action = 'user.reactivate';

  await logAudit(req, {
    action,
    entityType: 'User',
    entityId: user._id,
    before,
    after: user,
    note: customerProfile ? 'Customer profile updated' : undefined,
  });

  res.json({ success: true, data: user });
});

// POST /users/:id/reset-password   (admin only)
export const resetUserPassword = asyncHandler(async (req, res) => {
  const user = await findUserOr404(req.params.id);
  if (user.role === ROLES.SUPER_ADMIN && !isSelf(req, user)) {
    throw new ApiError(403, 'You cannot reset another Super Admin password');
  }

  await authService.setPassword(user._id, req.body.newPassword, { mustChangePassword: true });
  await logAudit(req, { action: 'user.admin_reset_password', entityType: 'User', entityId: user._id });

  res.json({
    success: true,
    message: 'Password reset. The user has been logged out and must choose a new password at next login.',
  });
});