import mongoose from 'mongoose';

const { Schema } = mongoose;

/*
  Append-only history of important changes (projects, payments, approvals,
  attendance corrections, user accounts).
  Never store passwords, tokens or secrets in `before` or `after`.
*/
const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User' }, // empty for system jobs
    actorRole: { type: String, trim: true },
    actorName: { type: String, trim: true }, // copied, so history survives account changes

    // Examples: 'project.create', 'customer_payment.confirm', 'attendance.correct'
    action: { type: String, required: true, trim: true, maxlength: 80 },
    entityType: { type: String, required: true, trim: true, maxlength: 60 },
    entityId: { type: Schema.Types.ObjectId },
    project: { type: Schema.Types.ObjectId, ref: 'Project' },

    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    note: { type: String, trim: true, maxlength: 500 },

    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// ---- Append-only: block edits and deletes made through the app code ----
const BLOCKED_QUERY_OPS = [
  'updateOne', 'updateMany', 'replaceOne',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'deleteOne', 'deleteMany',
];
const blocked = (next) => next(new Error('Audit logs are append-only and cannot be changed.'));

auditLogSchema.pre(BLOCKED_QUERY_OPS, { document: false, query: true }, function (next) {
  blocked(next);
});
auditLogSchema.pre('deleteOne', { document: true, query: false }, function (next) {
  blocked(next);
});
auditLogSchema.pre('save', function (next) {
  if (!this.isNew) return blocked(next);
  next();
});

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ project: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

auditLogSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('AuditLog', auditLogSchema);