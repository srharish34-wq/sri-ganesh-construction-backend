import mongoose from 'mongoose';
import CustomerPayment from '../models/CustomerPayment.js';
import { PAYMENT_STATUS } from '../config/constants.js';
import { currentYearIST } from '../utils/idGenerator.js';

export const round2 = (n) => Math.round(n * 100) / 100;

// Totals per status for one project. Only 'confirmed' counts as received.
export async function customerPaymentTotals(projectId) {
  const rows = await CustomerPayment.aggregate([
    { $match: { project: new mongoose.Types.ObjectId(String(projectId)) } },
    { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const get = (status) => {
    const row = rows.find((r) => r._id === status);
    return { total: round2(row?.total ?? 0), count: row?.count ?? 0 };
  };
  return {
    confirmed: get(PAYMENT_STATUS.CONFIRMED),
    pending: get(PAYMENT_STATUS.PENDING),
  };
}

// Next receipt number like RCPT-2026-00012. The unique index catches a clash,
// and the controller retries.
export async function nextReceiptNumber() {
  const prefix = `RCPT-${currentYearIST()}-`;
  const last = await CustomerPayment.findOne({ receiptNumber: { $regex: `^${prefix}` } })
    .sort({ receiptNumber: -1 })
    .select('receiptNumber')
    .lean();
  const lastNumber = last ? parseInt(last.receiptNumber.slice(prefix.length), 10) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(5, '0')}`;
}