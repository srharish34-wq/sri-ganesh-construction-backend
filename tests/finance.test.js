import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, get, post, patch,
  createSession, createProject, assign, today,
} from './setup.js';

let M, admin, engA, engB, engC, cust, cust2, worker, worker2, outsider, P;
let seq = 0;

before(async () => {
  M = await startTestServer();
  [admin, engA, engB, engC, cust, cust2, worker, worker2, outsider] = await Promise.all(
    ['super_admin', 'engineer', 'engineer', 'engineer', 'customer', 'customer', 'worker', 'worker', 'worker'].map((r) => createSession(r))
  );
  P = await createProject(cust.user); // contract 10,00,000 and budget 8,00,000
  for (const s of [engA, engB, worker, worker2]) await assign(P, s.user, admin.user);
});
after(() => stopTestServer());

// ================= CUSTOMER PAYMENTS =================
describe('customer payments', () => {
  const url = (path = '') => `/projects/${P.id}/customer-payments${path}`;
  const body = (over = {}) => ({ type: 'instalment', amount: 100000, mode: 'cash', paymentDate: today(), ...over });
  const summary = async (s) => (await get(s, url('/summary'))).body.data;
  const record = (s, over) => post(s, url(), body(over));
  let confirmedId;

  it('starts as pending and does not count as received', async () => {
    const res = await record(engA);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'pending');

    const forCustomer = await summary(cust);
    assert.equal(forCustomer.received, 0);
    assert.equal(forCustomer.outstanding, 1000000);
    assert.equal((await summary(admin)).pending.total, 100000);
    assert.equal((await get(cust, url())).body.data.items.length, 0); // customer cannot see pending
    confirmedId = res.body.data._id;
  });

  it('can be confirmed only by the admin, once, and then counts', async () => {
    assert.equal((await post(engA, url(`/${confirmedId}/confirm`))).status, 403);
    assert.equal((await post(cust, url(`/${confirmedId}/confirm`))).status, 403);

    const res = await post(admin, url(`/${confirmedId}/confirm`));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'confirmed');
    assert.match(res.body.data.receiptNumber, /^RCPT-\d{4}-\d{5}$/);

    assert.equal((await post(admin, url(`/${confirmedId}/confirm`))).status, 409);
    const s = await summary(cust);
    assert.equal(s.received, 100000);
    assert.equal(s.outstanding, 900000);
    assert.equal(s.percentPaid, 10);
  });

  it('shows the customer a confirmed payment without internal details', async () => {
    const list = await get(cust, url());
    assert.equal(list.body.data.items.length, 1);
    const item = list.body.data.items[0];
    for (const f of ['notes', 'recordedBy', 'confirmedBy', 'proof']) assert.ok(!(f in item), f);
    assert.ok(item.receiptNumber);
  });

  it('locks the amount once confirmed', async () => {
    const doc = await M.CustomerPayment.findById(confirmedId);
    doc.amount = 1;
    await assert.rejects(() => doc.save(), /cannot be edited/);
  });

  it('checks the form: reference, decimals, zero and future dates', async () => {
    assert.equal((await record(engA, { mode: 'upi' })).status, 400); // UPI needs a reference
    assert.equal((await record(engA, { amount: 100.456 })).status, 400);
    assert.equal((await record(engA, { amount: 0 })).status, 400);
    assert.equal((await record(engA, { paymentDate: today(2) })).status, 400);
  });

  it('blocks the same bank reference being entered twice', async () => {
    assert.equal((await record(engA, { mode: 'upi', reference: 'UTR-TEST-0001' })).status, 201);
    assert.equal((await record(engA, { mode: 'upi', reference: 'UTR-TEST-0001' })).status, 409);
  });

  it('refuses to confirm a payment that would exceed the contract value', async () => {
    const big = await record(engA, { amount: 2000000 });
    const res = await post(admin, url(`/${big.body.data._id}/confirm`));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /contract value/);
  });

  it('needs a reason to reject, and rejected money never counts', async () => {
    const before = (await summary(admin)).received;
    const p = (await record(engA, { amount: 40000 })).body.data;
    assert.equal((await post(admin, url(`/${p._id}/reject`), {})).status, 400);
    const res = await post(admin, url(`/${p._id}/reject`), { reason: 'Amount does not match the bank slip' });
    assert.equal(res.body.data.status, 'rejected');
    assert.equal((await summary(admin)).received, before);
  });

  it('fixes a confirmed mistake by cancelling it, and receipt numbers are unique', async () => {
    const before = (await summary(admin)).received;
    const a = (await record(engA, { amount: 50000 })).body.data;
    const b = (await record(engA, { amount: 20000 })).body.data;
    const ra = (await post(admin, url(`/${a._id}/confirm`))).body.data.receiptNumber;
    const rb = (await post(admin, url(`/${b._id}/confirm`))).body.data.receiptNumber;
    assert.notEqual(ra, rb);
    assert.equal((await summary(admin)).received, before + 70000);

    assert.equal((await post(admin, url(`/${a._id}/cancel`), {})).status, 400);
    const res = await post(admin, url(`/${a._id}/cancel`), { reason: 'Entered twice by mistake' });
    assert.equal(res.body.data.status, 'cancelled');
    assert.equal((await summary(admin)).received, before + 20000);
  });

  it('shows an engineer only the entries they recorded, and no summary', async () => {
    await record(engB, { amount: 1000 });
    const list = await get(engA, url());
    assert.ok(list.body.data.items.length >= 1);
    for (const item of list.body.data.items) assert.equal(String(item.recordedBy), engA.user.id);
    assert.equal((await get(engA, url('/summary'))).status, 403);
  });

  it('keeps outsiders out', async () => {
    assert.equal((await get(engC, url())).status, 404); // unassigned engineer
    assert.equal((await get(cust2, url())).status, 404); // another customer
    assert.equal((await get(worker, url())).status, 403);
    assert.equal((await record(cust)).status, 403); // customers cannot record payments
  });

  it('writes audit entries that cannot be changed or deleted', async () => {
    const entry = await M.AuditLog.findOne({ action: 'customer_payment.confirm' });
    assert.ok(entry);
    assert.ok(entry.actorName);
    await assert.rejects(() => M.AuditLog.deleteMany({}), /append-only/);
    await assert.rejects(() => M.AuditLog.updateOne({ _id: entry._id }, { note: 'tampered' }), /append-only/);
  });
});

// ================= EXPENSES =================
describe('expenses', () => {
  const url = (path = '') => `/projects/${P.id}/expenses${path}`;
  const exp = (over = {}) => ({
    category: 'material', description: 'Cement bags for the slab', amount: 5000,
    expenseDate: today(), vendorName: 'ABC Traders', billNumber: `BILL-${++seq}`, ...over,
  });
  const summary = async () => (await get(admin, url('/summary'))).body.data;
  const submit = (s = engA, over) => post(s, url(), exp(over));

  it('goes through approval and then payment before it counts as spent', async () => {
    const start = await summary();
    const e = (await submit()).body.data;
    assert.equal(e.status, 'submitted');
    assert.equal((await summary()).awaitingApproval.total, start.awaitingApproval.total + 5000);

    assert.equal((await post(admin, url(`/${e._id}/pay`), { mode: 'cash', paidAt: today() })).status, 409); // not approved yet
    assert.equal((await post(engA, url(`/${e._id}/review`), { decision: 'approved' })).status, 403);
    assert.equal((await post(admin, url(`/${e._id}/review`), { decision: 'rejected' })).status, 400); // reason needed

    assert.equal((await post(admin, url(`/${e._id}/review`), { decision: 'approved' })).status, 200);
    const approved = await summary();
    assert.equal(approved.approvedUnpaid.total, start.approvedUnpaid.total + 5000);
    assert.equal(approved.spent, start.spent); // approved but unpaid is not "spent"

    assert.equal((await patch(engA, url(`/${e._id}`), { description: 'Changed after approval' })).status, 409);
    assert.equal((await post(engA, url(`/${e._id}/pay`), { mode: 'cash', paidAt: today() })).status, 403);

    assert.equal((await post(admin, url(`/${e._id}/pay`), { mode: 'cash', paidAt: today() })).status, 200);
    const paid = await summary();
    assert.equal(paid.spent, start.spent + 5000);
    assert.equal(paid.approvedUnpaid.total, start.approvedUnpaid.total);
    assert.equal((await post(admin, url(`/${e._id}/pay`), { mode: 'cash', paidAt: today() })).status, 409);
  });

  it('lets the engineer fix a rejected expense, which sends it for approval again', async () => {
    const e = (await submit()).body.data;
    await post(admin, url(`/${e._id}/review`), { decision: 'rejected', reviewNote: 'Bill photo is missing' });
    const res = await patch(engA, url(`/${e._id}`), { amount: 4500 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'submitted');
    assert.equal(res.body.data.amount, 4500);
  });

  it('keeps one engineer away from another engineer\'s expenses', async () => {
    const e = (await submit(engA)).body.data;
    assert.equal((await get(engB, url(`/${e._id}`))).status, 404);
    assert.equal((await post(engB, url(`/${e._id}/cancel`), { reason: 'Not mine to cancel' })).status, 404);
    const list = await get(engB, url());
    assert.ok(list.body.data.items.every((i) => !i.submittedBy || String(i.submittedBy._id ?? i.submittedBy) === engB.user.id));
  });

  it('blocks the same vendor bill twice, and receipts from another project folder', async () => {
    const fixed = exp({ billNumber: 'DUP-1' });
    assert.equal((await post(engA, url(), fixed)).status, 201);
    assert.equal((await post(engA, url(), fixed)).status, 409);

    const res = await submit(engA, {
      receipts: [{ publicId: 'sgc/projects/another/abc123', secureUrl: 'https://res.cloudinary.com/demo/image/authenticated/x.jpg', resourceType: 'image' }],
    });
    assert.equal(res.status, 400);
  });

  it('takes a cancelled paid expense out of the totals', async () => {
    const start = await summary();
    const e = (await submit(engA, { amount: 7000 })).body.data;
    await post(admin, url(`/${e._id}/review`), { decision: 'approved' });
    await post(admin, url(`/${e._id}/pay`), { mode: 'cash', paidAt: today() });
    assert.equal((await summary()).spent, start.spent + 7000);

    const res = await post(admin, url(`/${e._id}/cancel`), { reason: 'Supplier refunded this bill' });
    assert.equal(res.status, 200);
    assert.equal((await summary()).spent, start.spent);
  });

  it('flags a project that has spent more than its budget', async () => {
    const small = await createProject(cust.user, { name: 'Tiny budget', budget: 1000 });
    await assign(small, engA.user, admin.user);
    const e = (await post(engA, `/projects/${small.id}/expenses`, exp({ amount: 5000 }))).body.data;
    await post(admin, `/projects/${small.id}/expenses/${e._id}/review`, { decision: 'approved' });
    await post(admin, `/projects/${small.id}/expenses/${e._id}/pay`, { mode: 'cash', paidAt: today() });

    const s = (await get(admin, `/projects/${small.id}/expenses/summary`)).body.data;
    assert.equal(s.spent, 5000);
    assert.equal(s.isOverBudget, true);
    assert.equal(s.budgetRemaining, -4000);
  });

  it('hides expenses from customers, workers and unassigned engineers', async () => {
    assert.equal((await get(cust, url())).status, 403);
    assert.equal((await get(worker, url())).status, 403);
    assert.equal((await get(engC, url())).status, 404);
    assert.equal((await get(engA, url('/summary'))).status, 403);
  });
});

// ================= WAGES AND WORKER PAYMENTS =================
describe('worker wages and payments', () => {
  let W, wageId;
  const wage = (over = {}) => ({
    projectId: W.id, workerId: worker.user.id, periodStart: '2026-01-01', periodEnd: '2026-01-07',
    daysWorked: 6, dailyRate: 800, ...over,
  });
  const payBody = (over = {}) => ({
    projectId: W.id, workerId: worker.user.id, wageId, amount: 3000, mode: 'cash', paymentDate: today(), ...over,
  });
  const balance = async (s = admin, id = worker.user.id) => (await get(s, `/workers/${id}/balance`)).body.data;
  let paymentId;

  before(async () => {
    W = await createProject(cust.user, { name: 'Wage project' });
    for (const s of [engA, worker, worker2]) await assign(W, s.user, admin.user);
  });

  it('calculates the wage on the server and warns when attendance does not match', async () => {
    const res = await post(engA, '/wages', wage());
    assert.equal(res.status, 201);
    assert.equal(res.body.data.grossAmount, 4800);
    assert.equal(res.body.data.netAmount, 4800);
    assert.equal(res.body.data.status, 'submitted');
    assert.ok(res.body.warnings.length > 0); // no attendance records exist for those days
    wageId = res.body.data._id;
  });

  it('applies additions and deductions only with a note', async () => {
    const period = { periodStart: '2026-01-15', periodEnd: '2026-01-21' };
    assert.equal((await post(engA, '/wages', wage({ ...period, additions: 200, deductions: 100 }))).status, 400);
    const ok = await post(engA, '/wages', wage({ ...period, additions: 200, deductions: 100, adjustmentNote: 'Overtime less advance' }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.netAmount, 4900);
    assert.equal((await post(engA, `/wages/${ok.body.data._id}/cancel`, { reason: 'Entered for a test' })).status, 200);
  });

  it('rejects impossible wage entries', async () => {
    assert.equal((await post(engA, '/wages', wage({ periodStart: '2026-02-01', periodEnd: '2026-02-03', daysWorked: 5 }))).status, 400);
    assert.equal((await post(engA, '/wages', wage({ periodStart: '2026-01-05', periodEnd: '2026-01-10', daysWorked: 3 }))).status, 409); // overlaps
    assert.equal((await post(engA, '/wages', wage({ workerId: outsider.user.id, periodStart: '2026-03-01', periodEnd: '2026-03-07' }))).status, 400);
    assert.equal((await post(worker, '/wages', wage({ periodStart: '2026-03-01', periodEnd: '2026-03-07' }))).status, 403);
    assert.equal((await post(cust, '/wages', wage({ periodStart: '2026-03-01', periodEnd: '2026-03-07' }))).status, 403);
  });

  it('shows the worker the wage only after the admin approves it', async () => {
    assert.equal((await get(worker, '/wages')).body.data.pagination.total, 0);
    assert.equal((await get(worker, `/wages/${wageId}`)).status, 404);

    assert.equal((await post(engA, `/wages/${wageId}/review`, { decision: 'approved' })).status, 403);
    assert.equal((await post(admin, `/wages/${wageId}/review`, { decision: 'approved' })).status, 200);

    const list = await get(worker, '/wages');
    assert.equal(list.body.data.pagination.total, 1);
    for (const f of ['createdBy', 'reviewedBy', 'reviewNote']) assert.ok(!(f in list.body.data.items[0]), f);
    assert.equal((await patch(engA, `/wages/${wageId}`, { daysWorked: 5 })).status, 409); // approved: locked
  });

  it('counts a payment only after the admin confirms it', async () => {
    const res = await post(engA, '/worker-payments', payBody());
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'pending');
    paymentId = res.body.data._id;

    const b = await balance();
    assert.equal(b.earned, 4800);
    assert.equal(b.paid, 0);
    assert.equal(b.awaitingConfirmation, 3000);
    assert.equal(b.pendingBalance, 4800); // pending money does not reduce the balance
    assert.equal((await get(worker, '/worker-payments')).body.data.pagination.total, 0);

    for (const s of [worker, engA]) assert.equal((await post(s, `/worker-payments/${paymentId}/confirm`)).status, 403);
    assert.equal((await post(admin, `/worker-payments/${paymentId}/confirm`)).status, 200);

    const after = await balance();
    assert.equal(after.paid, 3000);
    assert.equal(after.pendingBalance, 1800);
  });

  it('refuses to pay more than the wage still owes, and loose payments', async () => {
    assert.equal((await post(engA, '/worker-payments', payBody({ amount: 2000 }))).status, 409); // only 1800 left
    assert.equal((await post(engA, '/worker-payments', payBody({ wageId: undefined }))).status, 400); // no wage, not an advance
    assert.equal((await post(engA, '/worker-payments', payBody({ isAdvance: true }))).status, 400); // wage and advance together
  });

  it('lets the worker confirm receipt once, and nobody else\'s', async () => {
    const mine = await get(worker, '/worker-payments');
    assert.equal(mine.body.data.pagination.total, 1);

    assert.equal((await post(worker2, `/worker-payments/${paymentId}/acknowledge`)).status, 404);
    assert.equal((await post(worker, `/worker-payments/${paymentId}/acknowledge`)).status, 200);
    assert.equal((await post(worker, `/worker-payments/${paymentId}/acknowledge`)).status, 409);
  });

  it('handles an advance separately from wages', async () => {
    const adv = await post(engA, '/worker-payments', payBody({ wageId: undefined, isAdvance: true, amount: 500 }));
    assert.equal(adv.status, 201);
    await post(admin, `/worker-payments/${adv.body.data._id}/confirm`);
    const b = await balance();
    assert.equal(b.advancesPaid, 500);
    assert.equal(b.pendingBalance, 1300);
  });

  it('does not let a wage with payments be cancelled', async () => {
    const res = await post(admin, `/wages/${wageId}/cancel`, { reason: 'Trying to cancel a paid wage' });
    assert.equal(res.status, 409);
  });

  it('keeps one worker\'s wages and balance private from another', async () => {
    assert.equal((await get(worker2, `/wages/${wageId}`)).status, 404);
    assert.equal((await get(worker2, `/workers/${worker.user.id}/balance`)).status, 404);
    assert.equal((await get(worker, `/workers/${worker.user.id}/balance`)).status, 200);
    assert.equal((await get(cust, '/worker-payments')).status, 403);
  });

  it('runs a wage dispute from the worker to the engineer\'s answer', async () => {
    const url = `/wages/${wageId}/dispute`;
    assert.equal((await post(worker, url, { reason: 'Short' })).status, 400);
    assert.equal((await post(worker, url, { reason: 'I worked 7 days, not 6' })).status, 201);
    assert.equal((await post(worker, url, { reason: 'I worked 7 days, not 6' })).status, 409);

    const resolve = (s) => post(s, `/disputes/wage/${wageId}/resolve`, { status: 'resolved', resolutionNote: 'Checked the site log' });
    assert.equal((await resolve(worker)).status, 403);
    const res = await resolve(engA);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.dispute.status, 'resolved');
  });

  it('includes confirmed worker payments in the project spend', async () => {
    const s = (await get(admin, `/projects/${W.id}/expenses/summary`)).body.data;
    assert.equal(s.workerPaid, 3500); // 3000 wage payment + 500 advance
    assert.equal(s.spent, 3500);
  });
});