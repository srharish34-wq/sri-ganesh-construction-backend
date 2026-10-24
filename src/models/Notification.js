import mongoose from 'mongoose';
import { NOTIFICATION_TYPE, NOTIFICATION_TYPE_LIST } from '../config/constants.js';

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // the recipient
    type: { type: String, enum: NOTIFICATION_TYPE_LIST, default: NOTIFICATION_TYPE.GENERAL },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },

    project: { type: Schema.Types.ObjectId, ref: 'Project' },
    // Where the app should open when the notification is tapped
    entity: {
      kind: {
        type: String,
        enum: ['report', 'milestone', 'expense', 'customer_payment', 'worker_payment',
               'wage', 'inventory_item', 'attendance', 'project'],
      },
      id: Schema.Types.ObjectId,
    },

    isRead: { type: Boolean, default: false },
    readAt: Date,

    // Stops the daily alert job from sending the same alert twice.
    // Example: "low_stock:<itemId>:2026-10-12"
    dedupeKey: { type: String, trim: true, maxlength: 150 },

    // MongoDB deletes the notification automatically after this date
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notificationSchema.index(
  { user: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

notificationSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.expiresAt;
    return ret;
  },
});

export default mongoose.model('Notification', notificationSchema);