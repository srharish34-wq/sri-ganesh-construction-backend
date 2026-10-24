import mongoose from 'mongoose';

const { Schema } = mongoose;

// Only a SHA-256 hash of each refresh token is stored, never the token itself.
const refreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

// MongoDB removes the record automatically once it has expired.
// Revoked tokens are kept until then, so reuse of a stolen token can be detected.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ user: 1, revokedAt: 1 });

export default mongoose.model('RefreshToken', refreshTokenSchema);