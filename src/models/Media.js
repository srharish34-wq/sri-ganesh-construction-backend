import mongoose from 'mongoose';
import { MEDIA_TYPE_LIST, WORK_CATEGORIES } from '../config/constants.js';

const { Schema } = mongoose;

const mediaSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    report: { type: Schema.Types.ObjectId, ref: 'DailyReport' }, // optional
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    type: { type: String, enum: MEDIA_TYPE_LIST, required: true },
    category: { type: String, enum: WORK_CATEGORIES, default: 'other' },
    description: { type: String, trim: true, maxlength: 500 },
    takenAt: { type: Date, default: Date.now }, // when the photo or video was captured

    // Cloudinary details. The API secret never leaves the server.
    cloudinary: {
      publicId: { type: String, required: true },
      resourceType: { type: String, enum: ['image', 'video'], required: true },
      // 'authenticated' means files cannot be opened without a server-signed URL
      deliveryType: { type: String, enum: ['authenticated', 'upload'], default: 'authenticated' },
      format: String,
      bytes: { type: Number, min: 0 },
      width: Number,
      height: Number,
      durationSeconds: Number,
    },
    // Stored for reference. For private files the server issues a short-lived
    // signed URL on each request instead of exposing this one.
    secureUrl: { type: String, required: true },

    // The customer sees media only when this is true AND the parent report is published
    isCustomerVisible: { type: Boolean, default: false },

    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

mediaSchema.index({ 'cloudinary.publicId': 1 }, { unique: true });
mediaSchema.index({ project: 1, isDeleted: 1, takenAt: -1 }); // gallery
mediaSchema.index({ report: 1 });
mediaSchema.index({ project: 1, isCustomerVisible: 1, isDeleted: 1, takenAt: -1 }); // customer gallery
mediaSchema.index({ uploadedBy: 1, createdAt: -1 });

mediaSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('Media', mediaSchema);