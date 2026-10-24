import mongoose from 'mongoose';
import { ROLE_LIST } from '../config/constants.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true, maxlength: 150 },
    phone: { type: String, trim: true, maxlength: 20 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_LIST, required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
    mustChangePassword: { type: Boolean, default: true },

    // Worker-specific (ignored for other roles)
    trade: { type: String, trim: true, maxlength: 60 }, // mason, electrician, helper...
    dailyWageRate: { type: Number, min: 0 },

    avatarUrl: String,
    lastLoginAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Every account needs a way to log in
userSchema.pre('validate', function (next) {
  if (!this.email && !this.phone) {
    this.invalidate('email', 'Either email or phone is required');
  }
  next();
});

// Unique only when the field exists (workers may have a phone but no email)
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }
);
userSchema.index({ role: 1, isActive: 1, name: 1 });

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('User', userSchema);