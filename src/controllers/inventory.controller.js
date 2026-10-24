import InventoryItem from '../models/InventoryItem.js';
import InventoryTransaction from '../models/InventoryTransaction.js';
import * as inventory from '../services/inventory.service.js';
import { logAudit } from '../services/audit.service.js';
import { notifyAdmins, notifyProjectEngineers } from '../services/notification.service.js';
import { ROLES, INVENTORY_TXN_TYPE as T, NOTIFICATION_TYPE } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage, escapeRegex } from '../utils/pagination.js';
import { dayStart, dayEnd, dateFromKeyOrNow, todayKeyIST } from '../utils/dates.js';

const isAdmin = (user) => user.role === ROLES.SUPER_ADMIN;
const ENGINEER_VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

const lowStockExpr = {
  $and: [{ $gt: ['$minStockThreshold', 0] }, { $lte: ['$currentBalance', '$minStockThreshold'] }],
};

// Inventory is for the admin and the engineers of the project only
function staffOnly(req) {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.ENGINEER) {
    throw new ApiError(403, 'You do not have permission to do this');
  }
}

async function findItem(project, itemId) {
  const item = await InventoryItem.findOne({ _id: itemId, project: project._id });
  if (!item) throw new ApiError(404, 'Material not found');
  return item;
}

function assertWritable(project) {
  if (project.isArchived) throw new ApiError(409, 'This project is archived. Restore it first.');
}

async function alertIfLow(req, item) {
  if (!(item.minStockThreshold > 0 && item.currentBalance <= item.minStockThreshold)) return;
  const payload = {
    type: NOTIFICATION_TYPE.LOW_STOCK,
    title: 'Low stock',
    message: `${item.name} is low at ${req.project.name}: ${item.currentBalance} ${item.unit} left (minimum ${item.minStockThreshold}).`,
    project: req.project._id,
    entity: { kind: 'inventory_item', id: item._id },
    dedupeKey: `low_stock:${item._id}:${todayKeyIST()}`, // one alert per item per day
  };
  await notifyProjectEngineers(req.project._id, payload);
  await notifyAdmins(payload);
}

// POST /projects/:projectId/inventory/items
export const createItem = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const { openingQuantity, ...fields } = req.body;
  if (fields.allowNegativeStock && !isAdmin(req.user)) {
    throw new ApiError(403, 'Only the admin can allow negative stock');
  }

  const item = await InventoryItem.create({ ...fields, project: req.project._id, createdBy: req.user._id });

  if (openingQuantity) {
    try {
      await inventory.addTransaction({
        item, user: req.user,
        data: { type: T.OPENING, quantity: openingQuantity, transactionDate: new Date(), notes: 'Opening stock' },
      });
    } catch (err) {
      await InventoryItem.deleteOne({ _id: item._id }); // do not leave an item without its opening stock
      throw err;
    }
  }

  const fresh = await InventoryItem.findById(item._id);
  await logAudit(req, { action: 'inventory.item_create', entityType: 'InventoryItem', entityId: item._id, project: req.project._id, after: fresh });
  res.status(201).json({ success: true, data: fresh });
});

// GET /projects/:projectId/inventory/items
export const listItems = asyncHandler(async (req, res) => {
  staffOnly(req);
  const q = req.validated.query;
  const paging = getPagination(q);
  const filter = { project: req.project._id, isActive: q.isActive ?? true };

  if (q.category) filter.category = q.category;
  if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
  if (q.lowStock) filter.$expr = lowStockExpr;

  const [items, total, lowStockCount] = await Promise.all([
    InventoryItem.find(filter).sort({ name: 1, _id: 1 }).skip(paging.skip).limit(paging.limit),
    InventoryItem.countDocuments(filter),
    InventoryItem.countDocuments({ project: req.project._id, isActive: true, $expr: lowStockExpr }),
  ]);
  res.json({ success: true, data: { ...buildPage(items, total, paging), lowStockCount } });
});

// GET /projects/:projectId/inventory/items/:itemId
export const getItem = asyncHandler(async (req, res) => {
  staffOnly(req);
  const item = await findItem(req.project, req.params.itemId);
  const recent = await InventoryTransaction.find({ item: item._id, status: 'valid' })
    .sort({ transactionDate: -1, _id: -1 })
    .limit(10)
    .populate('recordedBy', 'name');
  res.json({ success: true, data: { item, recentTransactions: recent } });
});

// PATCH /projects/:projectId/inventory/items/:itemId
export const updateItem = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const item = await findItem(req.project, req.params.itemId);
  if (req.body.allowNegativeStock !== undefined && !isAdmin(req.user)) {
    throw new ApiError(403, 'Only the admin can change the negative stock setting');
  }

  const before = item.toJSON();
  for (const [key, value] of Object.entries(req.body)) if (value !== undefined) item.set(key, value);
  if (!item.isModified()) return res.json({ success: true, data: item });
  await item.save();

  await logAudit(req, {
    action: 'inventory.item_update', entityType: 'InventoryItem', entityId: item._id,
    project: req.project._id, before, after: item,
  });
  res.json({ success: true, data: item });
});

// POST /projects/:projectId/inventory/transactions
export const createTransaction = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const { itemId, transactionDate, supplierName, ...rest } = req.body;
  const item = await findItem(req.project, itemId);

  const { transaction, item: updated } = await inventory.addTransaction({
    item,
    user: req.user,
    data: {
      ...rest,
      transactionDate: dateFromKeyOrNow(transactionDate),
      supplierName: supplierName ?? item.supplier?.name,
    },
  });

  await logAudit(req, {
    action: `inventory.${transaction.type}`, entityType: 'InventoryTransaction', entityId: transaction._id,
    project: req.project._id, after: transaction, note: `${item.name}: ${transaction.signedQuantity} ${item.unit}`,
  });
  if (transaction.signedQuantity < 0) await alertIfLow(req, updated);

  res.status(201).json({ success: true, data: { transaction, item: updated } });
});

// GET /projects/:projectId/inventory/transactions
export const listTransactions = asyncHandler(async (req, res) => {
  staffOnly(req);
  const q = req.validated.query;
  const paging = getPagination(q);
  const filter = { project: req.project._id };

  if (!q.includeVoided) filter.status = 'valid';
  if (q.itemId) filter.item = q.itemId;
  if (q.type) filter.type = q.type;
  if (q.from || q.to) {
    filter.transactionDate = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };
  }

  const [items, total] = await Promise.all([
    InventoryTransaction.find(filter)
      .sort({ transactionDate: -1, _id: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .populate('item', 'name unit category')
      .populate('recordedBy', 'name'),
    InventoryTransaction.countDocuments(filter),
  ]);
  res.json({ success: true, data: buildPage(items, total, paging) });
});

/*
  POST /projects/:projectId/inventory/transactions/:transactionId/void
  Admin can void any entry. An engineer can void only their own entry within 24 hours.
*/
export const voidTransaction = asyncHandler(async (req, res) => {
  staffOnly(req);
  assertWritable(req.project);
  const txn = await InventoryTransaction.findOne({ _id: req.params.transactionId, project: req.project._id });
  if (!txn) throw new ApiError(404, 'Entry not found');
  if (txn.status === 'voided') throw new ApiError(409, 'This entry is already voided');
  if (txn.type === T.OPENING && !isAdmin(req.user)) throw new ApiError(403, 'Only the admin can void opening stock');

  if (!isAdmin(req.user)) {
    if (!txn.recordedBy.equals(req.user._id)) throw new ApiError(403, 'You can void only your own entries');
    if (Date.now() - txn.createdAt.getTime() > ENGINEER_VOID_WINDOW_MS) {
      throw new ApiError(403, 'Entries older than 24 hours can be voided only by the admin');
    }
  }

  const { transaction, item } = await inventory.voidTransaction(txn, req.user, req.body.reason);
  await logAudit(req, {
    action: 'inventory.void', entityType: 'InventoryTransaction', entityId: txn._id,
    project: req.project._id, note: req.body.reason,
  });
  res.json({ success: true, data: { transaction, item } });
});

// POST /projects/:projectId/inventory/items/:itemId/recalculate   (admin only)
export const recalculateItem = asyncHandler(async (req, res) => {
  if (!isAdmin(req.user)) throw new ApiError(403, 'You do not have permission to do this');
  const item = await findItem(req.project, req.params.itemId);

  const previous = item.currentBalance;
  const calculated = await inventory.calculateBalance(item._id);
  const corrected = Math.abs(previous - calculated) > 0.00001;

  if (corrected) {
    await InventoryItem.updateOne({ _id: item._id }, { currentBalance: calculated });
    await logAudit(req, {
      action: 'inventory.recalculate', entityType: 'InventoryItem', entityId: item._id,
      project: req.project._id, before: { currentBalance: previous }, after: { currentBalance: calculated },
    });
  }
  res.json({ success: true, data: { previous, calculated, corrected } });
});