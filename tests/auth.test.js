import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  startTestServer, stopTestServer, api, get, post, createUser, createSession, login, PASSWORD,
} from './setup.js';

let M;
before(async () => { M = await startTestServer(); });
after(() => stopTestServer());

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const attempt = (identifier, password) => api('POST', '/auth/login', { body: { identifier, password } });

describe('login', () => {
  it('logs in with email and returns tokens but no password hash', async () => {
    const user = await createUser('engineer');
    const res = await attempt(user.email, PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.data.accessToken, 'string');
    assert.ok(res.body.data.refreshToken.length > 20);
    assert.equal(res.body.data.user.email, user.email);
    assert.equal('passwordHash' in res.body.data.user, false);
  });

  it('logs in with a phone number (workers have no email)', async () => {
    const worker = await createUser('worker');
    const res = await attempt(worker.phone, PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.role, 'worker');
  });

  it('treats email case-insensitively', async () => {
    const user = await createUser('customer');
    assert.equal((await attempt(user.email.toUpperCase(), PASSWORD)).status, 200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const user = await createUser('engineer');
    const wrong = await attempt(user.email, 'WrongPass999');
    const unknown = await attempt('nobody@example.test', 'WrongPass999');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, 'Invalid credentials');
    assert.equal(unknown.body.message, 'Invalid credentials');
  });

  it('refuses a deactivated account', async () => {
    const user = await createUser('engineer', { isActive: false });
    assert.equal((await attempt(user.email, PASSWORD)).status, 401);
  });

  it('returns field errors for an empty form', async () => {
    const res = await attempt('', '');
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.details));
    assert.ok(res.body.details.some((d) => d.field === 'identifier'));
  });
});

describe('secrets are stored safely', () => {
  it('stores a bcrypt hash, not the password', async () => {
    const user = await createUser('engineer');
    const stored = await M.User.findById(user._id).select('+passwordHash');
    assert.notEqual(stored.passwordHash, PASSWORD);
    assert.ok(stored.passwordHash.startsWith('$2'));
  });

  it('stores only a hash of the refresh token', async () => {
    const user = await createUser('engineer');
    const session = await login(user);
    const record = await M.RefreshToken.findOne({ user: user._id });
    assert.notEqual(record.tokenHash, session.refreshToken);
    assert.equal(record.tokenHash, sha256(session.refreshToken));
  });
});

describe('access tokens', () => {
  it('lets a valid token read /auth/me', async () => {
    const s = await createSession('engineer');
    const res = await get(s, '/auth/me');
    assert.equal(res.status, 200);
    assert.equal(String(res.body.data._id), s.user.id);
    assert.equal('passwordHash' in res.body.data, false);
  });

  it('rejects a missing token', async () => {
    const res = await get(undefined, '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.details.code, 'NO_TOKEN');
  });

  it('rejects a garbage token', async () => {
    const res = await get({ token: 'not.a.token' }, '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.details.code, 'TOKEN_INVALID');
  });

  it('tells the app when a token has expired', async () => {
    const user = await createUser('engineer');
    const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });
    const res = await get({ token }, '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.details.code, 'TOKEN_EXPIRED');
  });

  it('rejects a token signed with another secret', async () => {
    const user = await createUser('engineer');
    const token = jwt.sign({ sub: user.id, role: user.role }, 'some-other-secret-that-is-long-enough-123', { expiresIn: '5m' });
    assert.equal((await get({ token }, '/auth/me')).body.details.code, 'TOKEN_INVALID');
  });

  it('stops working immediately when the account is deactivated', async () => {
    const s = await createSession('engineer');
    assert.equal((await get(s, '/auth/me')).status, 200);
    await M.User.updateOne({ _id: s.user._id }, { isActive: false });
    const res = await get(s, '/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.details.code, 'ACCOUNT_DISABLED');
  });

  it('ignores the role written inside the token and uses the database', async () => {
    const worker = await createUser('worker');
    const token = jwt.sign({ sub: worker.id, role: 'super_admin' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
    assert.equal((await get({ token }, '/users')).status, 403);
  });
});

describe('refresh tokens', () => {
  it('issues a new pair and the old token works only once', async () => {
    const user = await createUser('engineer');
    const first = await login(user);

    const second = await post(undefined, '/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.data.refreshToken, first.refreshToken);

    const reuse = await post(undefined, '/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.details.code, 'REFRESH_INVALID');

    // A quick retry is just rejected: the newest session survives
    const next = await post(undefined, '/auth/refresh', { refreshToken: second.body.data.refreshToken });
    assert.equal(next.status, 200);
  });

  it('ends every session when an old revoked token is used again (possible theft)', async () => {
    const user = await createUser('engineer');
    const first = await login(user);
    const second = await post(undefined, '/auth/refresh', { refreshToken: first.refreshToken });

    await M.RefreshToken.updateOne(
      { tokenHash: sha256(first.refreshToken) },
      { revokedAt: new Date(Date.now() - 5 * 60 * 1000) }
    );

    assert.equal((await post(undefined, '/auth/refresh', { refreshToken: first.refreshToken })).status, 401);
    assert.equal((await post(undefined, '/auth/refresh', { refreshToken: second.body.data.refreshToken })).status, 401);
  });

  it('logout revokes the refresh token', async () => {
    const user = await createUser('engineer');
    const session = await login(user);
    assert.equal((await post(undefined, '/auth/logout', { refreshToken: session.refreshToken })).status, 200);
    assert.equal((await post(undefined, '/auth/refresh', { refreshToken: session.refreshToken })).status, 401);
  });

  it('rejects a malformed refresh token with a validation error', async () => {
    assert.equal((await post(undefined, '/auth/refresh', { refreshToken: 'short' })).status, 400);
  });
});

describe('change password', () => {
  const body = (over) => ({ currentPassword: PASSWORD, newPassword: 'NewPass5678x', confirmPassword: 'NewPass5678x', ...over });

  it('refuses a wrong current password, a weak new one, and an unchanged one', async () => {
    const s = await createSession('engineer');

    const wrong = await post(s, '/auth/change-password', body({ currentPassword: 'WrongPass999' }));
    assert.equal(wrong.status, 400);
    assert.ok(wrong.body.details.some((d) => d.field === 'currentPassword'));

    assert.equal((await post(s, '/auth/change-password', body({ newPassword: 'short', confirmPassword: 'short' }))).status, 400);
    assert.equal((await post(s, '/auth/change-password', body({ newPassword: PASSWORD, confirmPassword: PASSWORD }))).status, 400);
    assert.equal((await post(s, '/auth/change-password', body({ confirmPassword: 'Different123' }))).status, 400);
  });

  it('changes the password and logs out every other session', async () => {
    const user = await createUser('engineer');
    const session = await login(user);
    const otherDevice = await login(user);

    const res = await post({ token: session.accessToken }, '/auth/change-password', body());
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken); // this device gets a fresh session

    assert.equal((await attempt(user.email, PASSWORD)).status, 401); // old password no longer works
    assert.equal((await attempt(user.email, 'NewPass5678x')).status, 200);
    assert.equal((await post(undefined, '/auth/refresh', { refreshToken: otherDevice.refreshToken })).status, 401);
  });
});

describe('forgot password', () => {
  it('answers the same whether or not the account exists', async () => {
    const user = await createUser('engineer');
    const a = await post(undefined, '/auth/forgot-password', { identifier: user.email });
    const b = await post(undefined, '/auth/forgot-password', { identifier: 'nobody@example.test' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.message, b.body.message);
  });
});

// Keep this LAST: it uses up the failed-login allowance for this IP
describe('login throttling', () => {
  it('blocks an IP after repeated failed logins', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await attempt('nobody@example.test', 'WrongPass999')).status);
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429);
  });
});