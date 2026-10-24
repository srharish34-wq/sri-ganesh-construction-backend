import Attendance from '../models/Attendance.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { evaluatePunch } from '../services/attendance.service.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyProjectEngineers, notifyUsers } from '../services/notification.service.js';
import { resolveProjectAccess, accessibleProjectFilter } from '../middleware/projectAccess.js';
import { ROLES, ATTENDANCE_STATUS, ATTENDANCE_SOURCE, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { todayKeyIST, keyOf } from '../utils/dates.js';

const notFound = () => new ApiError(404, 'Attendance record not found');
const isAdmin = (user) => user.role === ROLES.SUPER_ADMIN;
const ENGINEER_BACKDATE_DAYS = 7;

const populateRecord = (query) =>
  query
    .populate('user', 'name role trade')
    .populate('project', 'projectCode name')
    .populate('recordedBy', 'name role');

function assertCanPunch(user) {
  if (user.role !== ROLES.ENGINEER && user.role !== ROLES.WORKER) {
    throw new ApiError(403, 'Only engineers and workers record their own attendance');
  }
}

// Loads a record and checks the caller may see it (same rules as projectAccess)
async function loadRecord(req, id) {
  const record = await Attendance.findById(id);
  if (!record) throw notFound();
  const project = await Project.findById(record.project);
  const role = project && (await resolveProjectAccess(req.user, project));
  if (!role || req.user.role === ROLES.CUSTOMER) throw notFound();
  if (project.isArchived && !isAdmin(req.user)) throw notFound();
  if (req.user.role === ROLES.WORKER && !record.user.equals(req.user._id)) throw notFound();
  return { record, project };
}

const staffOnly = (req) => {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }
};

const summarise = (issues) => issues.join(' ').slice(0, 300);

// GET /attendance/today?projectId=...   (route uses projectAccess({ from: 'query' }))
export const getToday = asyncHandler(async (req, res) => {
  assertCanPunch(req.user);
  const record = await populateRecord(
    Attendance.findOne({ project: req.project._id, user: req.user._id, dateKey: todayKeyIST() })
  );
  res.json({ success: true, data: { dateKey: todayKeyIST(), record } });
});

/*
  POST /attendance/check-in   (engineer or worker, for their own attendance)
  The server sets the time and the date. The phone sends only its GPS reading.
  Problems (no GPS, low accuracy, outside the radius) do not block the check-in:
  the record is saved, flagged as an exception, and the app shows the warning.
*/
export const checkIn = asyncHandler(async (req, res) => {
  assertCanPunch(req.user);
  const { project, user } = { project: req.project, user: req.user };
  const dateKey = todayKeyIST();

  const existing = await Attendance.findOne({ project: project._id, user: user._id, dateKey });
  if (existing) {
    throw new ApiError(
      409,
      existing.checkIn?.time
        ? 'You have already checked in today'
        : 'Your attendance for today was already recorded by your engineer'
    );
  }

  const { punch, issues } = evaluatePunch(project, req.body);
  let record;
  try {
    record = await Attendance.create({
      project: project._id,
      user: user._id,
      userRole: user.role,
      dateKey,
      checkIn: punch,
      status: ATTENDANCE_STATUS.PRESENT,
      source: ATTENDANCE_SOURCE.SELF_GPS,
      recordedBy: user._id,
      notes: req.body.notes,
      exception: { flagged: issues.length > 0, reason: issues.length ? summarise(issues) : undefined },
    });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'You have already checked in today');
    throw err;
  }

  res.status(201).json({
    success: true,
    message: issues.length
      ? 'Check-in recorded, but it was flagged for review.'
      : 'Checked in successfully.',
    warnings: issues,
    data: record,
  });
});

// POST /attendance/check-out
export const checkOut = asyncHandler(async (req, res) => {
  assertCanPunch(req.user);
  const record = await Attendance.findOne({
    project: req.project._id,
    user: req.user._id,
    dateKey: todayKeyIST(),
  });

  if (!record || !record.checkIn?.time) throw new ApiError(404, 'You have not checked in today');
  if (record.checkOut?.time) throw new ApiError(409, 'You have already checked out today');
  if (record.isConfirmed) {
    throw new ApiError(409, 'This record is confirmed. Ask your engineer to correct it.');
  }

  const { punch, issues } = evaluatePunch(req.project, req.body);
  record.checkOut = punch;
  if (req.body.notes) record.notes = req.body.notes;
  if (issues.length) {
    record.exception.flagged = true;
    record.exception.reason = [record.exception.reason, `Check-out: ${summarise(issues)}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300);
  }
  await record.save();

  res.json({
    success: true,
    message: issues.length ? 'Check-out recorded, but it was flagged for review.' : 'Checked out successfully.',
    warnings: issues,
    data: record,
  });
});

/*
  POST /attendance/worker   (admin or engineer; route uses projectAccess({ from: 'body' }))
  Used when a worker has no phone, or GPS failed. The record is marked as an
  engineer entry. Engineers can enter up to 7 days back; the admin any date.
*/
function checkEntryDate(user, date) {
  const today = todayKeyIST();
  if (date > today) throw new ApiError(400, 'Date cannot be in the future', [{ field: 'date', message: 'Date cannot be in the future' }]);
  if (!isAdmin(user)) {
    const cutoff = keyOf(new Date(Date.now() - ENGINEER_BACKDATE_DAYS * 24 * 3600 * 1000));
    if (date < cutoff) {
      const message = `Engineers can enter attendance only for the last ${ENGINEER_BACKDATE_DAYS} days`;
      throw new ApiError(400, message, [{ field: 'date', message }]);
    }
  }
}

export const recordWorkerAttendance = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { project, user } = { project: req.project, user: req.user };
  const { workerId, date, status, checkInTime, checkOutTime, notes } = req.body;
  checkEntryDate(user, date);

  const assigned = await ProjectAssignment.exists({
    project: project._id, user: workerId, role: ROLES.WORKER, isActive: true,
  });
  if (!assigned) {
    throw new ApiError(400, 'This worker is not assigned to the project', [
      { field: 'workerId', message: 'Select a worker assigned to this project' },
    ]);
  }

  const absent = status === ATTENDANCE_STATUS.ABSENT;
  try {
    const record = await Attendance.create({
      project: project._id,
      user: workerId,
      userRole: ROLES.WORKER,
      dateKey: date,
      status,
      source: ATTENDANCE_SOURCE.ENGINEER_ENTRY,
      recordedBy: user._id,
      checkIn: !absent && checkInTime ? { time: checkInTime, withinRadius: null } : undefined,
      checkOut: !absent && checkOutTime ? { time: checkOutTime, withinRadius: null } : undefined,
      notes,
    });
    await logAudit(req, {
      action: 'attendance.manual_entry', entityType: 'Attendance', entityId: record._id,
      project: project._id, after: record,
    });
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    if (err.code === 11000) {
      throw new ApiError(409, 'Attendance for this worker and date already exists. Use a correction to change it.');
    }
    throw err;
  }
});

// POST /attendance/worker/bulk   (admin or engineer)
export const bulkWorkerAttendance = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { project, user } = { project: req.project, user: req.user };
  const { date, entries } = req.body;
  checkEntryDate(user, date);

  const ids = entries.map((e) => e.workerId);
  const [assignedIds, alreadyIds] = await Promise.all([
    ProjectAssignment.find({ project: project._id, user: { $in: ids }, role: ROLES.WORKER, isActive: true }).distinct('user'),
    Attendance.find({ project: project._id, dateKey: date, user: { $in: ids } }).distinct('user'),
  ]);
  const assigned = new Set(assignedIds.map(String));
  const already = new Set(alreadyIds.map(String));

  const toCreate = [];
  const skipped = [];
  for (const e of entries) {
    if (!assigned.has(e.workerId.toLowerCase())) skipped.push({ workerId: e.workerId, reason: 'Not assigned to this project' });
    else if (already.has(e.workerId.toLowerCase())) skipped.push({ workerId: e.workerId, reason: 'Already recorded for this date' });
    else {
      toCreate.push({
        project: project._id, user: e.workerId, userRole: ROLES.WORKER, dateKey: date,
        status: e.status, source: ATTENDANCE_SOURCE.ENGINEER_ENTRY, recordedBy: user._id, notes: e.notes,
      });
    }
  }

  const created = toCreate.length ? await Attendance.insertMany(toCreate) : [];
  if (created.length) {
    await logAudit(req, {
      action: 'attendance.bulk_entry', entityType: 'Project', entityId: project._id, project: project._id,
      after: { date, created: created.length },
    });
  }
  res.status(created.length ? 201 : 200).json({
    success: true,
    data: { createdCount: created.length, skipped },
  });
});

// GET /attendance
export const listAttendance = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const user = req.user;
  if (user.role === ROLES.CUSTOMER) throw new ApiError(403, 'You do not have permission to do this');
  const paging = getPagination(q);
  const filter = {};

  if (user.role === ROLES.WORKER) {
    filter.user = user._id; // workers see only their own history
  } else if (user.role === ROLES.ENGINEER) {
    const ids = await Project.find(await accessibleProjectFilter(user)).distinct('_id');
    if (q.projectId && !ids.some((id) => id.equals(q.projectId))) throw new ApiError(404, 'Project not found');
    filter.project = { $in: ids };
    if (q.userId) filter.user = q.userId;
  } else if (q.userId) {
    filter.user = q.userId;
  }
  if (q.projectId) filter.project = q.projectId;
  if (q.status) filter.status = q.status;
  if (q.flagged !== undefined) filter['exception.flagged'] = q.flagged;
  if (q.disputed) filter['dispute.status'] = 'open';
  if (q.from || q.to) filter.dateKey = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };

  const [items, total] = await Promise.all([
    populateRecord(Attendance.find(filter).sort({ dateKey: -1, _id: -1 }).skip(paging.skip).limit(paging.limit)),
    Attendance.countDocuments(filter),
  ]);
  res.json({ success: true, data: buildPage(items, total, paging) });
});

/*
  POST /attendance/:id/confirm   (admin or engineer)
  Nobody confirms their own record. Engineers can confirm normal records and
  engineer entries; records flagged as GPS exceptions need the admin.
*/
export const confirmAttendance = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { record } = await loadRecord(req, req.params.id);

  if (record.isConfirmed) throw new ApiError(409, 'Already confirmed');
  if (record.user.equals(req.user._id)) throw new ApiError(403, 'You cannot confirm your own attendance');
  if (record.exception?.flagged && !isAdmin(req.user)) {
    throw new ApiError(403, 'This record is flagged. The admin must confirm it.');
  }
  if (record.dispute?.status === 'open') throw new ApiError(409, 'Resolve the dispute before confirming');

  record.isConfirmed = true;
  record.confirmedBy = req.user._id;
  record.confirmedAt = new Date();
  await record.save();

  await logAudit(req, {
    action: 'attendance.confirm', entityType: 'Attendance', entityId: record._id,
    project: record.project, note: record.exception?.flagged ? `Flagged: ${record.exception.reason}` : undefined,
  });
  res.json({ success: true, data: record });
});

/*
  PATCH /attendance/:id/correct   (admin or engineer)
  Always needs a reason. The old values are saved in the record's history.
  Confirmed records can be corrected only by the admin. Nobody corrects their own.
*/
export const correctAttendance = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { record } = await loadRecord(req, req.params.id);
  const { status, checkInTime, checkOutTime, reason } = req.body;

  if (record.user.equals(req.user._id)) throw new ApiError(403, 'You cannot correct your own attendance');
  if (record.isConfirmed && !isAdmin(req.user)) {
    throw new ApiError(403, 'This record is confirmed. Only the admin can correct it.');
  }

  const previous = { status: record.status, checkInTime: record.checkIn?.time, checkOutTime: record.checkOut?.time };

  if (status) record.status = status;
  if (checkInTime) record.checkIn = { ...(record.checkIn ? record.checkIn.toObject() : { withinRadius: null }), time: checkInTime };
  if (checkOutTime) record.checkOut = { ...(record.checkOut ? record.checkOut.toObject() : { withinRadius: null }), time: checkOutTime };

  record.corrections.push({ correctedBy: req.user._id, reason, previous });
  await record.save();

  await logAudit(req, {
    action: 'attendance.correct', entityType: 'Attendance', entityId: record._id, project: record.project,
    before: previous, after: { status: record.status, checkInTime: record.checkIn?.time, checkOutTime: record.checkOut?.time },
    note: reason,
  });
  await notifyUsers([record.user], {
    type: NOTIFICATION_TYPE.GENERAL, title: 'Attendance corrected',
    message: `Your attendance for ${record.dateKey} was corrected: ${reason}`.slice(0, 500),
    project: record.project, entity: { kind: 'attendance', id: record._id },
  });
  res.json({ success: true, data: record });
});

// POST /attendance/:id/dispute   (the worker raises it on their own record)
export const raiseDispute = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.WORKER) throw new ApiError(403, 'Only workers can raise an attendance dispute');
  const { record } = await loadRecord(req, req.params.id);
  if (record.dispute?.status === 'open') throw new ApiError(409, 'A dispute is already open on this record');

  record.dispute = { status: 'open', reason: req.body.reason, raisedAt: new Date() };
  await record.save();

  const payload = {
    type: NOTIFICATION_TYPE.APPROVAL_PENDING, title: 'Attendance dispute',
    message: `${req.user.name} disputed attendance for ${record.dateKey}.`,
    project: record.project, entity: { kind: 'attendance', id: record._id },
  };
  await notifyProjectEngineers(record.project, payload);
  await notifyAdmins(payload);
  await logAudit(req, {
    action: 'attendance.dispute_raised', entityType: 'Attendance', entityId: record._id,
    project: record.project, note: req.body.reason,
  });
  res.status(201).json({ success: true, data: record });
});

// POST /attendance/:id/dispute/resolve   (admin or engineer)
export const resolveDispute = asyncHandler(async (req, res) => {
  staffOnly(req);
  const { record } = await loadRecord(req, req.params.id);
  if (record.dispute?.status !== 'open') throw new ApiError(409, 'There is no open dispute on this record');

  record.dispute.status = req.body.status;
  record.dispute.resolvedBy = req.user._id;
  record.dispute.resolvedAt = new Date();
  record.dispute.resolutionNote = req.body.resolutionNote;
  await record.save();

  await logAudit(req, {
    action: 'attendance.dispute_resolved', entityType: 'Attendance', entityId: record._id,
    project: record.project, note: `${req.body.status}: ${req.body.resolutionNote}`,
  });
  await notifyUsers([record.user], {
    type: NOTIFICATION_TYPE.APPROVAL_RESULT, title: 'Attendance dispute answered',
    message: `Your dispute for ${record.dateKey} was ${req.body.status}. ${req.body.resolutionNote}`.slice(0, 500),
    project: record.project, entity: { kind: 'attendance', id: record._id },
  });
  res.json({ success: true, data: record });
});