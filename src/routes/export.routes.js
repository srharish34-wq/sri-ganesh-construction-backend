import { Router } from 'express';
import * as ctrl from '../controllers/export.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';

const router = Router();
router.use(authenticate, adminOnly);

// :type = projects | customer-payments | expenses | attendance | inventory
//         | inventory-transactions | worker-wages | worker-payments
// Query: projectId (required except for "projects"), from, to (YYYY-MM-DD)
router.get('/:type', ctrl.exportCsv);

export default router;