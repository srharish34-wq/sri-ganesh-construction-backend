import rateLimit from 'express-rate-limit';

const tooMany = (message) => ({ success: false, message });

// General limit for every API call, per IP
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many requests. Please slow down.'),
});

// Strict limit on login attempts. Only failed attempts are counted, so a
// real user who logs in correctly is never blocked.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: tooMany('Too many login attempts. Try again in 15 minutes.'),
});

// Forgot-password and reset requests (stops email and SMS spam)
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many reset requests. Try again in an hour.'),
});

// Media upload signatures (Phase 5)
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many upload requests. Please wait a moment.'),
});