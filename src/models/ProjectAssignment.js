import mongoose from 'mongoose';
import { ROLES } from '../config/constants.js';

// Links engineers and workers to projects.
// The customer is linked directly on the Project (project.customer).
const projectAssignmentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: [ROLES.ENGINEER, ROLES.WORKER], required: true },
    isActive: { type: Boolean, default: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
    unassignedAt: Date,
    unassignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// A user can be actively assigned to a project only once.
// Past (inactive) assignments stay as history.
projectAssignmentSchema.index(
  { project: 1, user: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Fast lookups used by the access-control middleware
projectAssignmentSchema.index({ user: 1, isActive: 1 });
projectAssignmentSchema.index({ project: 1, role: 1, isActive: 1 });

projectAssignmentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('ProjectAssignment', projectAssignmentSchema);