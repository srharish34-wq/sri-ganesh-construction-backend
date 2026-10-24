import 'dotenv/config'; // loads backend/.env first
import http from 'node:http';
import mongoose from 'mongoose';

// These MUST be set before any file that imports src/config/env.js is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const TEST_DB = 'sri_ganesh_test';
const original = process.env.MONGODB_URI;
if (!original) throw new Error('MONGODB_URI is missing in backend/.env');
process.env.MONGODB_URI = original.replace(
  /^(mongodb(?:\+srv)?:\/\/[^/?]+)\/?([^?]*)/,
  `$1/${TEST_DB}`
);

export const PASSWORD = 'Test1234pass';

const MODEL_NAMES = [
  'User', 'CustomerProfile', 'Project', 'ProjectAssignment', 'Milestone', 'Attendance',
  'DailyReport', 'Media', 'InventoryItem', 'InventoryTransaction', 'CustomerPayment',
  'Expense', 'WorkerWage', 'WorkerPayment', 'Notification', 'AuditLog', 'RefreshToken',
];

let server;
let baseUrl;
let M; // all models by name
let passwordHash;
let counter = 0;

// ---------- Server and database ----------
async function clearAll() {
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  for (const c of collections) {
    if (!c.name.startsWith('system.')) await db.collection(c.name).deleteMany({}); // raw driver: audit log blocks app-level deletes
  }
}

export async function startTestServer() {
  const [{ connectDB }, { default: app }] = await Promise.all([
    import('../src/config/db.js'),
    import('../src/app.js'),
  ]);
  await connectDB();
  if (mongoose.connection.name !== TEST_DB) {
    throw new Error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${TEST_DB}"`);
  }

  M = {};
  for (const name of MODEL_NAMES) M[name] = (await import(`../src/models/${name}.js`)).default;
  await Promise.all(Object.values(M).map((m) => m.createIndexes()));
  await clearAll();

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  return M;
}

export async function stopTestServer() {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === TEST_DB) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
}

export const getModels = () => M;

// ---------- HTTP helpers ----------
export async function api(method, path, { token, body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(baseUrl + path + qs, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// s = a session from createSession (or undefined for "no token")
export const get = (s, path, query) => api('GET', path, { token: s?.token, query });
export const post = (s, path, body = {}) => api('POST', path, { token: s?.token, body });
export const patch = (s, path, body = {}) => api('PATCH', path, { token: s?.token, body });
export const del = (s, path, body) => api('DELETE', path, { token: s?.token, body });

// ---------- Data helpers ----------
// Indian date as YYYY-MM-DD. today(-3) is three days ago, today(2) is the day after tomorrow.
export const today = (offsetDays = 0) =>
  new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

export async function createUser(role, overrides = {}) {
  const { hashPassword } = await import('../src/services/auth.service.js');
  passwordHash ??= await hashPassword(PASSWORD);
  const n = ++counter;
  return M.User.create({
    name: `${role} ${n}`,
    role,
    email: role === 'worker' ? undefined : `${role}${n}@example.test`,
    phone: `9800${String(n).padStart(6, '0')}`,
    passwordHash,
    mustChangePassword: false,
    ...overrides,
  });
}

export async function login(user, password = PASSWORD) {
  const res = await api('POST', '/auth/login', {
    body: { identifier: user.email ?? user.phone, password },
  });
  if (res.status !== 200) throw new Error(`Test login failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data;
}

// A user plus a real login token. s.user is the Mongoose document, s.token the access token.
export async function createSession(role, overrides = {}) {
  const user = await createUser(role, overrides);
  const session = await login(user);
  return { user, token: session.accessToken, refreshToken: session.refreshToken };
}

export async function createProject(customer, overrides = {}) {
  const { createProject: create } = await import('../src/services/project.service.js');
  return create({
    name: 'Test Villa',
    address: { line1: '12 Test Road', city: 'Chennai' },
    siteLocation: { latitude: 13.0827, longitude: 80.2707, radiusMeters: 150 },
    customer: customer._id,
    budget: 800000,
    contractValue: 1000000,
    startDate: new Date('2026-01-01'),
    expectedEndDate: new Date('2027-01-01'),
    status: 'active',
    createdBy: customer._id,
    ...overrides,
  });
}

export const assign = (project, user, assignedBy) =>
  M.ProjectAssignment.create({
    project: project._id,
    user: user._id,
    role: user.role,
    assignedBy: (assignedBy ?? user)._id,
  });