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
router.patch('/:id/visibility', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.setVisibility);
router.delete('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.remove);

// Replace a wrong market with the same market from another bookmaker / line and
// migrate every bet leg onto the new selections.
router.get('/:id/replace-options', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.replaceOptions);
router.post('/:id/replace-preview', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.replacePreview);
router.post('/:id/replace', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.replace);

export default router;
