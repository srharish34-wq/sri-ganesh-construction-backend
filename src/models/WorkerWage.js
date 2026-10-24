import mongoose from 'mongoose';
import { APPROVAL_STATUS, APPROVAL_STATUS_LIST } from '../config/constants.js';

const { Schema } = mongoose;

const money = { type: Number, min: 0, set: (v) => Math.round(v * 100) / 100 };

/*
  What a worker has EARNED for a period (for example one week).
  What was PAID is stored separately in WorkerPayment.
    Pending balance = sum of approved wages - sum of confirmed payments.
*/
const workerWageSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    worker: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    daysWorked: { type: Number, required: true, min: 0, max: 366 },
    dailyRate: { ...money, required: true },

    grossAmount: { ...money, required: true }, // normally daysWorked x dailyRate
    additions: { ...money, default: 0 }, // overtime, bonus
    deductions: { ...money, default: 0 }, // advance recovered, penalty
    netAmount: { type: Number, min: 0 }, // set automatically
    adjustmentNote: { type: String, trim: true, maxlength: 300 },

    status: { type: String, enum: APPROVAL_STATUS_LIST, default: APPROVAL_STATUS.SUBMITTED },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // the engineer
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 500 },

    // Worker can question a wage record
    dispute: {
      status: { type: String, enum: ['open', 'resolved', 'rejected'] },
      reason: { type: String, trim: true, maxlength: 500 },
      raisedAt: Date,
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      resolvedAt: Date,
      resolutionNote: { type: String, trim: true, maxlength: 500 },
    },

    isCancelled: { type: Boolean, default: false },
    cancelReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

workerWageSchema.pre('validate', function (next) {
  if (this.periodStart && this.periodEnd && this.periodEnd < this.periodStart) {
    this.invalidate('periodEnd', 'Period end cannot be before period start');
  }
  const net = (this.grossAmount || 0) + (this.additions || 0) - (this.deductions || 0);
  if (net < 0) this.invalidate('deductions', 'Deductions cannot be more than the earned amount');
  this.netAmount = Math.round(net * 100) / 100;

  if (this.status === APPROVAL_STATUS.REJECTED && !this.reviewNote) {
    this.invalidate('reviewNote', 'A reason is required to reject a wage record');
  }
  if (this.isCancelled && !this.cancelReason) {
    this.invalidate('cancelReason', 'A reason is required to cancel a wage record');
  }
  next();
});

// After approval the amounts are locked
workerWageSchema.pre('save', function (next) {
  if (!this.isNew && this.$__.priorStatus === APPROVAL_STATUS.APPROVED) {
    const locked = ['worker', 'project', 'periodStart', 'periodEnd', 'grossAmount', 'additions', 'deductions', 'daysWorked', 'dailyRate'];
    const changed = locked.filter((f) => this.isModified(f));
    if (changed.length) {
      return next(new Error(`Approved wage records cannot be edited (${changed.join(', ')}).`));
    }
  }
  next();
});
workerWageSchema.post('init', function () {
  this.$__.priorStatus = this.status;
});

// One wage record per worker, project and period
workerWageSchema.index(
  { project: 1, worker: 1, periodStart: 1, periodEnd: 1 },
  { unique: true, partialFilterExpression: { isCancelled: false } }
);
workerWageSchema.index({ worker: 1, status: 1, periodEnd: -1 });
workerWageSchema.index({ project: 1, status: 1, periodEnd: -1 });
workerWageSchema.index({ status: 1, createdAt: -1 }); // admin queue
workerWageSchema.index({ 'dispute.status': 1 });

workerWageSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('WorkerWage', workerWageSchema);