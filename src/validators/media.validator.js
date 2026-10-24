import { z } from 'zod';
import { MEDIA_TYPE_LIST, WORK_CATEGORIES } from '../config/constants.js';
import {
  objectId, idParam, optional, dateField, dateKey, boolQuery,
  paginationQuery, reason,
} from './common.validator.js';

/*
  Upload flow (the app never sees the Cloudinary secret):
    1. App asks the server for an upload signature      (uploadSignatureSchema)
    2. App uploads the file straight to Cloudinary
    3. App tells the server what was uploaded           (registerMediaSchema)
    4. Server checks the file with Cloudinary, then saves it in MongoDB

  Every file must live in the folder  sgc/projects/<projectId>/
  so a file can never be attached to the wrong project.
  Size limits below match the Cloudinary free plan and may change.
*/
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/3gpp', 'video/webm'];

export const projectFolder = (projectId) => `sgc/projects/${projectId}/`;

export const uploadSignatureSchema = z.object({
  body: z
    .object({
      projectId: objectId,
      resourceType: z.enum(MEDIA_TYPE_LIST),
      mimeType: z.enum([...IMAGE_MIME, ...VIDEO_MIME]),
      fileSizeBytes: z.number().int().positive(),
    })
    .refine((d) => (d.resourceType === 'image' ? IMAGE_MIME : VIDEO_MIME).includes(d.mimeType), {
      path: ['mimeType'],
      message: 'File type does not match the selected media type',
    })
    .refine(
      (d) => d.fileSizeBytes <= (d.resourceType === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES),
      (d) => ({
        path: ['fileSizeBytes'],
        message:
          d.resourceType === 'image'
            ? 'Photo is too large (maximum 10 MB)'
            : 'Video is too large (maximum 100 MB)',
      })
    ),
});

const cloudinaryResult = z.object({
  publicId: z.string().trim().min(5).max(250),
  resourceType: z.enum(['image', 'video']),
  format: optional(z.string().trim().max(10)),
  bytes: z.number().int().min(1),
  width: optional(z.number().int().min(1)),
  height: optional(z.number().int().min(1)),
  durationSeconds: optional(z.number().min(0)),
});

const cloudinaryUrl = z
  .string()
  .trim()
  .url()
  .max(600)
  .refine((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
    } catch {
      return false;
    }
  }, 'Must be a Cloudinary HTTPS link');

export const registerMediaSchema = z.object({
  body: z
    .object({
      projectId: objectId,
      reportId: optional(objectId),
      type: z.enum(MEDIA_TYPE_LIST),
      category: z.enum(WORK_CATEGORIES).default('other'),
      description: optional(z.string().trim().max(500)),
      takenAt: optional(dateField),
      cloudinary: cloudinaryResult,
      secureUrl: cloudinaryUrl,
    })
    .refine((d) => d.cloudinary.publicId.startsWith(projectFolder(d.projectId)), {
      path: ['cloudinary', 'publicId'],
      message: 'File was not uploaded to this project folder',
    })
    .refine((d) => d.cloudinary.resourceType === d.type, {
      path: ['type'],
      message: 'Media type does not match the uploaded file',
    }),
});

// Editing details only. The file itself can never be replaced.
// isCustomerVisible can be set only by the admin (the route enforces this).
export const updateMediaSchema = z.object({
  params: idParam('mediaId'),
  body: z
    .object({
      category: z.enum(WORK_CATEGORIES),
      description: optional(z.string().trim().max(500)),
      isCustomerVisible: z.boolean(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

// Soft delete: the record stays for the audit trail
export const deleteMediaSchema = z.object({
  params: idParam('mediaId'),
  body: z.object({ reason: reason(5, 300) }),
});

// Asks for a short-lived signed link to view a private file
export const mediaIdSchema = z.object({ params: idParam('mediaId') });

export const listMediaSchema = z.object({
  query: z.object({
    ...paginationQuery,
    projectId: objectId,
    reportId: objectId.optional(),
    type: z.enum(MEDIA_TYPE_LIST).optional(),
    category: z.enum(WORK_CATEGORIES).optional(),
    uploadedBy: objectId.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
    customerVisible: boolQuery.optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
  }),
});