import { Router } from 'express';
import * as gameController from '../controllers/game.controller';
import * as bookmakerOddsController from '../controllers/bookmakerOdds.controller';
import * as gameSettlementController from '../controllers/gameSettlement.controller';
import * as gameApiLinkController from '../controllers/gameApiLink.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.get('/', gameController.list);
router.get('/results', gameController.results);
router.get('/settlement-list', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameSettlementController.listBetGames);
router.get('/:id', gameController.getById);
router.post('/', authenticate, authorize('ADMIN'), gameController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameController.update);
router.post('/bulk-delete', authenticate, authorize('ADMIN'), gameController.removeBulk);
router.post('/clear-all', authenticate, authorize('ADMIN'), gameController.clearAllGamesData);

router.post('/:id/fetch-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.fetchForGame);
router.get('/:id/bookmaker-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.getGroupedForGame);
router.get('/:id/api-details', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.apiDetails);
router.get('/:id/football-details', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameSettlementController.footballDetails);
router.get('/:id/settlement', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameSettlementController.getSettlement);
router.get('/:id/api-links', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.links);
router.post('/:id/api-links/find-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.findFd);
router.post('/:id/api-links/find-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.findOdds);
router.post('/:id/api-links/link-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.linkFd);
router.post('/:id/api-links/unlink-fd', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.unlinkFd);
router.post('/:id/api-links/link-odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameApiLinkController.linkOdds);
router.post('/:id/settle', authenticate, authorize('ADMIN'), gameSettlementController.settle);
router.post('/:id/settle-payments', authenticate, authorize('ADMIN'), gameSettlementController.settlePayments);
router.post('/:id/calculate', authenticate, authorize('ADMIN'), gameSettlementController.calculate);
router.post('/:id/payout', authenticate, authorize('ADMIN'), gameSettlementController.payout);
router.post('/:id/bets/:betId/settle', authenticate, authorize('ADMIN'), gameSettlementController.settleSingleBet);
router.post('/:id/markets/approve', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.approveMarket);
router.post('/:id/markets/approve-bulk', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), bookmakerOddsController.approveMarketsBulk);

export default router;
