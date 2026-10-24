import Media from '../models/Media.js';
import DailyReport from '../models/DailyReport.js';
import Project from '../models/Project.js';
import * as mediaService from '../services/media.service.js';
import { logAudit } from '../services/audit.service.js';
import { resolveProjectAccess } from '../middleware/projectAccess.js';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../validators/media.validator.js';
import { ROLES, APPROVAL_STATUS as S } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';
import { dayStart, dayEnd } from '../utils/dates.js';

const notFound = () => new ApiError(404, 'File not found');
const isAdmin = (user) => user.role === ROLES.SUPER_ADMIN;

// The stored Cloudinary link is never sent to the app. Signed links are sent instead.
function shapeMedia(media, role) {
  const obj = media.toJSON();
  delete obj.secureUrl;
  const urls = mediaService.deliveryUrls(media);
  obj.thumbUrl = urls.thumb;
  obj.url = urls.full;

  if (role === ROLES.CUSTOMER) {
    for (const key of ['cloudinary', 'uploadedBy', 'isCustomerVisible', 'isDeleted', 'deletedAt', 'deletedBy']) delete obj[key];
  }
  return obj;
}

async function customerCanSee(media) {
  if (!media.isCustomerVisible) return false;
  if (!media.report) return true;
  return Boolean(await DailyReport.exists({ _id: media.report, status: S.PUBLISHED }));
}

async function loadMedia(req, id) {
  const media = await Media.findOne({ _id: id, isDeleted: false });
  if (!media) throw notFound();
  const project = await Project.findById(media.project);
  const projectRole = project && (await resolveProjectAccess(req.user, project));
  if (!projectRole || (project.isArchived && !isAdmin(req.user))) throw notFound();

  if (req.user.role === ROLES.WORKER) throw new ApiError(403, 'You do not have permission to do this');
  if (req.user.role === ROLES.CUSTOMER && !(await customerCanSee(media))) throw notFound();
  return { media, project };
}

// POST /media/upload-signature   (admin or engineer; route uses projectAccess + uploadLimiter)
export const getUploadSignature = asyncHandler(async (req, res) => {
  const { resourceType } = req.body;
  res.json({ success: true, data: mediaService.createUploadSignature(req.project._id, resourceType) });
});

/*
  POST /media   (admin or engineer)
  Called after the app has uploaded the file to Cloudinary. The server asks
  Cloudinary whether the file really exists and uses Cloudinary's own size and
  type, not the app's claim.
*/
export const registerMedia = asyncHandler(async (req, res) => {
  const { project, user } = { project: req.project, user: req.user };
  const b = req.body;

  let report;
  if (b.reportId) {
    report = await DailyReport.findOne({ _id: b.reportId, project: project._id });
    if (!report) throw new ApiError(400, 'Report not found in this project', [{ field: 'reportId', message: 'Report not found' }]);
    if (!isAdmin(user)) {
      if (!report.author.equals(user._id)) throw new ApiError(403, 'You can attach files only to your own reports');
      if (![S.DRAFT, S.REJECTED].includes(report.status)) throw new ApiError(409, 'This report is already submitted');
    }
  }

  const asset = await mediaService.verifyUpload(b.cloudinary.publicId, b.cloudinary.resourceType);

  const limit = asset.resource_type === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (asset.resource_type !== b.type || asset.bytes > limit) {
    await mediaService.destroyAsset(b.cloudinary.publicId, asset.resource_type);
    throw new ApiError(400, asset.resource_type !== b.type ? 'Media type does not match the uploaded file' : 'The file is too large');
  }

  const now = new Date();
  const takenAt = b.takenAt && b.takenAt <= new Date(now.getTime() + 5 * 60 * 1000) ? b.takenAt : now;

  let media;
  try {
    media = await Media.create({
      project: project._id,
      report: report?._id,
      uploadedBy: user._id,
      type: b.type,
      category: b.category,
      description: b.description,
      takenAt,
      cloudinary: {
        publicId: asset.public_id,
        resourceType: asset.resource_type,
        deliveryType: 'authenticated',
        format: asset.format,
        bytes: asset.bytes,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.duration,
      },
      secureUrl: asset.secure_url,
      isCustomerVisible: false, // the admin decides what the customer sees
    });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'This file was already registered');
    throw err;
  }

  await logAudit(req, {
    action: 'media.upload', entityType: 'Media', entityId: media._id, project: project._id,
    note: `${b.type}, ${Math.round(asset.bytes / 1024)} KB`,
  });
  res.status(201).json({ success: true, data: shapeMedia(media, user.role) });
});

// GET /media?projectId=...   (route uses projectAccess({ from: 'query', roles: [admin, engineer, customer] }))
export const listMedia = asyncHandler(async (req, res) => {
  const q = req.validated.query;
  const { project, user } = { project: req.project, user: req.user };
  const paging = getPagination(q);
  const filter = { project: project._id, isDeleted: false };

  if (q.type) filter.type = q.type;
  if (q.category) filter.category = q.category;
  if (q.from || q.to) filter.takenAt = { ...(q.from && { $gte: dayStart(q.from) }), ...(q.to && { $lte: dayEnd(q.to) }) };

  if (user.role === ROLES.CUSTOMER) {
    // Visible only when marked visible AND (no report, or the report is published)
    const published = await DailyReport.find({ project: project._id, status: S.PUBLISHED }).distinct('_id');
    filter.isCustomerVisible = true;
    filter.$or = [{ report: null }, { report: { $in: published } }];
    if (q.reportId) {
      if (!published.some((id) => id.equals(q.reportId))) filter._id = null; // report not published: empty result
      filter.report = q.reportId;
      delete filter.$or;
    }
  } else {
    if (q.reportId) filter.report = q.reportId;
    if (q.uploadedBy) filter.uploadedBy = q.uploadedBy;
    if (q.customerVisible !== undefined) filter.isCustomerVisible = q.customerVisible;
  }

  const sort = q.sort === 'oldest' ? { takenAt: 1, _id: 1 } : { takenAt: -1, _id: -1 };
  let query = Media.find(filter).sort(sort).skip(paging.skip).limit(paging.limit);
  if (user.role !== ROLES.CUSTOMER) query = query.populate('uploadedBy', 'name');
  const [rows, total] = await Promise.all([query, Media.countDocuments(filter)]);

  res.json({ success: true, data: buildPage(rows.map((m) => shapeMedia(m, user.role)), total, paging) });
});

// GET /media/:mediaId
export const getMedia = asyncHandler(async (req, res) => {
  const { media } = await loadMedia(req, req.params.mediaId);
  if (req.user.role !== ROLES.CUSTOMER) await media.populate('uploadedBy', 'name');
  res.json({ success: true, data: shapeMedia(media, req.user.role) });
});

// PATCH /media/:mediaId   (admin: everything; engineer: own uploads, no visibility change)
export const updateMedia = asyncHandler(async (req, res) => {
  const { media, project } = await loadMedia(req, req.params.mediaId);
  const admin = isAdmin(req.user);
  if (!admin) {
    if (!media.uploadedBy.equals(req.user._id)) throw new ApiError(403, 'You can edit only your own uploads');
    if (req.body.isCustomerVisible !== undefined) throw new ApiError(403, 'Only the admin can decide what the customer sees');
  }

  const before = { category: media.category, description: media.description, isCustomerVisible: media.isCustomerVisible };
  for (const key of ['category', 'description', 'isCustomerVisible']) {
    if (req.body[key] !== undefined) media.set(key, req.body[key]);
  }
  if (!media.isModified()) return res.json({ success: true, data: shapeMedia(media, req.user.role) });
  await media.save();

  await logAudit(req, {
    action: before.isCustomerVisible !== media.isCustomerVisible ? 'media.visibility_change' : 'media.update',
    entityType: 'Media', entityId: media._id, project: project._id, before,
    after: { category: media.category, description: media.description, isCustomerVisible: media.isCustomerVisible },
  });
  res.json({ success: true, data: shapeMedia(media, req.user.role) });
});

/*
  DELETE /media/:mediaId   (admin any; engineer own uploads that the customer cannot see)
  Soft delete: the record and the Cloudinary file are kept for the audit trail.
*/
export const deleteMedia = asyncHandler(async (req, res) => {
  const { media, project } = await loadMedia(req, req.params.mediaId);
  if (!isAdmin(req.user)) {
    if (!media.uploadedBy.equals(req.user._id)) throw new ApiError(403, 'You can delete only your own uploads');
    if (media.isCustomerVisible) throw new ApiError(403, 'Only the admin can delete a file the customer can see');
  }

  media.isDeleted = true;
  media.deletedAt = new Date();
  media.deletedBy = req.user._id;
  await media.save();

  await logAudit(req, {
    action: 'media.delete', entityType: 'Media', entityId: media._id, project: project._id, note: req.body.reason,
  });
  res.json({ success: true, message: 'File removed' });
});