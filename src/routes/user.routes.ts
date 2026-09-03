import { Router } from 'express';
import * as userController from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', authenticate, userController.getProfile);
router.patch('/me', authenticate, userController.updateProfile);

// Admin only
router.get('/', authenticate, authorize('ADMIN'), userController.list);
router.get('/:id', authenticate, authorize('ADMIN'), userController.getById);
router.patch('/:id', authenticate, authorize('ADMIN'), userController.updateByAdmin);
router.delete('/:id', authenticate, authorize('ADMIN'), userController.remove);

export default router;
