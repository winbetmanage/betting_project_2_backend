import { Router } from 'express';
import * as userController from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', authenticate, userController.getProfile);
router.patch('/me', authenticate, userController.updateProfile);
router.get('/me/referrals', authenticate, userController.listMyReferrals);

// Admin only
router.get('/', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.list);
router.get('/agents', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.listAgentsOverview);
router.get('/agents/:id/stats', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.getAgentStats);
router.get('/devices', authenticate, authorize('ADMIN'), userController.listDevices);
router.get('/referral-bonuses', authenticate, authorize('ADMIN'), userController.listReferralBonuses);
router.get('/admin-actions', authenticate, authorize('ADMIN'), userController.listAdminActions);
router.get('/:id', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.getById);
router.get('/:id/bets', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.listUserBets);
router.get('/:id/upline', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.getUpline);
router.get('/:id/referred-users', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.listReferredUsers);
router.patch('/:id', authenticate, authorize('ADMIN', 'SUBADMIN'), userController.updateByAdmin);
router.delete('/:id', authenticate, authorize('ADMIN'), userController.remove);

export default router;
