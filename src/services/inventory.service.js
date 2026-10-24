import InventoryItem from '../models/InventoryItem.js';
import InventoryTransaction from '../models/InventoryTransaction.js';
import { INVENTORY_TXN_TYPE as T } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';

const EPS = 0.00001;
export const round4 = (n) => Math.round(n * 10000) / 10000;

export function signedQuantityOf(type, direction, quantity) {
  if (type === T.OPENING || type === T.RECEIVED) return quantity;
  if (type === T.USED || type === T.RETURNED) return -quantity;
  return direction === 'decrease' ? -quantity : quantity;
}

/*
  One atomic database operation: add or remove stock only if the condition
  holds. Two people recording at the same moment can never push stock below zero.
*/
const changeBalance = (condition, delta) =>
  InventoryItem.findOneAndUpdate(
    condition,
    [
      {
        $set: {
          currentBalance: { $round: [{ $add: ['$currentBalance', delta] }, 4] },
          lastTransactionAt: new Date(),
        },
      },
    ],
    { new: true }
  );

export async function addTransaction({ item, user, data }) {
  const signed = signedQuantityOf(data.type, data.direction, data.quantity);

  const condition = { _id: item._id, isActive: true };
  if (signed < 0 && !item.allowNegativeStock) condition.currentBalance = { $gte: -signed - EPS };

  const updated = await changeBalance(condition, signed);
  if (!updated) {
    const fresh = await InventoryItem.findById(item._id);
    if (!fresh || !fresh.isActive) throw new ApiError(409, 'This material is inactive');
    const message = `Not enough stock. Only ${fresh.currentBalance} ${fresh.unit} available.`;
    throw new ApiError(409, message, [{ field: 'quantity', message }]);
  }

  try {
    const transaction = await InventoryTransaction.create({
      ...data,
      project: item.project,
      item: item._id,
      recordedBy: user._id,
      balanceAfter: updated.currentBalance,
    });
    return { transaction, item: updated };
  } catch (err) {
    await changeBalance({ _id: item._id }, -signed); // undo the stock change
    throw err;
  }
}

// Voiding reverses the stock effect. The entry stays in the history.
export async function voidTransaction(txn, user, reason) {
  const claimed = await InventoryTransaction.findOneAndUpdate(
    { _id: txn._id, status: 'valid' },
    { status: 'voided', voidedAt: new Date(), voidedBy: user._id, voidReason: reason },
    { new: true }
  );
  if (!claimed) throw new ApiError(409, 'This entry is already voided');

  const item = await InventoryItem.findById(txn.item);
  const delta = -txn.signedQuantity;
  const condition = { _id: item._id };
  if (delta < 0 && !item.allowNegativeStock) condition.currentBalance = { $gte: -delta - EPS };

  const updated = await changeBalance(condition, delta);
  if (!updated) {
    await InventoryTransaction.updateOne(
      { _id: txn._id },
      { status: 'valid', $unset: { voidedAt: 1, voidedBy: 1, voidReason: 1 } }
    );
    throw new ApiError(
      409,
      'This entry cannot be voided because the stock has already been used. Record an adjustment instead.'
    );
  }
  return { transaction: claimed, item: updated };
}

// The real balance is the sum of valid transactions. Used to check the cached value.
export async function calculateBalance(itemId) {
  const [row] = await InventoryTransaction.aggregate([
    { $match: { item: itemId, status: 'valid' } },
    { $group: { _id: null, total: { $sum: '$signedQuantity' } } },
  ]);
  return round4(row?.total ?? 0);
}