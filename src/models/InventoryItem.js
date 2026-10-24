import mongoose from 'mongoose';
import { MATERIAL_CATEGORIES, UNITS } from '../config/constants.js';

const { Schema } = mongoose;

const inventoryItemSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Lowercase copy of the name, used to block duplicates like "Cement" and "cement"
    nameKey: { type: String, required: true, lowercase: true, trim: true },
    category: { type: String, enum: MATERIAL_CATEGORIES, required: true },
    unit: { type: String, enum: UNITS, required: true },

    supplier: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 20 },
    },

    minStockThreshold: { type: Number, min: 0, default: 0 },
    allowNegativeStock: { type: Boolean, default: false },

    // CACHED value. The true balance is the sum of valid InventoryTransactions.
    // Only the inventory service updates this, inside the same operation as the
    // transaction, and it can be recalculated at any time.
    currentBalance: { type: Number, default: 0 },
    lastTransactionAt: Date,

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, toJSON: { virtuals: true } }
);

inventoryItemSchema.pre('validate', function (next) {
  if (this.name) this.nameKey = this.name.trim().toLowerCase();
  next();
});

inventoryItemSchema.virtual('isLowStock').get(function () {
  return this.minStockThreshold > 0 && this.currentBalance <= this.minStockThreshold;
});

inventoryItemSchema.index({ project: 1, nameKey: 1 }, { unique: true });
inventoryItemSchema.index({ project: 1, isActive: 1, category: 1 });

inventoryItemSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.id;
    delete ret.nameKey;
    return ret;
  },
});

export default mongoose.model('InventoryItem', inventoryItemSchema);