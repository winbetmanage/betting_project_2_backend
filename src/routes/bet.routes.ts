import { Router } from 'express';
import * as betController from '../controllers/bet.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.post('/', authenticate, betController.place);
router.get('/mine', authenticate, betController.myBets);
router.get('/:id', authenticate, betController.getById);
router.get('/', authenticate, authorize('ADMIN'), betController.allBets);

export default router;
