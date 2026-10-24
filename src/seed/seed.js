import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';
import User from '../models/User.js';
import CustomerProfile from '../models/CustomerProfile.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Milestone from '../models/Milestone.js';
import { hashPassword } from '../services/auth.service.js';
import { createProject, recalculateProgress } from '../services/project.service.js';
import { ROLES } from '../config/constants.js';

/*
  DEVELOPMENT ONLY. Creates: your Super Admin, 3 engineers, 12 workers,
  40 customers, 40 projects with 5 milestones each, and project assignments.
  All sample people are fictional and use @example.test addresses.
*/

// ---------- Safety checks ----------
if (env.NODE_ENV === 'production') {
  console.error('❌ Seeding is disabled in production.');
  process.exit(1);
}
const { SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_TEST_PASSWORD } = process.env;
if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 10) {
  console.error('❌ Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (10+ characters) in .env');
  process.exit(1);
}

// Same sample data every run (a fixed seed)
let state = 20260101;
const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, days) => new Date(date.getTime() + days * DAY);
const pad = (n, len = 2) => String(n).padStart(len, '0');

// ---------- Sample data ----------
const FIRST = ['Arun', 'Bala', 'Chitra', 'Deepa', 'Ezhil', 'Farook', 'Gayathri', 'Hari', 'Indira', 'Jegan',
  'Kavitha', 'Lakshmi', 'Murugan', 'Nithya', 'Omprakash', 'Priya', 'Qadir', 'Ramesh', 'Selvi', 'Thomas'];
const LAST = ['Raman', 'Kumar', 'Iyer', 'Nair', 'Pillai', 'Reddy', 'Sharma', 'Das', 'Menon', 'Rao'];
const AREAS = ['Adyar', 'Velachery', 'Tambaram', 'Anna Nagar', 'Porur', 'Sholinganallur', 'Medavakkam',
  'Perungudi', 'Ambattur', 'Guindy', 'Chromepet', 'Mogappair'];
const TYPES = ['G+1 Residential Villa', 'Apartment Block', 'Commercial Complex', 'Row Houses', 'Warehouse', 'House Renovation'];
const TRADES = ['Mason', 'Carpenter', 'Electrician', 'Plumber', 'Painter', 'Bar bender', 'Helper', 'Helper', 'Mason', 'Helper', 'Tiler', 'Helper'];

const MILESTONES = [
  { title: 'Site preparation and foundation', weight: 10 },
  { title: 'Structure: columns and slabs', weight: 25 },
  { title: 'Masonry and plastering', weight: 25 },
  { title: 'Electrical, plumbing and flooring', weight: 25 },
  { title: 'Finishing, painting and handover', weight: 15 },
];

const STATUS_PLAN = [
  ...Array(5).fill('planning'),
  ...Array(22).fill('active'),
  ...Array(3).fill('on_hold'),
  ...Array(6).fill('delayed'),
  ...Array(4).fill('completed'),
];

// Start and end dates that match the status (delayed projects are past their deadline)
function datesFor(status, today) {
  let elapsed;
  let duration;
  switch (status) {
    case 'planning': elapsed = -int(10, 60); duration = int(240, 420); break;
    case 'active': elapsed = int(30, 200); duration = elapsed + int(40, 300); break;
    case 'on_hold': elapsed = int(60, 200); duration = elapsed + int(60, 250); break;
    case 'delayed': elapsed = int(200, 400); duration = elapsed - int(10, 60); break;
    default: elapsed = int(300, 500); duration = elapsed - int(15, 100); // completed
  }
  const startDate = addDays(today, -elapsed);
  return { startDate, expectedEndDate: addDays(startDate, duration), duration };
}

// How far each of the 5 milestones has got
function milestonePlan(status) {
  const done = { planning: 0, completed: 5, active: int(1, 3), delayed: int(1, 2), on_hold: int(1, 2) }[status];
  return MILESTONES.map((_, i) => {
    if (i < done) return { status: 'completed', progress: 100 };
    if (i === done && status !== 'planning') {
      return { status: 'in_progress', progress: status === 'delayed' ? int(10, 60) : int(20, 80) };
    }
    return { status: 'pending', progress: 0 };
  });
}

// ---------- Run ----------
await connectDB();
const dbName = mongoose.connection.name;
if (!/(dev|test|local)/i.test(dbName)) {
  console.error(`❌ Database "${dbName}" does not look like a development database (name must contain dev, test or local).`);
  await disconnectDB();
  process.exit(1);
}
if ((await Project.countDocuments()) > 0 || (await User.exists({ email: /@example\.test$/ }))) {
  console.error('❌ Sample data already exists. Run "npm run seed:clear -- --yes --keep-admin" first, then seed again.');
  await disconnectDB();
  process.exit(1);
}

// One password for every sample account (development only)
const generated = !SEED_TEST_PASSWORD;
const testPassword = SEED_TEST_PASSWORD || `Dev${crypto.randomBytes(5).toString('hex')}9`;
if (testPassword.length < 8 || !/[A-Za-z]/.test(testPassword) || !/\d/.test(testPassword)) {
  console.error('❌ SEED_TEST_PASSWORD needs 8+ characters with a letter and a number.');
  await disconnectDB();
  process.exit(1);
}
const testHash = await hashPassword(testPassword);

// Super Admin
const adminEmail = SEED_ADMIN_EMAIL.toLowerCase();
let admin = await User.findOne({ email: adminEmail });
if (!admin) {
  admin = await User.create({
    name: SEED_ADMIN_NAME || 'Super Admin',
    email: adminEmail,
    passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
    role: ROLES.SUPER_ADMIN,
    mustChangePassword: false,
  });
  console.log('✅ Super Admin created:', adminEmail);
} else {
  console.log('ℹ️  Super Admin already exists:', adminEmail);
}

// Engineers, workers, customers
const base = { passwordHash: testHash, mustChangePassword: false, createdBy: admin._id };

const engineers = await User.insertMany(
  ['Senthil Kumar', 'Vignesh Raj', 'Anitha Devi'].map((name, i) => ({
    ...base, name, role: ROLES.ENGINEER, email: `engineer${i + 1}@example.test`, phone: `9840010${pad(i + 1, 3)}`,
  }))
);

const workers = await User.insertMany(
  TRADES.map((trade, i) => ({
    ...base, name: `${FIRST[(i * 3) % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    role: ROLES.WORKER, phone: `9840000${pad(i + 1, 3)}`,
    trade, dailyWageRate: int(7, 10) * 100,
  }))
);

const customers = await User.insertMany(
  Array.from({ length: 40 }, (_, i) => ({
    ...base, name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) + (i % 3)]}`,
    role: ROLES.CUSTOMER, email: `customer${pad(i + 1)}@example.test`, phone: `9941000${pad(i + 1, 3)}`,
  }))
);
await CustomerProfile.insertMany(
  customers.map((c) => ({ user: c._id, address: { line1: `${int(1, 120)}, ${pick(AREAS)} Main Road`, city: 'Chennai', state: 'Tamil Nadu', pincode: `600${pad(int(1, 99), 3)}` } }))
);

// Projects, milestones, assignments
const today = new Date();
const counts = {};
let milestoneTotal = 0;

for (let i = 0; i < 40; i += 1) {
  const status = STATUS_PLAN[i];
  const customer = customers[i];
  const area = pick(AREAS);
  const { startDate, expectedEndDate, duration } = datesFor(status, today);
  const contractValue = int(20, 200) * 100000; // ₹20 lakh to ₹2 crore

  const project = await createProject({
    name: `${pick(TYPES)} for ${customer.name.split(' ')[0]}`,
    description: 'Sample project created by the development seed script.',
    address: { line1: `Plot ${int(1, 90)}, ${area}`, city: 'Chennai', state: 'Tamil Nadu', pincode: `600${pad(int(1, 99), 3)}` },
    siteLocation: {
      latitude: Math.round((13.08 + (rand() - 0.5) * 0.24) * 1e6) / 1e6,
      longitude: Math.round((80.27 + (rand() - 0.5) * 0.24) * 1e6) / 1e6,
      radiusMeters: 150,
    },
    customer: customer._id,
    budget: Math.round(contractValue * 0.85),
    contractValue,
    startDate,
    expectedEndDate,
    status,
    actualEndDate: status === 'completed' ? new Date(Math.min(today.getTime(), addDays(expectedEndDate, int(-10, 20)).getTime())) : undefined,
    createdBy: admin._id,
  });

  // Milestones: due dates follow the cumulative weight across the project duration
  const plan = milestonePlan(status);
  let cumulative = 0;
  const docs = MILESTONES.map((m, idx) => {
    cumulative += m.weight;
    const dueDate = addDays(startDate, Math.round((duration * cumulative) / 100));
    const done = plan[idx].status === 'completed';
    return {
      project: project._id, title: m.title, order: idx + 1, dueDate, weightPercent: m.weight,
      status: plan[idx].status, progressPercent: plan[idx].progress,
      completedAt: done ? new Date(Math.min(dueDate.getTime(), today.getTime())) : undefined,
      completedBy: done ? admin._id : undefined,
      createdBy: admin._id,
    };
  });
  await Milestone.insertMany(docs);
  milestoneTotal += docs.length;
  await recalculateProgress(project._id);

  // One engineer and four workers per project
  const team = [{ user: engineers[i % engineers.length], role: ROLES.ENGINEER }];
  for (let w = 0; w < 4; w += 1) team.push({ user: workers[(i * 3 + w) % workers.length], role: ROLES.WORKER });
  await ProjectAssignment.insertMany(team.map((t) => ({ project: project._id, user: t.user._id, role: t.role, assignedBy: admin._id })));

  counts[status] = (counts[status] || 0) + 1;
}

console.log('\n✅ Sample data created');
console.log(`   Projects: 40  ${JSON.stringify(counts)}`);
console.log(`   Milestones: ${milestoneTotal}   Engineers: 3   Workers: ${workers.length}   Customers: 40`);
console.log('\nTest logins (development only):');
console.log('   Super Admin : ' + adminEmail + '  (password from your .env)');
console.log('   Engineer    : engineer1@example.test   (also engineer2, engineer3)');
console.log('   Worker      : 9840000001               (phone numbers 9840000001 to 9840000012)');
console.log('   Customer    : customer01@example.test  (customer01 to customer40)');
console.log(generated
  ? `   Password for all sample accounts except the admin: ${testPassword}\n   (shown once. Set SEED_TEST_PASSWORD in .env to choose your own.)`
  : '   Password for all sample accounts except the admin: your SEED_TEST_PASSWORD');

await disconnectDB();