import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, get, post, patch,
  createSession, createProject, assign,
} from './setup.js';

let M, admin, engA, engB, engC, worker, customer, project;
const base = () => `/projects/${project.id}/inventory`;
let n = 0;

before(async () => {
  M = await startTestServer();
  [admin, engA, engB, engC, worker, customer] = await Promise.all(
    ['super_admin', 'engineer', 'engineer', 'engineer', 'worker', 'customer'].map((r) => createSession(r))
  );
  project = await createProject(customer.user);
  for (const s of [engA, engB, worker]) await assign(project, s.user, admin.user);
});
after(() => stopTestServer());

// Creates a material as engineer A with an opening balance, and returns it
async function newItem(over = {}) {
  n += 1;
  const res = await post(engA, `${base()}/items`, {
    name: `Material ${n}`, category: 'cement', unit: 'bag', openingQuantity: 100, ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}
const tx = (s, itemId, type, quantity, extra = {}) =>
  post(s, `${base()}/transactions`, { itemId, type, quantity, ...extra });
const balanceOf = async (itemId) => (await get(engA, `${base()}/items/${itemId}`)).body.data.item.currentBalance;

describe('materials', () => {
  it('creates a material with an opening stock entry', async () => {
    const item = await newItem();
    assert.equal(item.currentBalance, 100);
    assert.equal(await M.InventoryTransaction.countDocuments({ item: item._id, type: 'opening' }), 1);
  });

  it('blocks duplicate names, ignoring upper and lower case', async () => {
    await newItem({ name: 'Cement OPC' });
    const res = await post(engA, `${base()}/items`, { name: 'cement opc', category: 'cement', unit: 'bag' });
    assert.equal(res.status, 409);
  });

  it('lets only the admin allow negative stock', async () => {
    const denied = await post(engA, `${base()}/items`, { name: 'Neg A', category: 'sand_aggregate', unit: 'load', allowNegativeStock: true });
    assert.equal(denied.status, 403);

    const ok = await post(admin, `${base()}/items`, { name: 'Neg B', category: 'sand_aggregate', unit: 'load', allowNegativeStock: true });
    assert.equal(ok.status, 201);
    const used = await tx(admin, ok.body.data._id, 'used', 5);
    assert.equal(used.status, 201);
    assert.equal(used.body.data.item.currentBalance, -5);
  });
});

describe('stock movements', () => {
  it('adds and removes stock and records the balance after each entry', async () => {
    const item = await newItem();
    const received = await tx(engA, item._id, 'received', 50, { reference: 'CH-1001' });
    assert.equal(received.status, 201);
    assert.equal(received.body.data.item.currentBalance, 150);
    assert.equal(received.body.data.transaction.balanceAfter, 150);

    assert.equal((await tx(engA, item._id, 'used', 30)).body.data.item.currentBalance, 120);
    assert.equal((await tx(engA, item._id, 'returned', 20)).body.data.item.currentBalance, 100);
    assert.equal(await balanceOf(item._id), 100);
  });

  it('refuses to use more than is in stock and leaves the balance alone', async () => {
    const item = await newItem();
    const res = await tx(engA, item._id, 'used', 1000);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Not enough stock/);
    assert.equal(await balanceOf(item._id), 100);
  });

  it('cannot go below zero even when two people record at the same moment', async () => {
    const item = await newItem();
    const results = await Promise.all([tx(engA, item._id, 'used', 80), tx(engB, item._id, 'used', 80)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await balanceOf(item._id), 20);
  });

  it('checks adjustments and quantities', async () => {
    const item = await newItem();
    assert.equal((await tx(engA, item._id, 'adjustment', 5, { reason: 'Stock count correction' })).status, 400); // no direction
    assert.equal((await tx(engA, item._id, 'adjustment', 5, { direction: 'increase' })).status, 400); // no reason
    const ok = await tx(engA, item._id, 'adjustment', 5, { direction: 'increase', reason: 'Stock count correction' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.item.currentBalance, 105);

    assert.equal((await tx(engA, item._id, 'received', 0)).status, 400);
    assert.equal((await tx(engA, item._id, 'received', 1.23456)).status, 400);
    assert.equal((await tx(engA, item._id, 'received', 5, { direction: 'increase' })).status, 400);
    assert.equal((await tx(engA, item._id, 'opening', 5)).status, 400); // opening only comes with the item
  });

  it('never edits a recorded entry', async () => {
    const item = await newItem();
    const t = (await tx(engA, item._id, 'received', 10)).body.data.transaction;
    const doc = await M.InventoryTransaction.findById(t._id);
    doc.quantity = 1;
    await assert.rejects(() => doc.save(), /cannot be edited/);
  });
});

describe('voiding', () => {
  it('reverses the stock, keeps the entry, and refuses a second void', async () => {
    const item = await newItem();
    const t = (await tx(engA, item._id, 'received', 50)).body.data.transaction;
    const url = `${base()}/transactions/${t._id}/void`;

    assert.equal((await post(engA, url, {})).status, 400); // reason required
    const res = await post(engA, url, { reason: 'Entered by mistake' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.transaction.status, 'voided');
    assert.equal(res.body.data.item.currentBalance, 100);
    assert.equal((await post(engA, url, { reason: 'Again' })).status, 409);
  });

  it('refuses a void that would make stock negative, and keeps the entry valid', async () => {
    const item = await newItem({ openingQuantity: 10 });
    const received = (await tx(engA, item._id, 'received', 50)).body.data.transaction;
    await tx(engA, item._id, 'used', 55);

    const res = await post(engA, `${base()}/transactions/${received._id}/void`, { reason: 'Wrong supplier entry' });
    assert.equal(res.status, 409);
    assert.equal((await M.InventoryTransaction.findById(received._id)).status, 'valid');
    assert.equal(await balanceOf(item._id), 5);
  });

  it('restricts who may void: own entries, within 24 hours, opening stock only by the admin', async () => {
    const item = await newItem();
    const mine = (await tx(engA, item._id, 'received', 5)).body.data.transaction;

    assert.equal((await post(engB, `${base()}/transactions/${mine._id}/void`, { reason: 'Not my entry' })).status, 403);

    await M.InventoryTransaction.collection.updateOne(
      { _id: new (await import('mongoose')).default.Types.ObjectId(mine._id) },
      { $set: { createdAt: new Date(Date.now() - 48 * 3600e3) } }
    );
    assert.equal((await post(engA, `${base()}/transactions/${mine._id}/void`, { reason: 'Too late to void' })).status, 403);
    assert.equal((await post(admin, `${base()}/transactions/${mine._id}/void`, { reason: 'Admin correction' })).status, 200);

    const opening = await M.InventoryTransaction.findOne({ item: item._id, type: 'opening' });
    assert.equal((await post(engA, `${base()}/transactions/${opening.id}/void`, { reason: 'Opening was wrong' })).status, 403);
  });
});

describe('the cached balance can be checked against the entries', () => {
  it('recalculates from valid entries, admin only', async () => {
    const item = await newItem();
    await tx(engA, item._id, 'received', 25);
    await M.InventoryItem.updateOne({ _id: item._id }, { currentBalance: 999 }); // simulate a bad cached value

    const url = `${base()}/items/${item._id}/recalculate`;
    assert.equal((await post(engA, url)).status, 403);

    const fixed = await post(admin, url);
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.data.calculated, 125);
    assert.equal(fixed.body.data.corrected, true);
    assert.equal(await balanceOf(item._id), 125);
    assert.equal((await post(admin, url)).body.data.corrected, false);
  });
});

describe('low stock alerts', () => {
  it('notifies the admin and lists the item under lowStock', async () => {
    const item = await newItem({ openingQuantity: 25, minStockThreshold: 20 });
    assert.equal((await tx(engA, item._id, 'used', 10)).status, 201); // 15 left, below 20

    const alert = await M.Notification.findOne({ user: admin.user._id, type: 'low_stock', 'entity.id': item._id });
    assert.ok(alert);

    const list = await get(engA, `${base()}/items`, { lowStock: 'true' });
    assert.ok(list.body.data.items.some((i) => i._id === item._id));
    assert.ok(list.body.data.lowStockCount >= 1);
  });
});

describe('who can use inventory', () => {
  it('keeps it to the admin and the project\'s engineers', async () => {
    assert.equal((await get(worker, `${base()}/items`)).status, 403);
    assert.equal((await get(customer, `${base()}/items`)).status, 403);
    assert.equal((await get(engC, `${base()}/items`)).status, 404); // engineer not on this project
    assert.equal((await get(undefined, `${base()}/items`)).status, 401);
  });

  it('makes an archived project read-only for the admin and invisible to the engineer', async () => {
    const archived = await createProject(customer.user, { name: 'Archived site' });
    await assign(archived, engA.user, admin.user);
    const item = (await post(engA, `/projects/${archived.id}/inventory/items`, { name: 'Bricks', category: 'bricks_blocks', unit: 'piece', openingQuantity: 500 })).body.data;
    await post(admin, `/projects/${archived.id}/archive`, {});

    assert.equal((await get(engA, `/projects/${archived.id}/inventory/items`)).status, 404);
    const write = await post(admin, `/projects/${archived.id}/inventory/transactions`, { itemId: item._id, type: 'used', quantity: 1 });
    assert.equal(write.status, 409);
  });
});