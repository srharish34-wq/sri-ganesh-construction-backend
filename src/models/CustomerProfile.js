import mongoose from 'mongoose';

const customerProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    companyName: { type: String, trim: true, maxlength: 150 },
    alternatePhone: { type: String, trim: true, maxlength: 20 },
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 80 },
      state: { type: String, trim: true, maxlength: 80 },
      pincode: { type: String, trim: true, maxlength: 10 },
    },
    // Internal company notes. Never returned unless explicitly selected by admin code.
    internalNotes: { type: String, select: false, maxlength: 2000 },
  },
  { timestamps: true }
);

customerProfileSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('CustomerProfile', customerProfileSchema);