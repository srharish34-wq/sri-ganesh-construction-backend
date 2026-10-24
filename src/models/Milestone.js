import mongoose from 'mongoose';
import { MILESTONE_STATUS, MILESTONE_STATUS_LIST } from '../config/constants.js';

const milestoneSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 1000 },
    order: { type: Number, required: true, min: 1 }, // position in the project plan

    dueDate: { type: Date, required: true },
    completedAt: Date,

    status: {
      type: String,
      enum: MILESTONE_STATUS_LIST,
      default: MILESTONE_STATUS.PENDING,
    },
    // Share of the whole project this milestone represents (all milestones should add up to 100)
    weightPercent: { type: Number, min: 0, max: 100, default: 0 },
    progressPercent: { type: Number, min: 0, max: 100, default: 0 },

    // Visible to the customer when true
    isCustomerVisible: { type: Boolean, default: true },
    delayReason: { type: String, trim: true, maxlength: 500 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true } }
);

// True when the due date has passed and the milestone is not completed
milestoneSchema.virtual('isOverdue').get(function () {
  return this.status !== MILESTONE_STATUS.COMPLETED && this.dueDate < new Date();
});

milestoneSchema.pre('validate', function (next) {
  if (this.status === MILESTONE_STATUS.COMPLETED) {
    this.progressPercent = 100;
    if (!this.completedAt) this.completedAt = new Date();
  }
  next();
});

milestoneSchema.index({ project: 1, order: 1 }, { unique: true });
milestoneSchema.index({ project: 1, status: 1 });
milestoneSchema.index({ status: 1, dueDate: 1 }); // used by the daily overdue alert job

milestoneSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.id;
    return ret;
  },
});

export default mongoose.model('Milestone', milestoneSchema);