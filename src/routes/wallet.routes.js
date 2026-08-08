const { Router } = require('express');
const walletController = require('../controllers/wallet.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');

const router = Router();

router.get('/balance', authenticate, walletController.getBalance);
router.get('/transactions', authenticate, walletController.getTransactions);
router.post('/deposit', authenticate, validate({ amount: { required: true, type: 'number', min: 0.01 } }), walletController.deposit);
router.post('/withdraw', authenticate, validate({ amount: { required: true, type: 'number', min: 0.01 } }), walletController.withdraw);

module.exports = router;