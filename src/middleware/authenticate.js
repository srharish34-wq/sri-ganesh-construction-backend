import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/*
  Reads "Authorization: Bearer <accessToken>", verifies it, then loads the
  user from the database on every request. That way a disabled account or a
  changed role takes effect immediately, not when the token expires.
  Sets req.user.
*/
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new ApiError(401, 'Authentication required', { code: 'NO_TOKEN' });

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    // The mobile app uses this code to know it should call /auth/refresh
    if (err.name === 'TokenExpiredError') {
      throw new ApiError(401, 'Session expired', { code: 'TOKEN_EXPIRED' });
    }
    throw new ApiError(401, 'Invalid token', { code: 'TOKEN_INVALID' });
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'Account not available', { code: 'ACCOUNT_DISABLED' });
  }

  req.user = user;
  next();
});