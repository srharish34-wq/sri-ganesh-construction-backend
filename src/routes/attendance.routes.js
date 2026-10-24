import { Router } from 'express';
import * as ctrl from '../controllers/attendance.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { ROLES } from '../config/constants.js';
import {
  checkInSchema,
  checkOutSchema,
  recordWorkerAttendanceSchema,
  bulkWorkerAttendanceSchema,
  correctAttendanceSchema,
  confirmAttendanceSchema,
  raiseDisputeSchema,
  resolveDisputeSchema,
  listAttendanceSchema,
} from '../validators/attendance.validator.js';

const router = Router();
router.use(authenticate);

const { SUPER_ADMIN, ENGINEER, WORKER } = ROLES;

// Own attendance: engineers and workers only, and only on projects they are assigned to
const selfPunch = projectAccess({ from: 'body', roles: [ENGINEER, WORKER] });
const selfToday = projectAccess({ from: 'query', roles: [ENGINEER, WORKER] });
// Recording for someone else: admin or the project's engineer
const staffEntry = projectAccess({ from: 'body', roles: [SUPER_ADMIN, ENGINEER] });

router.get('/today', selfToday, ctrl.getToday);
router.post('/check-in', validate(checkInSchema), selfPunch, ctrl.checkIn);
router.post('/check-out', validate(checkOutSchema), selfPunch, ctrl.checkOut);

router.post('/worker', validate(recordWorkerAttendanceSchema), staffEntry, ctrl.recordWorkerAttendance);
router.post('/worker/bulk', validate(bulkWorkerAttendanceSchema), staffEntry, ctrl.bulkWorkerAttendance);

// The controller filters by role (workers see only their own history)
router.get('/', validate(listAttendanceSchema), ctrl.listAttendance);

// Routes with :id come last. The controller checks project access itself.
router.post('/:id/confirm', validate(confirmAttendanceSchema), ctrl.confirmAttendance);
router.patch('/:id/correct', validate(correctAttendanceSchema), ctrl.correctAttendance);
router.post('/:id/dispute', validate(raiseDisputeSchema), ctrl.raiseDispute);
router.post('/:id/dispute/resolve', validate(resolveDisputeSchema), ctrl.resolveDispute);

export default router;