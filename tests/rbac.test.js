import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, get, post, patch, del,
  createSession, createProject, assign,
} from './setup.js';

let M, admin, engA, engB, workerA, workerB, custA, custB, projA, projB;

before(async () => {
  M = await startTestServer();
  admin = await createSession('super_admin');
  [engA, engB, workerA, workerB, custA, custB] = await Promise.all(
    ['engineer', 'engineer', 'worker', 'worker', 'customer', 'customer'].map((r) => createSession(r))
  );
  projA = await createProject(custA.user, { name: 'Project A' });
  projB = await createProject(custB.user, { name: 'Project B' });
  await assign(projA, engA.user, admin.user);
  await assign(projA, workerA.user, admin.user);
  await assign(projB, engB.user, admin.user);
  await assign(projB, workerB.user, admin.user);
});
after(() => stopTestServer());

describe('no token, no access', () => {
  it('rejects every protected route without a token', async () => {
    const id = projA.id;
    const paths = [
      '/projects', '/users', '/attendance', '/reports', '/wages', '/worker-payments', '/dashboard',
      '/notifications', '/exports/projects', '/audit-logs', `/projects/${id}`,
      `/projects/${id}/milestones`, `/projects/${id}/expenses`, `/projects/${id}/customer-payments`,
      `/projects/${id}/inventory/items`, `/media?projectId=${id}`,
    ];
    for (const path of paths) {
      assert.equal((await get(undefined, path)).status, 401, `GET ${path}`);
    }
  });
});

describe('project visibility', () => {
  it('lists only the projects each person may see', async () => {
    assert.equal((await get(admin, '/projects')).body.data.pagination.total, 2);
    for (const [s, project] of [[engA, projA], [workerA, projA], [custA, projA], [engB, projB], [custB, projB]]) {
      const res = await get(s, '/projects');
      assert.equal(res.body.data.pagination.total, 1);
      assert.equal(String(res.body.data.items[0]._id), project.id);
    }
  });

  it('answers 404 for another project, the same as for one that does not exist', async () => {
    const missing = await get(engA, '/projects/aaaaaaaaaaaaaaaaaaaaaaaa');
    for (const s of [engA, workerA, custA]) {
      const res = await get(s, `/projects/${projB.id}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.message, missing.body.message); // IDs cannot be probed
    }
    assert.equal((await get(engA, '/projects/not-an-id')).status, 400);
  });

  it('shows each role only the fields it may see', async () => {
    const has = (res, field) => field in res.body.data;

    const a = await get(admin, `/projects/${projA.id}`);
    assert.ok(has(a, 'budget') && has(a, 'contractValue'));

    const e = await get(engA, `/projects/${projA.id}`);
    assert.equal(e.status, 200);
    assert.ok(!has(e, 'budget') && !has(e, 'contractValue'));

    const c = await get(custA, `/projects/${projA.id}`);
    assert.ok(has(c, 'contractValue'));
    assert.ok(!has(c, 'budget') && !has(c, 'siteLocation'));

    const w = await get(workerA, `/projects/${projA.id}`);
    assert.equal(w.status, 200);
    for (const f of ['budget', 'contractValue', 'siteLocation', 'customer']) assert.ok(!has(w, f), f);

    const list = await get(engA, '/projects');
    assert.ok(!('budget' in list.body.data.items[0]));
  });
});

describe('role-restricted actions', () => {
  it('keeps user management admin-only', async () => {
    for (const s of [engA, workerA, custA]) {
      assert.equal((await get(s, '/users')).status, 403);
      assert.equal((await post(s, '/users', { name: 'X Y', role: 'worker', phone: '9876543210', password: 'Passw0rd123' })).status, 403);
    }
  });

  it('keeps project creation, assignment and admin tools away from other roles', async () => {
    for (const s of [engA, workerA, custA]) {
      assert.equal((await post(s, '/projects', {})).status, 403);
      assert.equal((await get(s, '/audit-logs')).status, 403);
      assert.equal((await get(s, '/exports/projects')).status, 403);
      assert.equal((await get(s, '/dashboard/finance')).status, 403);
      assert.equal((await get(s, '/dashboard/approvals')).status, 403);
    }
    assert.equal((await post(engA, `/projects/${projA.id}/assignments`, { userIds: [workerB.user.id] })).status, 403);
  });

  it('keeps money, inventory and milestones away from roles that should not see them', async () => {
    assert.equal((await get(custA, `/projects/${projA.id}/expenses`)).status, 403);
    assert.equal((await get(workerA, `/projects/${projA.id}/expenses`)).status, 403);
    assert.equal((await get(workerA, `/projects/${projA.id}/customer-payments`)).status, 403);
    assert.equal((await get(workerA, `/projects/${projA.id}/inventory/items`)).status, 403);
    assert.equal((await get(custA, `/projects/${projA.id}/inventory/items`)).status, 403);
    assert.equal((await get(workerA, `/projects/${projA.id}/milestones`)).status, 403);
  });

  it('does not let an admin create another Super Admin through the API', async () => {
    const res = await post(admin, '/users', {
      name: 'Evil Admin', role: 'super_admin', email: 'evil@example.test', password: 'Passw0rd123',
    });
    assert.equal(res.status, 400);
    assert.equal(await M.User.countDocuments({ email: 'evil@example.test' }), 0);
  });

  it('does not let a role be changed by editing a user', async () => {
    const res = await patch(admin, `/users/${workerA.user.id}`, { role: 'super_admin' });
    assert.equal(res.status, 400); // unknown field is dropped, leaving nothing to update
    assert.equal((await M.User.findById(workerA.user._id)).role, 'worker');
  });
});

describe('access changes take effect immediately', () => {
  it('removes an engineer from a project on the next request', async () => {
    const eng = await createSession('engineer');
    await assign(projA, eng.user, admin.user);
    assert.equal((await get(eng, `/projects/${projA.id}`)).status, 200);

    const res = await del(admin, `/projects/${projA.id}/assignments/${eng.user.id}`);
    assert.equal(res.status, 200);
    assert.equal((await get(eng, `/projects/${projA.id}`)).status, 404); // same token, no waiting
  });

  it('locks out a user the moment the admin deactivates them', async () => {
    const eng = await createSession('engineer');
    assert.equal((await get(eng, '/projects')).status, 200);
    assert.equal((await patch(admin, `/users/${eng.user.id}`, { isActive: false })).status, 200);
    const res = await get(eng, '/projects');
    assert.equal(res.status, 401);
    assert.equal(res.body.details.code, 'ACCOUNT_DISABLED');
  });

  it('hides archived projects from everyone except the admin', async () => {
    const cust = await createSession('customer');
    const eng = await createSession('engineer');
    const proj = await createProject(cust.user, { name: 'To archive' });
    await assign(proj, eng.user, admin.user);
    assert.equal((await get(cust, `/projects/${proj.id}`)).status, 200);

    assert.equal((await post(admin, `/projects/${proj.id}/archive`, {})).status, 200);
    assert.equal((await get(cust, `/projects/${proj.id}`)).status, 404);
    assert.equal((await get(eng, `/projects/${proj.id}`)).status, 404);
    assert.equal((await get(cust, '/projects')).body.data.pagination.total, 0);
    assert.equal((await get(admin, `/projects/${proj.id}`)).status, 200);
  });
});

describe('customers see only published, approved content', () => {
  let published, submitted, draft;

  before(async () => {
    const mk = (date, status, extra = {}) =>
      M.DailyReport.create({
        project: projA._id, author: engA.user._id, reportDate: new Date(date),
        workCompleted: 'Internal: poured slab, rework needed', workCategories: ['concrete'],
        progressPercent: 30, delays: 'Internal delay', issues: 'Internal issue', status, ...extra,
      });
    draft = await mk('2026-03-01', 'draft');
    submitted = await mk('2026-03-02', 'submitted');
    published = await mk('2026-03-03', 'published', {
      customerSummary: 'Slab work was completed this week.', publishedAt: new Date(),
    });
  });

  it('shows the customer only published reports, and only the summary', async () => {
    const list = await get(custA, '/reports');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 1);
    const item = list.body.data.items[0];
    assert.equal(item.customerSummary, 'Slab work was completed this week.');
    for (const f of ['workCompleted', 'delays', 'issues', 'nextDayPlan', 'author']) assert.ok(!(f in item), f);

    assert.equal((await get(custA, `/reports/${draft.id}`)).status, 404);
    assert.equal((await get(custA, `/reports/${submitted.id}`)).status, 404);
    const one = await get(custA, `/reports/${published.id}`);
    assert.equal(one.status, 200);
    assert.ok(!('workCompleted' in one.body.data));
  });

  it('keeps reports away from other customers, workers and unassigned engineers', async () => {
    assert.equal((await get(custB, `/reports/${published.id}`)).status, 404);
    assert.equal((await get(workerA, '/reports')).status, 403);
    assert.equal((await get(engB, '/reports')).body.data.pagination.total, 0);
    assert.equal((await get(engB, `/reports/${published.id}`)).status, 404);
  });

  it('shows photos only when marked visible AND the report is published', async () => {
    const mk = (n, report, visible) =>
      M.Media.create({
        project: projA._id, report: report?._id, uploadedBy: engA.user._id, type: 'image',
        cloudinary: { publicId: `sgc/projects/${projA.id}/m${n}`, resourceType: 'image' },
        secureUrl: `https://res.cloudinary.com/demo/image/authenticated/m${n}.jpg`,
        isCustomerVisible: visible,
      });
    const shown = await mk(1, published, true);
    const hiddenByReport = await mk(2, submitted, true);
    const hiddenByFlag = await mk(3, published, false);
    const noReport = await mk(4, null, true);

    const list = await get(custA, '/media', { projectId: projA.id });
    assert.equal(list.status, 200);
    const ids = list.body.data.items.map((m) => String(m._id)).sort();
    assert.deepEqual(ids, [shown.id, noReport.id].sort());
    for (const m of list.body.data.items) {
      assert.ok(!('secureUrl' in m) && !('cloudinary' in m) && !('uploadedBy' in m));
    }

    assert.equal((await get(custA, `/media/${hiddenByReport.id}`)).status, 404);
    assert.equal((await get(custA, `/media/${hiddenByFlag.id}`)).status, 404);
    assert.equal((await get(custA, `/media/${shown.id}`)).status, 200);
    assert.equal((await get(custB, '/media', { projectId: projA.id })).status, 404);
    assert.equal((await get(workerA, '/media', { projectId: projA.id })).status, 403);
  });
});

describe('workers see only their own money', () => {
  let wageA, wageB;

  before(async () => {
    const mk = (project, worker) =>
      M.WorkerWage.create({
        project: project._id, worker: worker._id, periodStart: new Date('2026-02-01'),
        periodEnd: new Date('2026-02-07'), daysWorked: 6, dailyRate: 800, grossAmount: 4800,
        status: 'approved', createdBy: engA.user._id,
      });
    wageA = await mk(projA, workerA.user);
    wageB = await mk(projB, workerB.user);
  });

  it('blocks reading another worker\'s wages and balance', async () => {
    const list = await get(workerA, '/wages');
    assert.equal(list.body.data.pagination.total, 1);
    assert.equal(String(list.body.data.items[0].worker), workerA.user.id);

    // The workerId filter is ignored for workers
    assert.equal((await get(workerA, '/wages', { workerId: workerB.user.id })).body.data.pagination.total, 1);

    assert.equal((await get(workerA, `/wages/${wageB.id}`)).status, 404);
    assert.equal((await get(workerA, `/wages/${wageA.id}`)).status, 200);
    assert.equal((await get(workerA, `/workers/${workerB.user.id}/balance`)).status, 404);
    assert.equal((await get(engA, `/wages/${wageB.id}`)).status, 404); // engineer not on that project
    assert.equal((await get(custA, '/wages')).status, 403);
  });
});

describe('notifications are private', () => {
  it('stops one user from reading, changing or deleting another user\'s notifications', async () => {
    const n = await M.Notification.create({ user: custB.user._id, title: 'Private', message: 'For B only' });

    assert.equal((await post(custA, `/notifications/${n.id}/read`)).status, 404);
    assert.equal((await del(custA, `/notifications/${n.id}`)).status, 404);
    assert.equal((await get(custA, '/notifications')).body.data.items.length, 0);

    assert.equal((await post(custB, `/notifications/${n.id}/read`)).status, 200);
    assert.equal((await get(custB, '/notifications')).body.data.items.length, 1);
  });
});