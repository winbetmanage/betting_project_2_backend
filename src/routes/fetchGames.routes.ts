import { Router } from 'express';
import * as fetchGamesController from '../controllers/fetchGames.controller';
import * as stagedGamesController from '../controllers/stagedGames.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Staged games (Odds API -> staging table, admin confirmation later)
router.get('/staged', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.listStaged);
router.post('/staged/fetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.fetchAndStage);
router.post('/staged/stage-selected', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.stageSelected);
router.post('/staged/refresh', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.refreshStaged);
router.post('/staged/delete', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.deleteSelected);
router.post('/staged/clear-finished', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.clearFinished);
router.get('/staged/staged-ids', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.getStagedIds);

// Football-data linking for a staged game (match on same date + teams via Team table)
router.get('/staged/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.getStagedGame);
router.post('/staged/:id/find-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.findFootballData);
router.post('/staged/:id/link-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.linkFootballData);
router.post('/staged/:id/unlink-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.unlinkFootballData);
router.post('/staged/:id/refresh-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.refreshFootballData);
router.post('/staged/:id/confirm', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.confirmToGames);

// UEFA Champions League browse (The Odds API, via new codes.ts)
router.get('/champions-league', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.listChampionsLeague);

// Premier League browse (same service as CL; legacy /premier-league routes below stay for now)
router.get('/premier-league-events', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), stagedGamesController.listPremierLeagueEvents);

// Fetch Games -> Premier League (uses getEplEventsUrl from codes.ts)
router.get('/premier-league', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.listPremierLeague);
router.post('/premier-league/refetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.refreshPremierLeague);
router.get('/premier-league/published-ids', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.getPublishedIds);
router.post('/premier-league/:id/publish', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.publishOne);
router.post('/premier-league/publish-bulk', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.publishBulk);

// Premier League Results (Football-Data.org)
router.get('/premier-league-results', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.listResults);
router.post('/premier-league-results/fetch', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), fetchGamesController.fetchResults);

export default router;
