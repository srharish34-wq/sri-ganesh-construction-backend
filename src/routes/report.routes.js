import { Router } from 'express';
import * as ctrl from '../controllers/report.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  createReportSchema,
  updateReportSchema,
  reportIdSchema,
  reviewReportSchema,
  publishReportSchema,
  unpublishReportSchema,
  listReportsSchema,
} from '../validators/report.validator.js';

const router = Router();
router.use(authenticate);

// Only engineers write reports, and only for projects they are assigned to
const engineerOnProject = projectAccess({ from: 'body', roles: [ROLES.ENGINEER] });

router.post('/', validate(createReportSchema), engineerOnProject, ctrl.createReport);
router.get('/', validate(listReportsSchema), ctrl.listReports); // filtered by role in the controller

// Routes with :reportId. The controller checks project access and report visibility itself.
router.get('/:reportId', validate(reportIdSchema), ctrl.getReport);
router.patch('/:reportId', validate(updateReportSchema), ctrl.updateReport);
router.post('/:reportId/submit', validate(reportIdSchema), ctrl.submitReport);

// Admin decisions
router.post('/:reportId/review', adminOnly, validate(reviewReportSchema), ctrl.reviewReport);
router.post('/:reportId/publish', adminOnly, validate(publishReportSchema), ctrl.publishReport);
router.post('/:reportId/unpublish', adminOnly, validate(unpublishReportSchema), ctrl.unpublishReport);

export default router;