import { Router } from 'express';
import * as gameController from '../controllers/game.controller';
import * as bookmakerOddsController from '../controllers/bookmakerOdds.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/', gameController.list);
router.get('/:id', gameController.getById);
router.post('/', authenticate, authorize('ADMIN'), gameController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameController.update);

router.post('/:id/fetch-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.fetchForGame);
router.get('/:id/bookmaker-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.getGroupedForGame);
router.post('/:id/markets/approve', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.approveMarket);
router.post('/:id/markets/approve-bulk', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.approveMarketsBulk);

export default router;
