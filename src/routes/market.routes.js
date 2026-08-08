const { Router } = require('express');
const marketController = require('../controllers/market.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = Router();

router.get('/game/:gameId', marketController.listByGame);
router.post('/game/:gameId', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.create);

router.post('/:id/selections', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.addSelection);

router.patch('/selections/:id/odds', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.updateOdds);
router.post('/selections/:id/settle', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.settle);
router.patch('/selections/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.updateSelection);

router.get('/:id', marketController.getById);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), marketController.update);

module.exports = router;