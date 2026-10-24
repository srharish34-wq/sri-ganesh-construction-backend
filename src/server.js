import mongoose from 'mongoose';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { startDailyAlerts, stopDailyAlerts } from './jobs/dailyAlerts.js';

let server;

async function start() {
  await connectDB(); // the server starts only if the database connects
  server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`🚀 API running on http://localhost:${env.PORT}/api/v1  (${env.NODE_ENV})`);
    startDailyAlerts({ runOnStart: true });
  });
}

async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  stopDailyAlerts();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start().catch((err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});