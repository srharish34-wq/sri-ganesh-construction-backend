import { Router } from 'express';
import * as ctrl from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();
router.use(authenticate);

router.get('/', ctrl.listNotifications);

// Fixed paths must come before "/:id", or they would be read as an ID
router.get('/unread-count', ctrl.getUnreadCount);
router.post('/read-all', ctrl.markAllRead);

router.post('/:id/read', ctrl.markRead);
router.delete('/:id', ctrl.deleteNotification);

export default router;