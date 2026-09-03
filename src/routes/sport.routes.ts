import { Router } from 'express';
import * as sportController from '../controllers/sport.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/', sportController.list);
router.get('/:id', sportController.getById);
router.post('/', authenticate, authorize('ADMIN'), sportController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), sportController.update);

export default router;
