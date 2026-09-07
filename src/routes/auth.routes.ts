import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';

const router = Router();

// Public — resolve a referral code to the referrer's display name (signup page)
router.get('/referral', authController.referralInfo);

router.post(
  '/register',
  validate({
    email: { required: true, type: 'email' },
    password: { required: true, min: 6 },
    name: { required: true, maxLength: 100 },
  }),
  authController.register
);

router.post(
  '/login',
  validate({
    email: { required: true, type: 'email' },
    password: { required: true },
  }),
  authController.login
);

router.post(
  '/refresh',
  validate({
    refreshToken: { required: true },
  }),
  authController.refresh
);

router.post(
  '/logout',
  validate({
    refreshToken: { required: true },
  }),
  authController.logout
);

router.post('/logout-all', authenticate, authController.logoutAll);
router.post('/change-password', authenticate, validate({ currentPassword: { required: true }, newPassword: { required: true, min: 6 } }), authController.changePassword);

export default router;
