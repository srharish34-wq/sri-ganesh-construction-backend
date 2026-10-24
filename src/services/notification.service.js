import Notification from '../models/Notification.js';
import User from '../models/User.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { ROLES } from '../config/constants.js';

/*
  In-app notifications. A failure here is logged and never breaks the request.
  payload: { type, title, message, project, entity: { kind, id }, dedupeKey }
  exclude: a user ID who should not be notified (usually the person who acted).
*/
export async function notifyUsers(userIds, payload, { exclude } = {}) {
  try {
    const ids = [...new Set(userIds.map(String))].filter((id) => id !== String(exclude));
    await Promise.allSettled(ids.map((user) => Notification.create({ ...payload, user })));
  } catch (err) {
    console.error('⚠️ Notification failed:', err.message);
  }
}

export async function notifyAdmins(payload, options) {
  const ids = await User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).distinct('_id');
  return notifyUsers(ids, payload, options);
}

export async function notifyProjectEngineers(projectId, payload, options) {
  const ids = await ProjectAssignment.find({
    project: projectId,
    role: ROLES.ENGINEER,
    isActive: true,
  }).distinct('user');
  return notifyUsers(ids, payload, options);
}