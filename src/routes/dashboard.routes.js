import { Router } from 'express';
import * as ctrl from '../controllers/dashboard.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';
import { pendingApprovalsSchema, companyFinanceSummarySchema } from '../validators/finance.validator.js';

const router = Router();
router.use(authenticate);

// Every role gets its own dashboard; the controller decides what to return
router.get('/', ctrl.getDashboard);

// Admin only
router.get('/approvals', adminOnly, validate(pendingApprovalsSchema), ctrl.getPendingApprovals);
router.get('/finance', adminOnly, validate(companyFinanceSummarySchema), ctrl.getCompanyFinance);

export default router;