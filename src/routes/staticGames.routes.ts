import { Router } from 'express';
import * as staticGamesController from '../controllers/staticGames.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Information -> Markets (supported market-type catalog from the JSON registries)
router.get('/market-types', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.marketTypes);
router.get('/games-list', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.list);
router.post('/games-list/refetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.refetch);
router.get('/games-list/:key', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.getByKey);

export default router;
