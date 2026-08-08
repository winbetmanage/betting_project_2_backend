const { Router } = require('express');
const betController = require('../controllers/bet.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = Router();

router.post('/', authenticate, betController.place);
router.get('/mine', authenticate, betController.myBets);
router.get('/:id', authenticate, betController.getById);
router.get('/', authenticate, authorize('ADMIN'), betController.allBets);

module.exports = router;