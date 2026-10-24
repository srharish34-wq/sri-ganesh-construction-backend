import Project from '../models/Project.js';

// Year in Indian time
export const currentYearIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCFullYear();

// Next code like SGC-2026-001. The unique index on projectCode is the real
// safety net; project.service.js retries if two admins create at the same moment.
export async function nextProjectCode() {
  const prefix = `SGC-${currentYearIST()}-`;
  const last = await Project.findOne({ projectCode: { $regex: `^${prefix}` } })
    .sort({ projectCode: -1 })
    .collation({ locale: 'en', numericOrdering: true })
    .select('projectCode')
    .lean();
  const lastNumber = last ? parseInt(last.projectCode.slice(prefix.length), 10) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(3, '0')}`;
}