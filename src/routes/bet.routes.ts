import { Router } from 'express';
import * as betController from '../controllers/bet.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.post('/', authenticate, betController.place);
router.get('/mine', authenticate, betController.myBets);
router.get('/:id', authenticate, betController.getById);
// The sub-admin console gets read-only visibility of every ticket (list + receipt).
// Settlement stays admin-only.
router.get('/', authenticate, authorize('ADMIN', 'SUBADMIN', 'SUB_ADMIN'), betController.allBets);
router.post('/:id/settle', authenticate, authorize('ADMIN'), betController.settleSingle);

export default router;
