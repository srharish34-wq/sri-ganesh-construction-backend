
import cloudinary, { isCloudinaryConfigured } from './cloudinary.js';

async function testCloudinary() {
  if (!isCloudinaryConfigured) {
    console.error('❌ Cloudinary credentials are missing in .env');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await cloudinary.api.ping();
    console.log('✅ Cloudinary connected successfully:', result);
  } catch (error) {
    console.error('❌ Cloudinary connection failed:', error.message);
    process.exitCode = 1;
  }
}

testCloudinary();
