import { Router } from 'express';
import * as marketController from '../controllers/market.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/game/:gameId', marketController.listByGame);
router.post('/game/:gameId', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.create);

router.post('/:id/selections', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.addSelection);

router.patch('/selections/:id/odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.updateOdds);
router.post('/selections/:id/settle', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.settle);
router.patch('/selections/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.updateSelection);

router.get('/:id', marketController.getById);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.update);
router.delete('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.remove);

export default router;
