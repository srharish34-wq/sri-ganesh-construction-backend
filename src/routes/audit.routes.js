import { Router } from 'express';
import * as ctrl from '../controllers/audit.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/', ctrl.listAuditLogs);
router.get('/actions', ctrl.listActions); // before "/:id"
router.get('/:id', ctrl.getAuditLog);

export default router;