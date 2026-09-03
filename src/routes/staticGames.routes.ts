import { Router } from 'express';
import * as staticGamesController from '../controllers/staticGames.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Information -> Games list (static_data/all_games_list.json)
router.get('/games-list', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.list);
router.post('/games-list/refetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.refetch);
router.get('/games-list/:key', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), staticGamesController.getByKey);

export default router;
