const { Router } = require('express');
const gameController = require('../controllers/game.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = Router();

router.get('/', gameController.list);
router.get('/:id', gameController.getById);
router.post('/', authenticate, authorize('ADMIN'), gameController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), gameController.update);

module.exports = router;
