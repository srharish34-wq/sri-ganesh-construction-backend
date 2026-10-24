import { Router } from 'express';
import * as project from '../controllers/project.controller.js';
import * as assignment from '../controllers/assignment.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  createProjectSchema,
  updateProjectSchema,
  projectIdSchema,
  changeStatusSchema,
  archiveProjectSchema,
  listProjectsSchema,
  assignUsersSchema,
  unassignUserSchema,
} from '../validators/project.validator.js';

const router = Router();
router.use(authenticate);

const adminProject = projectAccess({ roles: [ROLES.SUPER_ADMIN] });
const teamProject = projectAccess({ roles: [ROLES.SUPER_ADMIN, ROLES.ENGINEER] });

// ---- Projects ----
router.post('/', adminOnly, validate(createProjectSchema), project.createProject);
router.get('/', validate(listProjectsSchema), project.listProjects); // filtered by role in the controller

// Any role may open a project, but projectAccess() lets in only people linked to it
router.get('/:projectId', validate(projectIdSchema), projectAccess(), project.getProject);

router.patch('/:projectId', adminOnly, validate(updateProjectSchema), adminProject, project.updateProject);
router.patch('/:projectId/status', adminOnly, validate(changeStatusSchema), adminProject, project.changeStatus);
router.post('/:projectId/archive', adminOnly, validate(archiveProjectSchema), adminProject, project.archiveProject);
router.post('/:projectId/unarchive', adminOnly, validate(projectIdSchema), adminProject, project.unarchiveProject);

// ---- Team ----
router.get('/:projectId/team', validate(projectIdSchema), teamProject, assignment.listProjectTeam);
router.post('/:projectId/assignments', adminOnly, validate(assignUsersSchema), adminProject, assignment.assignUsers);
router.delete('/:projectId/assignments/:userId', adminOnly, validate(unassignUserSchema), adminProject, assignment.unassignUser);

export default router;