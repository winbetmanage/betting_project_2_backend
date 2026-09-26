import { Router } from 'express';
import * as transferAccountController from '../controllers/transferAccount.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Any authenticated user can list active transfer accounts (for deposits)
router.get('/active', authenticate, transferAccountController.listActive);

// All other transfer account routes require ADMIN or SUBADMIN (money management)
router.use(authenticate, authorize('ADMIN', 'SUBADMIN'));

router.get('/', transferAccountController.list);
router.get('/:id', transferAccountController.getById);
router.post('/', transferAccountController.create);
router.patch('/:id', transferAccountController.update);
router.delete('/:id', transferAccountController.remove);

export default router;
