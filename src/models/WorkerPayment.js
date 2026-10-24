import mongoose from 'mongoose';
import {
  PAYMENT_STATUS,
  PAYMENT_STATUS_LIST,
  PAYMENT_MODE_LIST,
} from '../config/constants.js';

const { Schema } = mongoose;

/*
  Money paid to a worker.
    - The engineer RECORDS the payment  -> status 'pending'
    - An authorised person CONFIRMS it  -> status 'confirmed' (now it counts)
  The worker can see it and acknowledge it, but cannot edit or delete it.
*/
const workerPaymentSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    worker: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    wage: { type: Schema.Types.ObjectId, ref: 'WorkerWage' }, // optional: advances have none

    amount: {
      type: Number,
      required: true,
      min: 0.01,
      set: (v) => Math.round(v * 100) / 100,
    },
    isAdvance: { type: Boolean, default: false },
    mode: { type: String, enum: PAYMENT_MODE_LIST, required: true },
    paymentDate: { type: Date, required: true },
    reference: { type: String, trim: true, maxlength: 80 },
    notes: { type: String, trim: true, maxlength: 300 },

    status: { type: String, enum: PAYMENT_STATUS_LIST, default: PAYMENT_STATUS.PENDING },

    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: Date,
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
    cancelReason: { type: String, trim: true, maxlength: 300 },

    // The worker confirms they actually received the money
    workerAcknowledgedAt: Date,

    dispute: {
      status: { type: String, enum: ['open', 'resolved', 'rejected'] },
      reason: { type: String, trim: true, maxlength: 500 },
      raisedAt: Date,
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      resolvedAt: Date,
      resolutionNote: { type: String, trim: true, maxlength: 500 },
    },
  },
  { timestamps: true }
);

workerPaymentSchema.pre('validate', function (next) {
  if (this.status === PAYMENT_STATUS.CONFIRMED) {
    if (!this.confirmedBy) this.invalidate('confirmedBy', 'confirmedBy is required');
    if (!this.confirmedAt) this.confirmedAt = new Date();
  }
  if (this.status === PAYMENT_STATUS.REJECTED && !this.rejectionReason) {
    this.invalidate('rejectionReason', 'A reason is required to reject a payment');
  }
  if (this.status === PAYMENT_STATUS.CANCELLED && !this.cancelReason) {
    this.invalidate('cancelReason', 'A reason is required to cancel a payment');
  }
  next();
});

// Once confirmed, the money fields are locked
workerPaymentSchema.pre('save', function (next) {
  if (!this.isNew && this.$__.priorStatus === PAYMENT_STATUS.CONFIRMED) {
    const changed = ['project', 'worker', 'wage', 'amount', 'mode', 'paymentDate', 'reference'].filter(
      (f) => this.isModified(f)
    );
    if (changed.length) {
      return next(new Error(`Confirmed payments cannot be edited (${changed.join(', ')}).`));
    }
  }
  next();
});
workerPaymentSchema.post('init', function () {
  this.$__.priorStatus = this.status;
});

workerPaymentSchema.index({ worker: 1, status: 1, paymentDate: -1 });
workerPaymentSchema.index({ project: 1, status: 1, paymentDate: -1 });
workerPaymentSchema.index({ status: 1, createdAt: -1 }); // admin pending queue
workerPaymentSchema.index({ wage: 1, status: 1 });
workerPaymentSchema.index({ 'dispute.status': 1 });

workerPaymentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('WorkerPayment', workerPaymentSchema);