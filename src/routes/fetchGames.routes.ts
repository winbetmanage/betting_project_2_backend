import { Router } from 'express';
import * as fetchGamesController from '../controllers/fetchGames.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Fetch Games -> Premier League (uses FetchEplEvents from codes.ts)
router.get('/premier-league', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.listPremierLeague);
router.post('/premier-league/refetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.refreshPremierLeague);
router.get('/premier-league/published-ids', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.getPublishedIds);
router.post('/premier-league/:id/publish', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.publishOne);
router.post('/premier-league/publish-bulk', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.publishBulk);

// Premier League Results (Football-Data.org)
router.get('/premier-league-results', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.listResults);
router.post('/premier-league-results/fetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.fetchResults);

export default router;
