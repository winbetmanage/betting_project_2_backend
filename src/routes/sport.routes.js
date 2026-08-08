const { Router } = require('express');
const sportController = require('../controllers/sport.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = Router();

router.get('/', sportController.list);
router.get('/:id', sportController.getById);
router.post('/', authenticate, authorize('ADMIN'), sportController.create);
router.patch('/:id', authenticate, authorize('ADMIN', 'ODDS_MANAGER'), sportController.update);

module.exports = router;
