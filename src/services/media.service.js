import crypto from 'crypto';
import cloudinary, { isCloudinaryConfigured } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export function assertConfigured() {
  if (!isCloudinaryConfigured) {
    throw new ApiError(503, 'Photo and video storage is not set up yet. Please contact the administrator.');
  }
}

/*
  The SERVER chooses the file name (inside sgc/projects/<projectId>/) and signs it.
  The app cannot choose another project's folder, and never sees the API secret.
  Cloudinary accepts the signature for about one hour.
*/
export function createUploadSignature(projectId, resourceType) {
  assertConfigured();
  const publicId = `sgc/projects/${projectId}/${crypto.randomUUID()}`;
  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { public_id: publicId, timestamp, type: 'authenticated' },
    env.CLOUDINARY_API_SECRET
  );
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    publicId,
    type: 'authenticated',
    resourceType,
    // The app must send exactly these fields with the file: api_key, timestamp,
    // signature, public_id, type
  };
}

// Asks Cloudinary whether the file really exists, and what its real size and type are
export async function verifyUpload(publicId, resourceType) {
  assertConfigured();
  try {
    return await cloudinary.api.resource(publicId, { resource_type: resourceType, type: 'authenticated' });
  } catch (err) {
    const code = err?.http_code ?? err?.error?.http_code;
    if (code === 404) {
      throw new ApiError(400, 'The file was not found in storage. The upload may have failed. Please try again.');
    }
    console.error('⚠️ Cloudinary verify failed:', err?.message || err?.error?.message || err);
    throw new ApiError(502, 'Could not check the uploaded file. Please try again.');
  }
}

export async function destroyAsset(publicId, resourceType) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'authenticated', invalidate: true });
  } catch (err) {
    console.error('⚠️ Cloudinary delete failed:', publicId, err?.message || err);
  }
}

// Signed links for private files: the file cannot be opened without the signature
export function deliveryUrls(media) {
  if (!isCloudinaryConfigured) return { thumb: null, full: null };
  const { publicId, resourceType } = media.cloudinary;
  const base = { resource_type: resourceType, type: 'authenticated', sign_url: true, secure: true };

  if (resourceType === 'image') {
    return {
      thumb: cloudinary.url(publicId, {
        ...base,
        transformation: [{ width: 400, height: 400, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
      }),
      full: cloudinary.url(publicId, {
        ...base,
        transformation: [{ width: 2000, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
      }),
    };
  }
  return {
    thumb: cloudinary.url(publicId, { ...base, format: 'jpg', transformation: [{ width: 400, height: 400, crop: 'limit' }] }),
    full: cloudinary.url(publicId, { ...base, format: 'mp4' }),
  };
}