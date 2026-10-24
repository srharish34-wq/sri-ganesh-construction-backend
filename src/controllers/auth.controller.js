import * as authService from '../services/auth.service.js';
import { logAudit } from '../services/audit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const meta = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

export const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const session = await authService.login(identifier, password, meta(req));
  res.json({ success: true, data: session });
});

export const refresh = asyncHandler(async (req, res) => {
  const session = await authService.refresh(req.body.refreshToken, meta(req));
  res.json({ success: true, data: session });
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.json({ success: true, message: 'Logged out' });
});

// Ends the session on every device
export const logoutAll = asyncHandler(async (req, res) => {
  await authService.revokeAllSessions(req.user._id);
  res.json({ success: true, message: 'Logged out on all devices' });
});

export const me = (req, res) => res.json({ success: true, data: req.user });

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const session = await authService.changePassword(
    req.user._id,
    currentPassword,
    newPassword,
    meta(req)
  );
  await logAudit(req, { action: 'user.change_password', entityType: 'User', entityId: req.user._id });
  res.json({
    success: true,
    message: 'Password changed. Other devices have been logged out.',
    data: session,
  });
});

/*
  There is no email or SMS service connected yet, so the app cannot send a reset
  link. This answers the same way whether or not the account exists, and tells
  the person to contact the office. The admin resets it from Users > Reset password.
*/
export const forgotPassword = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    message:
      'If this account exists, please contact the Sri Ganesh Construction office to reset your password.',
  });
});