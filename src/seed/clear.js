import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';

/*
  DEVELOPMENT ONLY. Deletes every document in the development database but keeps
  the collections and their indexes. It uses the raw driver on purpose, because
  the audit log blocks deletes made through the app code.

    npm run seed:clear                         shows what would be deleted
    npm run seed:clear -- --yes                deletes everything
    npm run seed:clear -- --yes --keep-admin   deletes everything except Super Admin accounts
*/
const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const keepAdmin = args.includes('--keep-admin');

if (env.NODE_ENV === 'production') {
  console.error('❌ Clearing the database is disabled in production.');
  process.exit(1);
}

await connectDB();
const name = mongoose.connection.name;
if (!/(dev|test|local)/i.test(name)) {
  console.error(`❌ Database "${name}" does not look like a development database (name must contain dev, test or local). Nothing was deleted.`);
  await disconnectDB();
  process.exit(1);
}

const db = mongoose.connection.db;
const collections = (await db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));

const filterFor = (collection) => (keepAdmin && collection === 'users' ? { role: { $ne: 'super_admin' } } : {});

console.log(`Database: ${name}${keepAdmin ? '  (Super Admin accounts will be kept)' : ''}`);
const plan = [];
for (const { name: collection } of collections) {
  const count = await db.collection(collection).countDocuments(filterFor(collection));
  plan.push({ collection, count });
  console.log(`  ${collection.padEnd(24)} ${count}`);
}

if (!confirmed) {
  console.log('\nNothing deleted. Add --yes to delete the documents listed above.');
  await disconnectDB();
  process.exit(0);
}

for (const { collection } of plan) {
  await db.collection(collection).deleteMany(filterFor(collection));
}
console.log('\n✅ Done. Collections and indexes were kept.');
if (keepAdmin) console.log('ℹ️  All login sessions were removed, so log in again.');

await disconnectDB();