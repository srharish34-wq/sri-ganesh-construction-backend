import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import RefreshToken from '../models/RefreshToken.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const BCRYPT_ROUNDS = 12;
const REUSE_GRACE_MS = 30 * 1000;

// Compared against when the account does not exist, so response time does not
// reveal which emails or phones are registered
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);

// Emails are compared in lowercase. Phones are compared without spaces or dashes,
// exactly as they were saved (so "+91..." and "91..." are different).
export function normalizeIdentifier(raw) {
  const value = raw.trim();
  return value.includes('@')
    ? { email: value.toLowerCase() }
    : { phone: value.replace(/[\s-]/g, '') };
}

const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL,
  });

async function issueRefreshToken(user, meta = {}) {
  const token = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
  });
  return token;
}

async function buildSession(user, meta) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user, meta),
    user, // toJSON removes the password hash
  };
}

export async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });
}

export async function login(identifier, password, meta) {
  const user = await User.findOne(normalizeIdentifier(identifier)).select('+passwordHash');
  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  // One message for every failure, so attackers learn nothing
  if (!user || !user.isActive || !passwordOk) throw new ApiError(401, 'Invalid credentials');

  user.lastLoginAt = new Date();
  await User.updateOne({ _id: user._id }, { lastLoginAt: user.lastLoginAt });
  return buildSession(user, meta);
}

/*
  Each refresh token works once. The "claim" below is a single atomic database
  operation, so two requests with the same token cannot both succeed.
  If a token that was revoked long ago is used again, it may be stolen, so every
  session of that user is ended. A reuse within 30 seconds (an app retry) is
  just rejected.
*/
export async function refresh(token, meta) {
  const tokenHash = hashToken(token);
  const now = new Date();

  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { revokedAt: now }
  );

  if (!claimed) {
    const record = await RefreshToken.findOne({ tokenHash });
    if (record?.revokedAt && now - record.revokedAt > REUSE_GRACE_MS) {
      await revokeAllSessions(record.user);
    }
    throw new ApiError(401, 'Session expired. Please log in again.', { code: 'REFRESH_INVALID' });
  }

  const user = await User.findById(claimed.user);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'Account not available', { code: 'ACCOUNT_DISABLED' });
  }
  return buildSession(user, meta);
}

export async function logout(token) {
  await RefreshToken.updateOne(
    { tokenHash: hashToken(token), revokedAt: null },
    { revokedAt: new Date() }
  );
}

// Changing the password ends every session, then gives this device a fresh one
export async function changePassword(userId, currentPassword, newPassword, meta) {
  const user = await User.findById(userId).select('+passwordHash');
  const ok = user && (await bcrypt.compare(currentPassword, user.passwordHash));
  if (!ok) {
    // 400, not 401, so the app does not mistake it for an expired session
    throw new ApiError(400, 'Current password is incorrect', [
      { field: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  await user.save();
  await revokeAllSessions(user._id);
  return buildSession(user, meta);
}

// Used by the admin "reset password" tool
export async function setPassword(userId, plainPassword, { mustChangePassword = true } = {}) {
  await User.updateOne(
    { _id: userId },
    { passwordHash: await hashPassword(plainPassword), mustChangePassword }
  );
  await revokeAllSessions(userId);
}