import mongoose from 'mongoose';
import { APPROVAL_STATUS, APPROVAL_STATUS_LIST, WORK_CATEGORIES } from '../config/constants.js';

const { Schema } = mongoose;

const dailyReportSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // the engineer
    reportDate: { type: Date, required: true }, // the day the work was done

    workCompleted: { type: String, required: true, trim: true, maxlength: 3000 },
    workCategories: [{ type: String, enum: WORK_CATEGORIES }],

    // Overall project progress as the engineer sees it on this day
    progressPercent: { type: Number, required: true, min: 0, max: 100 },
    workersPresent: { type: Number, min: 0, default: 0 },

    // INTERNAL: never shown to customers
    delays: { type: String, trim: true, maxlength: 1500 },
    issues: { type: String, trim: true, maxlength: 1500 },
    nextDayPlan: { type: String, trim: true, maxlength: 1500 },

    // Shown to the customer only after the report is published.
    // Written or approved by the admin, so internal issues are never leaked.
    customerSummary: { type: String, trim: true, maxlength: 1500 },

    weather: { type: String, trim: true, maxlength: 60 },

    status: {
      type: String,
      enum: APPROVAL_STATUS_LIST,
      default: APPROVAL_STATUS.DRAFT,
    },
    submittedAt: Date,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 500 },
    publishedAt: Date,
  },
  { timestamps: true }
);

// One report per engineer per project per day
dailyReportSchema.index({ project: 1, author: 1, reportDate: 1 }, { unique: true });
dailyReportSchema.index({ project: 1, reportDate: -1 });
dailyReportSchema.index({ status: 1, submittedAt: -1 }); // admin approval queue
dailyReportSchema.index({ project: 1, status: 1, reportDate: -1 }); // customer timeline
dailyReportSchema.index({ author: 1, reportDate: -1 });

dailyReportSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('DailyReport', dailyReportSchema);