import { Router } from 'express';
import * as ctrl from '../controllers/milestone.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  createMilestoneSchema,
  bulkCreateMilestonesSchema,
  updateMilestoneSchema,
  updateMilestoneProgressSchema,
  milestoneParamsSchema,
  projectMilestonesSchema,
} from '../validators/milestone.validator.js';

// mergeParams makes :projectId from the parent path (/projects/:projectId/milestones) available here
const router = Router({ mergeParams: true });
router.use(authenticate);

const { SUPER_ADMIN, ENGINEER, CUSTOMER } = ROLES;
const readers = projectAccess({ roles: [SUPER_ADMIN, ENGINEER, CUSTOMER] }); // workers do not see milestones
const adminProject = projectAccess({ roles: [SUPER_ADMIN] });
const progressUpdaters = projectAccess({ roles: [SUPER_ADMIN, ENGINEER] });

router.get('/', validate(projectMilestonesSchema), readers, ctrl.listMilestones);
router.post('/', adminOnly, validate(createMilestoneSchema), adminProject, ctrl.createMilestone);
router.post('/bulk', adminOnly, validate(bulkCreateMilestonesSchema), adminProject, ctrl.bulkCreateMilestones);

router.get('/:milestoneId', validate(milestoneParamsSchema), readers, ctrl.getMilestone);
router.patch('/:milestoneId', adminOnly, validate(updateMilestoneSchema), adminProject, ctrl.updateMilestone);
router.patch('/:milestoneId/progress', validate(updateMilestoneProgressSchema), progressUpdaters, ctrl.updateProgress);
router.delete('/:milestoneId', adminOnly, validate(milestoneParamsSchema), adminProject, ctrl.deleteMilestone);

export default router;