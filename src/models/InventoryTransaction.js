import mongoose from 'mongoose';
import { INVENTORY_TXN_TYPE, INVENTORY_TXN_TYPE_LIST } from '../config/constants.js';

const { Schema } = mongoose;

/*
  Meaning of each type:
    opening    adds stock (starting quantity)
    received   adds stock (delivered to site)
    used       reduces stock (consumed in work)
    returned   reduces stock (sent back to the supplier)
    adjustment adds or reduces stock (needs `direction` and a reason)

  Transactions are never edited or deleted. A mistake is fixed by voiding the
  entry (with a reason) and recording a new one, so history stays complete.
*/

const IMMUTABLE_FIELDS = [
  'project', 'item', 'type', 'direction', 'quantity', 'signedQuantity',
  'transactionDate', 'recordedBy', 'unitCost',
];

const inventoryTransactionSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    item: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },

    type: { type: String, enum: INVENTORY_TXN_TYPE_LIST, required: true },
    direction: { type: String, enum: ['increase', 'decrease'] }, // adjustments only
    quantity: { type: Number, required: true, min: 0.0001 }, // always positive
    // Set automatically: positive adds stock, negative reduces it
    signedQuantity: { type: Number },

    transactionDate: { type: Date, required: true, default: Date.now },
    reference: { type: String, trim: true, maxlength: 80 }, // challan, bill or invoice number
    supplierName: { type: String, trim: true, maxlength: 120 },
    unitCost: { type: Number, min: 0 }, // rupees per unit, optional
    notes: { type: String, trim: true, maxlength: 500 },
    reason: { type: String, trim: true, maxlength: 300 }, // required for adjustments

    balanceAfter: Number, // stock after this entry, set by the service

    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Void instead of delete
    status: { type: String, enum: ['valid', 'voided'], default: 'valid' },
    voidedAt: Date,
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    voidReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

inventoryTransactionSchema.pre('validate', function (next) {
  const { OPENING, RECEIVED, USED, RETURNED, ADJUSTMENT } = INVENTORY_TXN_TYPE;

  if (this.type === ADJUSTMENT) {
    if (!this.direction) this.invalidate('direction', 'Adjustments need increase or decrease');
    if (!this.reason) this.invalidate('reason', 'A reason is required for adjustments');
  } else {
    this.direction = undefined;
  }

  if (this.type === OPENING || this.type === RECEIVED) this.signedQuantity = this.quantity;
  else if (this.type === USED || this.type === RETURNED) this.signedQuantity = -this.quantity;
  else if (this.type === ADJUSTMENT) {
    this.signedQuantity = this.direction === 'decrease' ? -this.quantity : this.quantity;
  }

  if (this.status === 'voided' && !this.voidReason) {
    this.invalidate('voidReason', 'A reason is required to void a transaction');
  }
  next();
});

// Block edits to the core fields of an existing entry
inventoryTransactionSchema.pre('save', function (next) {
  if (!this.isNew) {
    const changed = IMMUTABLE_FIELDS.filter((f) => this.isModified(f));
    if (changed.length) {
      return next(new Error(`Inventory transactions cannot be edited (${changed.join(', ')}). Void it and add a new one.`));
    }
  }
  next();
});

inventoryTransactionSchema.index({ item: 1, status: 1, transactionDate: -1 });
inventoryTransactionSchema.index({ project: 1, transactionDate: -1 });
inventoryTransactionSchema.index({ project: 1, type: 1, transactionDate: -1 });
inventoryTransactionSchema.index({ recordedBy: 1, createdAt: -1 });

inventoryTransactionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('InventoryTransaction', inventoryTransactionSchema);