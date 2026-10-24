import mongoose from 'mongoose';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { ROLES, ROLE_LIST } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/*
  Who may open a project:
    super_admin  every project
    engineer     only projects with an ACTIVE engineer assignment
    worker       only projects with an ACTIVE worker assignment
    customer     only the project where project.customer is them

  If the user has no access, the answer is 404 (not 403), so nobody can
  discover which project IDs exist.
*/
export async function resolveProjectAccess(user, project) {
  switch (user.role) {
    case ROLES.SUPER_ADMIN:
      return ROLES.SUPER_ADMIN;
    case ROLES.CUSTOMER:
      return project.customer.equals(user._id) ? ROLES.CUSTOMER : null;
    case ROLES.ENGINEER:
    case ROLES.WORKER: {
      const assigned = await ProjectAssignment.exists({
        project: project._id,
        user: user._id,
        role: user.role,
        isActive: true,
      });
      return assigned ? user.role : null;
    }
    default:
      return null;
  }
}

/*
  Route middleware. Always place it AFTER authenticate.
  Options:
    from           where the project ID is: 'params' (default), 'body' or 'query'
    param          the field name (default 'projectId')
    roles          roles allowed on THIS route (default: all roles)
    allowArchived  let non-admins open archived projects (default false)

  Examples:
    router.get('/:projectId', authenticate, projectAccess(), handler)
    router.post('/', authenticate, projectAccess({ from: 'body', roles: ['engineer'] }), handler)

  Sets req.project and req.projectRole.
*/
export const projectAccess = (options = {}) => {
  const { from = 'params', param = 'projectId', roles = ROLE_LIST, allowArchived = false } = options;

  return asyncHandler(async (req, _res, next) => {
    if (!req.user) throw new ApiError(401, 'Authentication required');
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, 'You do not have permission to do this');
    }

    const id = req[from]?.[param];
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Project not found');

    const project = await Project.findById(id);
    if (!project) throw new ApiError(404, 'Project not found');

    const projectRole = await resolveProjectAccess(req.user, project);
    if (!projectRole) throw new ApiError(404, 'Project not found');

    if (project.isArchived && req.user.role !== ROLES.SUPER_ADMIN && !allowArchived) {
      throw new ApiError(404, 'Project not found');
    }

    req.project = project;
    req.projectRole = projectRole;
    next();
  });
};

/*
  For LIST endpoints (GET /projects). Returns a MongoDB filter containing only
  the projects this user may see, so the database does the filtering and the
  list is paginated on the server.
*/
export async function accessibleProjectFilter(user) {
  if (user.role === ROLES.SUPER_ADMIN) return {};

  if (user.role === ROLES.CUSTOMER) {
    return { customer: user._id, isArchived: false };
  }

  const projectIds = await ProjectAssignment.find({
    user: user._id,
    role: user.role,
    isActive: true,
  }).distinct('project');

  return { _id: { $in: projectIds }, isArchived: false };
}