const { Router } = require('express');
const competitionController = require('../controllers/competition.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = Router();

router.get('/', competitionController.list);
router.get('/:id', competitionController.getById);
router.post('/', authenticate, authorize('ADMIN'), competitionController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), competitionController.update);

module.exports = router;
