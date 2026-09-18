import { Router } from 'express';
import * as fundRequestController from '../controllers/fundRequest.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { fundRequestUpload } from '../middleware/upload.middleware';

const router = Router();

// User routes (authenticated)
router.get('/balance', authenticate, fundRequestController.getMyBalance);
router.post('/deposit', authenticate, fundRequestUpload.single('proofImage'), fundRequestController.createDeposit);
router.post('/withdraw', authenticate, fundRequestController.createWithdrawal);
router.get('/requests', authenticate, fundRequestController.listMyRequests);
router.post('/requests/:id/cancel', authenticate, fundRequestController.cancelMyRequest);

// Admin routes
router.get('/admin/requests', authenticate, authorize('ADMIN'), fundRequestController.adminList);
router.get('/admin/requests/:id', authenticate, authorize('ADMIN'), fundRequestController.adminGetById);
router.post('/admin/requests/:id/approve', authenticate, authorize('ADMIN'), fundRequestUpload.single('completionProof'), fundRequestController.adminApprove);
router.post('/admin/requests/:id/reject', authenticate, authorize('ADMIN'), fundRequestController.adminReject);
router.patch('/admin/requests/:id/complete', authenticate, authorize('ADMIN'), fundRequestUpload.single('completionProof'), fundRequestController.adminComplete);

// Proof images (owner or admin)
router.get('/requests/:id/proof', authenticate, fundRequestController.getProofImage);
router.get('/requests/:id/completion-proof', authenticate, fundRequestController.getCompletionProof);

export default router;