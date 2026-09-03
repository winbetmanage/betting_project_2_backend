import { Router } from 'express';
import * as walletController from '../controllers/wallet.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';

const router = Router();

router.get('/balance', authenticate, walletController.getBalance);
router.get('/transactions', authenticate, walletController.getTransactions);
router.post('/deposit', authenticate, validate({ amount: { required: true, type: 'number', min: 0.01 } }), walletController.deposit);
router.post('/withdraw', authenticate, validate({ amount: { required: true, type: 'number', min: 0.01 } }), walletController.withdraw);

export default router;
