import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { NOTIFICATION_TYPE_LIST } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, buildPage } from '../utils/pagination.js';

// Every query includes the logged-in user, so nobody can read or change another person's notifications
const mine = (req, extra = {}) => ({ user: req.user._id, ...extra });

function checkId(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Notification not found');
}

// GET /notifications?unread=true&type=low_stock&page=1
export const listNotifications = asyncHandler(async (req, res) => {
  const paging = getPagination(req.query);
  const filter = mine(req);
  if (req.query.unread === 'true') filter.isRead = false;
  if (NOTIFICATION_TYPE_LIST.includes(req.query.type)) filter.type = req.query.type;

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.limit),
    Notification.countDocuments(filter),
    Notification.countDocuments(mine(req, { isRead: false })),
  ]);
  res.json({ success: true, data: { ...buildPage(items, total, paging), unreadCount: unread } });
});

// GET /notifications/unread-count   (for the bell badge)
export const getUnreadCount = asyncHandler(async (req, res) => {
  const unreadCount = await Notification.countDocuments(mine(req, { isRead: false }));
  res.json({ success: true, data: { unreadCount } });
});

// POST /notifications/:id/read
export const markRead = asyncHandler(async (req, res) => {
  checkId(req.params.id);
  const notification = await Notification.findOne(mine(req, { _id: req.params.id }));
  if (!notification) throw new ApiError(404, 'Notification not found');

  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }
  res.json({ success: true, data: notification });
});

// POST /notifications/read-all
export const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(mine(req, { isRead: false }), {
    isRead: true,
    readAt: new Date(),
  });
  res.json({ success: true, data: { updated: result.modifiedCount } });
});

// DELETE /notifications/:id
export const deleteNotification = asyncHandler(async (req, res) => {
  checkId(req.params.id);
  const result = await Notification.deleteOne(mine(req, { _id: req.params.id }));
  if (result.deletedCount === 0) throw new ApiError(404, 'Notification not found');
  res.json({ success: true, message: 'Notification removed' });
});