import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Milestone from '../models/Milestone.js';
import { ROLES } from '../config/constants.js';
import { nextProjectCode } from '../utils/idGenerator.js';
import { ApiError } from '../utils/ApiError.js';

// Creates a project with a generated code, retrying if the code was just taken
export async function createProject(data) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const projectCode = await nextProjectCode();
    try {
      return await Project.create({ ...data, projectCode });
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.projectCode) continue;
      throw err;
    }
  }
  throw new ApiError(503, 'Could not generate a project ID. Please try again.');
}

/*
  Decides what each role may see of a project.
    super_admin  everything
    engineer     no budget or contract value
    worker       no money, no GPS coordinates, no customer details
    customer     contract value yes, budget no, no internal fields
*/
export function shapeProject(project, role) {
  const obj = typeof project.toJSON === 'function' ? project.toJSON() : { ...project };
  if (role === ROLES.SUPER_ADMIN) return obj;

  delete obj.createdBy;
  delete obj.updatedBy;
  delete obj.archivedAt;

  if (role === ROLES.ENGINEER) {
    delete obj.budget;
    delete obj.contractValue;
  } else if (role === ROLES.WORKER) {
    delete obj.budget;
    delete obj.contractValue;
    delete obj.siteLocation;
    delete obj.customer;
  } else if (role === ROLES.CUSTOMER) {
    delete obj.budget;
    delete obj.siteLocation;
    delete obj.customer;
  }
  return obj;
}

/*
  Project progress comes from milestones: sum of (weight x progress) / 100.
  If no milestone has a weight, it is the plain average. If the project has no
  milestones yet, the stored value is left alone.
  If weights add up to less than 100, the unplanned part counts as 0% done.
*/
export async function recalculateProgress(projectId) {
  const [agg] = await Milestone.aggregate([
    { $match: { project: new mongoose.Types.ObjectId(String(projectId)) } },
    {
      $group: {
        _id: null,
        totalWeight: { $sum: '$weightPercent' },
        weighted: { $sum: { $multiply: ['$weightPercent', '$progressPercent'] } },
        average: { $avg: '$progressPercent' },
      },
    },
  ]);
  if (!agg) return null;

  const raw = agg.totalWeight > 0 ? agg.weighted / 100 : agg.average;
  const progress = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
  await Project.updateOne({ _id: projectId }, { progressPercent: progress });
  return progress;
}