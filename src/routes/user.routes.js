import { Router } from 'express';
import * as ctrl from '../controllers/user.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { adminOnly } from '../middleware/authorize.js';
import {
  createUserSchema,
  updateUserSchema,
  userIdSchema,
  adminResetPasswordSchema,
  listUsersSchema,
} from '../validators/user.validator.js';

const router = Router();

// Every user-management route is Super Admin only
router.use(authenticate, adminOnly);

router.post('/', validate(createUserSchema), ctrl.createUser);
router.get('/', validate(listUsersSchema), ctrl.listUsers);
router.get('/:id', validate(userIdSchema), ctrl.getUser);
router.patch('/:id', validate(updateUserSchema), ctrl.updateUser);
router.post('/:id/reset-password', validate(adminResetPasswordSchema), ctrl.resetUserPassword);

export default router;