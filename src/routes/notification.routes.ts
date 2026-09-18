import { Router } from 'express';
import * as notificationController from '../controllers/notification.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/mine', authenticate, notificationController.mine);
router.get('/unread-count', authenticate, notificationController.unreadCount);
router.patch('/:id/read', authenticate, notificationController.markOneRead);
router.post('/read-all', authenticate, notificationController.markAll);
router.get('/admin', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), notificationController.adminFeed);

export default router;
