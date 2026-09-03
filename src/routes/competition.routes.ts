import { Router } from 'express';
import * as competitionController from '../controllers/competition.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/', competitionController.list);
router.get('/:id', competitionController.getById);
router.post('/', authenticate, authorize('ADMIN'), competitionController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), competitionController.update);

export default router;
