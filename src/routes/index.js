import { Router } from 'express';
import mongoose from 'mongoose';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import projectRoutes from './project.routes.js';
import milestoneRoutes from './milestone.routes.js';
import attendanceRoutes from './attendance.routes.js';
import reportRoutes from './report.routes.js';
import mediaRoutes from './media.routes.js';
import inventoryRoutes from './inventory.routes.js';
import financeRoutes from './finance.routes.js';
import wageRoutes from './wage.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import notificationRoutes from './notification.routes.js';
import exportRoutes from './export.routes.js';
import auditRoutes from './audit.routes.js';

const router = Router();

router.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const database = states[mongoose.connection.readyState];
  res.status(database === 'connected' ? 200 : 503).json({
    success: database === 'connected',
    status: 'ok',
    database,
    databaseName: mongoose.connection.name,
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/projects/:projectId/milestones', milestoneRoutes);
router.use('/projects/:projectId/inventory', inventoryRoutes);
router.use('/projects/:projectId', financeRoutes); // customer-payments and expenses
router.use('/projects', projectRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/reports', reportRoutes);
router.use('/media', mediaRoutes);
router.use('/', wageRoutes); // /wages, /worker-payments, /disputes, /workers
router.use('/dashboard', dashboardRoutes);
router.use('/notifications', notificationRoutes);
router.use('/exports', exportRoutes);
router.use('/audit-logs', auditRoutes);

// Add each of these only after its route file has real code:
//   attendance, reports, media, inventory, finance, wages, dashboard,
//   notifications, exports, audit-logs

export default router;