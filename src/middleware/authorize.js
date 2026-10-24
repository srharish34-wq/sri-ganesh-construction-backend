import { ROLES, ROLE_LIST } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';

/*
  Role check. Always place it AFTER authenticate.
  Usage:  router.post('/', authenticate, authorize(ROLES.SUPER_ADMIN), handler)
*/
export const authorize = (...allowedRoles) => {
  // Catch typos when the server starts, not when a user hits the route
  const unknown = allowedRoles.filter((r) => !ROLE_LIST.includes(r));
  if (allowedRoles.length === 0 || unknown.length) {
    throw new Error(`authorize(): invalid role list [${allowedRoles.join(', ')}]`);
  }

  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (!allowedRoles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to do this'));
    }
    next();
  };
};

// Shortcuts
export const adminOnly = authorize(ROLES.SUPER_ADMIN);
export const staffOnly = authorize(ROLES.SUPER_ADMIN, ROLES.ENGINEER);