import { Router } from 'express';
import * as userController from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', authenticate, userController.getProfile);
router.patch('/me', authenticate, userController.updateProfile);
router.get('/me/referrals', authenticate, userController.listMyReferrals);

// Admin only
router.get('/', authenticate, authorize('ADMIN'), userController.list);
router.get('/devices', authenticate, authorize('ADMIN'), userController.listDevices);
router.get('/referral-bonuses', authenticate, authorize('ADMIN'), userController.listReferralBonuses);
router.get('/:id', authenticate, authorize('ADMIN'), userController.getById);
router.get('/:id/bets', authenticate, authorize('ADMIN'), userController.listUserBets);
router.get('/:id/upline', authenticate, authorize('ADMIN'), userController.getUpline);
router.get('/:id/referred-users', authenticate, authorize('ADMIN'), userController.listReferredUsers);
router.patch('/:id', authenticate, authorize('ADMIN'), userController.updateByAdmin);
router.delete('/:id', authenticate, authorize('ADMIN'), userController.remove);

export default router;
