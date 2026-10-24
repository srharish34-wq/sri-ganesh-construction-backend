import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected'));
mongoose.connection.on('error', (err) => console.error('❌ MongoDB error:', err.message));

export async function connectDB() {
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  console.log('✅ MongoDB connected:', mongoose.connection.name);
}

export async function disconnectDB() {
  await mongoose.disconnect();
}