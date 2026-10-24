import mongoose from 'mongoose';
import {
  APPROVAL_STATUS,
  APPROVAL_STATUS_LIST,
  EXPENSE_CATEGORIES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_LIST,
  PAYMENT_MODE_LIST,
} from '../config/constants.js';

const { Schema } = mongoose;

const money = { type: Number, min: 0, set: (v) => Math.round(v * 100) / 100 };

const receiptSchema = new Schema(
  {
    publicId: { type: String, required: true },
    secureUrl: { type: String, required: true },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'image' },
  },
  { _id: false }
);

/*
  Two separate stages:
    1. Approval  (status):        submitted -> approved or rejected
    2. Payment   (payment.status): pending -> confirmed
  Only expenses that are approved AND paid-confirmed count as "money spent".
  Approved but unpaid ones count as "pending payments".
*/
const expenseSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amount: { ...money, required: true, min: 0.01 },
    expenseDate: { type: Date, required: true },

    vendorName: { type: String, trim: true, maxlength: 120 },
    billNumber: { type: String, trim: true, maxlength: 60 },
    receipts: {
      type: [receiptSchema],
      validate: [(v) => v.length <= 5, 'A maximum of 5 receipts is allowed'],
    },

    // Approval workflow
    status: { type: String, enum: APPROVAL_STATUS_LIST, default: APPROVAL_STATUS.SUBMITTED },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 500 },

    // Payment confirmation (only after approval)
    payment: {
      status: { type: String, enum: PAYMENT_STATUS_LIST, default: PAYMENT_STATUS.PENDING },
      mode: { type: String, enum: PAYMENT_MODE_LIST },
      reference: { type: String, trim: true, maxlength: 80 },
      paidAt: Date,
      confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    isCancelled: { type: Boolean, default: false },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

expenseSchema.pre('validate', function (next) {
  if (this.status === APPROVAL_STATUS.REJECTED && !this.reviewNote) {
    this.invalidate('reviewNote', 'A reason is required to reject an expense');
  }
  if (
    this.payment?.status === PAYMENT_STATUS.CONFIRMED &&
    this.status !== APPROVAL_STATUS.APPROVED
  ) {
    this.invalidate('payment.status', 'Only an approved expense can be marked as paid');
  }
  if (this.isCancelled && !this.cancelReason) {
    this.invalidate('cancelReason', 'A reason is required to cancel an expense');
  }
  next();
});

// After approval the amount is locked
expenseSchema.pre('save', function (next) {
  if (!this.isNew && this.$__.priorStatus === APPROVAL_STATUS.APPROVED) {
    const changed = ['amount', 'project', 'category', 'expenseDate'].filter((f) => this.isModified(f));
    if (changed.length) {
      return next(new Error(`Approved expenses cannot be edited (${changed.join(', ')}).`));
    }
  }
  next();
});
expenseSchema.post('init', function () {
  this.$__.priorStatus = this.status;
});

expenseSchema.index({ project: 1, status: 1, expenseDate: -1 });
expenseSchema.index({ project: 1, category: 1, expenseDate: -1 });
expenseSchema.index({ status: 1, createdAt: -1 }); // admin approval queue
expenseSchema.index({ submittedBy: 1, createdAt: -1 });
expenseSchema.index({ project: 1, status: 1, 'payment.status': 1 });

expenseSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('Expense', expenseSchema);