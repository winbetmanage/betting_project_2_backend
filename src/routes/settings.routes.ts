import { Router } from 'express';
import * as settingsController from '../controllers/settings.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/', authenticate, authorize('ADMIN'), settingsController.list);
router.get('/max-stake', authenticate, settingsController.maxStake);
router.get('/public', authenticate, settingsController.publicLimits);
router.patch('/:key', authenticate, authorize('ADMIN'), settingsController.update);

export default router;
