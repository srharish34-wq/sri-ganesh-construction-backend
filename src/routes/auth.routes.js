import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { loginLimiter, passwordResetLimiter } from '../middleware/rateLimiter.js';
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  changePasswordSchema,
} from '../validators/auth.validator.js';

const router = Router();

// Public
router.post('/login', loginLimiter, validate(loginSchema), ctrl.login);
router.post('/refresh', validate(refreshSchema), ctrl.refresh);
router.post('/logout', validate(logoutSchema), ctrl.logout);
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), ctrl.forgotPassword);

// Logged in
router.get('/me', authenticate, ctrl.me);
router.post('/logout-all', authenticate, ctrl.logoutAll);
router.post('/change-password', authenticate, validate(changePasswordSchema), ctrl.changePassword);

export default router;