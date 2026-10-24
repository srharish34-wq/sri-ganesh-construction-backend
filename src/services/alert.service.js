import Milestone from '../models/Milestone.js';
import InventoryItem from '../models/InventoryItem.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import User from '../models/User.js';
import { notifyUsers } from './notification.service.js';
import { ROLES, NOTIFICATION_TYPE } from '../config/constants.js';
import { todayKeyIST, keyOf } from '../utils/dates.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const lowStockExpr = {
  $and: [{ $gt: ['$minStockThreshold', 0] }, { $lte: ['$currentBalance', '$minStockThreshold'] }],
};

// Admins plus the active engineers of each project, looked up once for the whole run
async function loadRecipients(projectIds) {
  const [adminIds, assignments] = await Promise.all([
    User.find({ role: ROLES.SUPER_ADMIN, isActive: true }).distinct('_id'),
    ProjectAssignment.find({ project: { $in: projectIds }, role: ROLES.ENGINEER, isActive: true })
      .select('project user')
      .lean(),
  ]);
  const engineersByProject = new Map();
  for (const a of assignments) {
    const key = String(a.project);
    if (!engineersByProject.has(key)) engineersByProject.set(key, []);
    engineersByProject.get(key).push(a.user);
  }
  return { adminIds, engineersByProject };
}

const liveProject = (p) => p && !p.isArchived && p.status !== 'completed';

/*
  Overdue milestones: due date passed and not completed.
  Each milestone is reminded at most once a week (the dedupeKey and the unique
  index on notifications stop repeats). The milestone status is NOT changed:
  "overdue" is always worked out from the due date.
*/
export async function runOverdueMilestoneAlerts() {
  const overdue = await Milestone.find({ status: { $ne: 'completed' }, dueDate: { $lt: new Date() } })
    .populate('project', 'name projectCode isArchived status')
    .lean();

  const items = overdue.filter((m) => liveProject(m.project));
  if (!items.length) return { checked: 0, alerts: 0 };

  const { adminIds, engineersByProject } = await loadRecipients(items.map((m) => m.project._id));
  const weekBucket = Math.floor(Date.now() / WEEK_MS);

  for (const m of items) {
    const recipients = [...adminIds, ...(engineersByProject.get(String(m.project._id)) ?? [])];
    await notifyUsers(recipients, {
      type: NOTIFICATION_TYPE.MILESTONE_OVERDUE,
      title: 'Milestone overdue',
      message: `"${m.title}" at ${m.project.name} was due on ${keyOf(m.dueDate)} and is not completed.`.slice(0, 500),
      project: m.project._id,
      entity: { kind: 'milestone', id: m._id },
      dedupeKey: `milestone_overdue:${m._id}:${weekBucket}`,
    });
  }
  return { checked: items.length, alerts: items.length };
}

/*
  Low stock: balance at or below the minimum. One alert per item per day.
  The key matches the one used in inventory.controller.js, so a person is never
  alerted twice on the same day for the same item.
*/
export async function runLowStockAlerts() {
  const low = await InventoryItem.find({ isActive: true, $expr: lowStockExpr })
    .populate('project', 'name projectCode isArchived status')
    .lean();

  const items = low.filter((i) => liveProject(i.project));
  if (!items.length) return { checked: 0, alerts: 0 };

  const { adminIds, engineersByProject } = await loadRecipients(items.map((i) => i.project._id));
  const today = todayKeyIST();

  for (const i of items) {
    const recipients = [...adminIds, ...(engineersByProject.get(String(i.project._id)) ?? [])];
    await notifyUsers(recipients, {
      type: NOTIFICATION_TYPE.LOW_STOCK,
      title: 'Low stock',
      message: `${i.name} is low at ${i.project.name}: ${i.currentBalance} ${i.unit} left (minimum ${i.minStockThreshold}).`.slice(0, 500),
      project: i.project._id,
      entity: { kind: 'inventory_item', id: i._id },
      dedupeKey: `low_stock:${i._id}:${today}`,
    });
  }
  return { checked: items.length, alerts: items.length };
}

// Runs every check. One failing check does not stop the others.
export async function runAllAlerts() {
  const result = {};
  for (const [name, fn] of [
    ['overdueMilestones', runOverdueMilestoneAlerts],
    ['lowStock', runLowStockAlerts],
  ]) {
    try {
      result[name] = await fn();
    } catch (err) {
      console.error(`⚠️ Alert check failed (${name}):`, err.message);
      result[name] = { error: err.message };
    }
  }
  return result;
}