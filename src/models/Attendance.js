import mongoose from 'mongoose';
import {
  ROLES,
  ATTENDANCE_STATUS,
  ATTENDANCE_STATUS_LIST,
  ATTENDANCE_SOURCE,
  ATTENDANCE_SOURCE_LIST,
} from '../config/constants.js';

const { Schema } = mongoose;

// One GPS reading (check-in or check-out)
const punchSchema = new Schema(
  {
    time: { type: Date, required: true },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    distanceFromSiteMeters: { type: Number, min: 0 },
    // null = could not be checked (no GPS, or site location not set)
    withinRadius: { type: Boolean, default: null },
  },
  { _id: false }
);

const correctionSchema = new Schema(
  {
    correctedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    correctedAt: { type: Date, default: Date.now },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    previous: Schema.Types.Mixed, // snapshot of the values before the correction
  },
  { _id: false }
);

const attendanceSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userRole: { type: String, enum: [ROLES.ENGINEER, ROLES.WORKER], required: true },

    // 'YYYY-MM-DD' in Indian time. Set by the server, never by the app,
    // so one person gets one record per project per day.
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    checkIn: punchSchema,
    checkOut: punchSchema,

    status: {
      type: String,
      enum: ATTENDANCE_STATUS_LIST,
      default: ATTENDANCE_STATUS.PRESENT,
    },
    source: {
      type: String,
      enum: ATTENDANCE_SOURCE_LIST,
      default: ATTENDANCE_SOURCE.SELF_GPS,
    },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Flagged when outside the radius, low GPS accuracy, or entered manually
    exception: {
      flagged: { type: Boolean, default: false },
      reason: { type: String, trim: true, maxlength: 300 },
    },

    // Once confirmed, only an authorised correction (which is logged) can change it.
    isConfirmed: { type: Boolean, default: false },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: Date,

    corrections: [correctionSchema],

    // Worker can raise a dispute about a record
    dispute: {
      status: { type: String, enum: ['open', 'resolved', 'rejected'] },
      reason: { type: String, trim: true, maxlength: 500 },
      raisedAt: Date,
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      resolvedAt: Date,
      resolutionNote: { type: String, trim: true, maxlength: 500 },
    },

    notes: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

attendanceSchema.pre('validate', function (next) {
  if (this.checkIn?.time && this.checkOut?.time && this.checkOut.time < this.checkIn.time) {
    this.invalidate('checkOut', 'Check-out cannot be earlier than check-in');
  }
  next();
});

// Hours between check-in and check-out (null until both exist)
attendanceSchema.virtual('hoursWorked').get(function () {
  if (!this.checkIn?.time || !this.checkOut?.time) return null;
  return Math.round(((this.checkOut.time - this.checkIn.time) / 36e5) * 100) / 100;
});

attendanceSchema.index({ project: 1, user: 1, dateKey: 1 }, { unique: true });
attendanceSchema.index({ user: 1, dateKey: -1 });
attendanceSchema.index({ project: 1, dateKey: -1 });
attendanceSchema.index({ project: 1, 'exception.flagged': 1, dateKey: -1 });
attendanceSchema.index({ 'dispute.status': 1 });

attendanceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.id;
    return ret;
  },
});

export default mongoose.model('Attendance', attendanceSchema);