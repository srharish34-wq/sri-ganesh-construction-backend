import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, get, post, patch,
  createSession, createUser, createProject, assign, today,
} from './setup.js';

let M, admin, eng, customer, project, otherProject;

const near = { latitude: 13.0827, longitude: 80.2707, accuracyMeters: 10 };
const far = { latitude: 13.0927, longitude: 80.2707, accuracyMeters: 10 }; // about 1.1 km north

before(async () => {
  M = await startTestServer();
  admin = await createSession('super_admin');
  eng = await createSession('engineer');
  customer = await createSession('customer');
  project = await createProject(customer.user);
  otherProject = await createProject(customer.user, { name: 'Other project' });
  await assign(project, eng.user, admin.user);
});
after(() => stopTestServer());

async function newWorker() {
  const w = await createSession('worker');
  await assign(project, w.user, admin.user);
  return w;
}
const checkIn = (s, gps = near, extra = {}) =>
  post(s, '/attendance/check-in', { projectId: project.id, ...gps, ...extra });

describe('GPS check-in and check-out', () => {
  it('records a worker at the site without warnings', async () => {
    const w = await newWorker();
    const res = await checkIn(w);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.warnings, []);
    assert.equal(res.body.data.checkIn.withinRadius, true);
    assert.equal(res.body.data.exception.flagged, false);
    assert.equal(res.body.data.dateKey, today());
  });

  it('allows only one check-in per day, and one check-out', async () => {
    const w = await newWorker();
    assert.equal((await post(w, '/attendance/check-out', { projectId: project.id, ...near })).status, 404); // not checked in yet
    assert.equal((await checkIn(w)).status, 201);
    assert.equal((await checkIn(w)).status, 409);
    assert.equal((await post(w, '/attendance/check-out', { projectId: project.id, ...near })).status, 200);
    assert.equal((await post(w, '/attendance/check-out', { projectId: project.id, ...near })).status, 409);
  });

  it('records a check-in far from the site but flags it for review', async () => {
    const w = await newWorker();
    const res = await checkIn(w, far);
    assert.equal(res.status, 201);
    assert.equal(res.body.warnings.length, 1);
    assert.equal(res.body.data.checkIn.withinRadius, false);
    assert.ok(res.body.data.checkIn.distanceFromSiteMeters > 150);
    assert.equal(res.body.data.exception.flagged, true);
  });

  it('records a check-in with no GPS as an exception, not as "inside"', async () => {
    const w = await newWorker();
    const res = await checkIn(w, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.data.checkIn.withinRadius, null);
    assert.equal(res.body.data.exception.flagged, true);
  });

  it('does not claim "inside the radius" when GPS accuracy is poor', async () => {
    const w = await newWorker();
    const res = await checkIn(w, { ...near, accuracyMeters: 500 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.checkIn.withinRadius, null);
    assert.equal(res.body.data.exception.flagged, true);
  });

  it('ignores a date or time sent by the phone', async () => {
    const w = await newWorker();
    const res = await checkIn(w, near, { dateKey: '2020-01-01', checkIn: { time: '2020-01-01T00:00:00Z' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.dateKey, today());
    assert.ok(Date.now() - new Date(res.body.data.checkIn.time).getTime() < 60000);
  });

  it('works for engineers too, and GET /attendance/today returns the record', async () => {
    const e = await createSession('engineer');
    await assign(project, e.user, admin.user);
    assert.equal((await checkIn(e)).status, 201);
    const res = await get(e, '/attendance/today', { projectId: project.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.record.dateKey, today());
  });

  it('refuses people who are not assigned, and customers', async () => {
    const outsider = await createSession('worker');
    assert.equal((await checkIn(outsider)).status, 404);

    const w = await newWorker();
    const res = await post(w, '/attendance/check-in', { projectId: otherProject.id, ...near });
    assert.equal(res.status, 404);

    assert.equal((await checkIn(customer)).status, 403);
  });
});

describe('manual entries by the engineer', () => {
  const entry = (s, workerId, over = {}) =>
    post(s, '/attendance/worker', { projectId: project.id, workerId, date: today(), status: 'present', ...over });

  it('records a worker and marks it as an engineer entry', async () => {
    const w = await newWorker();
    const res = await entry(eng, w.user.id);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.source, 'engineer_entry');
    assert.equal((await entry(eng, w.user.id)).status, 409); // already recorded for that date
  });

  it('refuses unassigned workers, future dates and old dates (engineer), but lets the admin back-date', async () => {
    const w = await newWorker();
    const loose = await createUser('worker');
    assert.equal((await entry(eng, loose.id)).status, 400);
    assert.equal((await entry(eng, w.user.id, { date: today(2) })).status, 400);
    assert.equal((await entry(eng, w.user.id, { date: today(-10) })).status, 400);
    assert.equal((await entry(admin, w.user.id, { date: today(-10) })).status, 201);
  });

  it('does not let a worker record attendance for anyone', async () => {
    const w = await newWorker();
    assert.equal((await entry(w, w.user.id)).status, 403);
  });
});

describe('confirm, correct and dispute', () => {
  it('stops people confirming their own record, and workers confirming anything', async () => {
    const w = await newWorker();
    const e = await createSession('engineer');
    await assign(project, e.user, admin.user);
    const workerRecord = (await checkIn(w)).body.data;
    const engineerRecord = (await checkIn(e)).body.data;

    assert.equal((await post(w, `/attendance/${workerRecord._id}/confirm`)).status, 403);
    assert.equal((await post(e, `/attendance/${engineerRecord._id}/confirm`)).status, 403); // own record
    assert.equal((await post(admin, `/attendance/${engineerRecord._id}/confirm`)).status, 200);

    assert.equal((await post(eng, `/attendance/${workerRecord._id}/confirm`)).status, 200);
    assert.equal((await post(eng, `/attendance/${workerRecord._id}/confirm`)).status, 409); // already confirmed
  });

  it('lets only the admin confirm a record flagged as a GPS exception', async () => {
    const w = await newWorker();
    const rec = (await checkIn(w, far)).body.data;
    assert.equal((await post(eng, `/attendance/${rec._id}/confirm`)).status, 403);
    assert.equal((await post(admin, `/attendance/${rec._id}/confirm`)).status, 200);
  });

  it('needs a reason for a correction, keeps the old values, and writes an audit entry', async () => {
    const w = await newWorker();
    const rec = (await checkIn(w)).body.data;
    await post(eng, `/attendance/${rec._id}/confirm`);

    assert.equal((await patch(admin, `/attendance/${rec._id}/correct`, { status: 'half_day' })).status, 400); // no reason
    assert.equal((await patch(eng, `/attendance/${rec._id}/correct`, { status: 'half_day', reason: 'Left at noon per log' })).status, 403); // confirmed: admin only

    const res = await patch(admin, `/attendance/${rec._id}/correct`, { status: 'half_day', reason: 'Left at noon per site log' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'half_day');
    assert.equal(res.body.data.corrections.length, 1);
    assert.equal(res.body.data.corrections[0].previous.status, 'present');

    const audit = await M.AuditLog.findOne({ action: 'attendance.correct', entityId: rec._id });
    assert.ok(audit);
    assert.equal((await M.Notification.countDocuments({ user: w.user._id, title: 'Attendance corrected' })), 1);
  });

  it('blocks an engineer correcting their own record', async () => {
    const e = await createSession('engineer');
    await assign(project, e.user, admin.user);
    const rec = (await checkIn(e)).body.data;
    const res = await patch(e, `/attendance/${rec._id}/correct`, { status: 'half_day', reason: 'Changing my own record' });
    assert.equal(res.status, 403);
  });

  it('runs a dispute from the worker to the engineer\'s answer', async () => {
    const w = await newWorker();
    const other = await newWorker();
    const rec = (await checkIn(w)).body.data;
    const base = `/attendance/${rec._id}`;

    assert.equal((await post(w, `${base}/dispute`, { reason: 'Wrong' })).status, 400); // too short
    assert.equal((await post(eng, `${base}/dispute`, { reason: 'I am an engineer here' })).status, 403);
    assert.equal((await post(other, `${base}/dispute`, { reason: 'Not my record at all' })).status, 404);

    const raised = await post(w, `${base}/dispute`, { reason: 'I worked a full day but was marked late' });
    assert.equal(raised.status, 201);
    assert.equal(raised.body.data.dispute.status, 'open');
    assert.equal((await post(w, `${base}/dispute`, { reason: 'Raising it a second time' })).status, 409);

    assert.equal((await post(eng, `${base}/confirm`)).status, 409); // must resolve first
    assert.equal((await post(w, `${base}/dispute/resolve`, { status: 'resolved', resolutionNote: 'Self resolve' })).status, 403);

    const resolved = await post(eng, `${base}/dispute/resolve`, { status: 'resolved', resolutionNote: 'Checked with the site log' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.dispute.status, 'resolved');
    assert.equal((await post(eng, `${base}/confirm`)).status, 200);
  });
});

describe('who can see which records', () => {
  it('shows a worker only their own history', async () => {
    const w = await newWorker();
    const other = await newWorker();
    await checkIn(w);
    await checkIn(other);

    const res = await get(w, '/attendance', { userId: other.user.id }); // the userId filter is ignored for workers
    assert.equal(res.status, 200);
    assert.ok(res.body.data.items.length >= 1);
    for (const item of res.body.data.items) assert.equal(String(item.user._id), w.user.id);
    assert.equal((await get(customer, '/attendance')).status, 403);
  });

  it('lets the admin filter for flagged exceptions', async () => {
    const res = await get(admin, '/attendance', { flagged: 'true' });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.items.length >= 1);
    for (const item of res.body.data.items) assert.equal(item.exception.flagged, true);
  });
});