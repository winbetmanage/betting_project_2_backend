import * as fundRequestService from '../services/fundRequest.service';
import asyncHandler from '../utils/asyncHandler';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import ApiError from '../utils/ApiError';
import prisma from '../utils/prisma';
import { uploadDir, resolveUploadPath, deleteUploadFile } from '../middleware/upload.middleware';

const PROOF_EXT = 'webp';

async function saveProofImage(buffer: Buffer, id: string): Promise<void> {
  const targetPath = path.join(uploadDir, `${id}.${PROOF_EXT}`);
  await sharp(buffer)
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(targetPath);
}

export const getMyBalance = asyncHandler(async (req, res) => {
  const data = await fundRequestService.getMyAvailableBalance(req.user!.id);
  res.json({ data });
});

export const createDeposit = asyncHandler(async (req, res) => {
  const { amount, transferAccountId, senderReference } = req.body as { amount: number; transferAccountId: string; senderReference?: string };
  const file = req.file as Express.Multer.File | undefined;

  // The proof file is named after the FundRequest id, so generate the id up-front
  // and pass it through to the DB create.
  const requestId = crypto.randomUUID();
  const proofImagePath = file ? `fund_requests/${requestId}.${PROOF_EXT}` : undefined;

  // Resize/convert proof image first (validates it before persisting anything)
  if (file) {
    await saveProofImage(file.buffer, requestId);
  }

  let request;
  try {
    request = await fundRequestService.createDepositRequest(req.user!.id, {
      id: requestId,
      amount,
      transferAccountId,
      senderReference,
      proofImagePath,
    });
  } catch (e) {
    // If the DB write failed after saving the file, clean up the orphan
    if (proofImagePath) await deleteUploadFile(proofImagePath);
    throw e;
  }

  res.status(201).json({ message: 'Deposit request submitted', data: request });
});

export const createWithdrawal = asyncHandler(async (req, res) => {
  const { amount, payoutAccountName, payoutAccountNumber, payoutBankName } = req.body as { amount: number; payoutAccountName: string; payoutAccountNumber: string; payoutBankName: string };
  const request = await fundRequestService.createWithdrawalRequest(req.user!.id, { amount, payoutAccountName, payoutAccountNumber, payoutBankName });
  res.status(201).json({ message: 'Withdrawal request submitted', data: request });
});

export const listMyRequests = asyncHandler(async (req, res) => {
  const requests = await fundRequestService.listMyRequests(req.user!.id, req.query as Record<string, unknown>);
  res.json({ data: requests });
});

export const cancelMyRequest = asyncHandler(async (req, res) => {
  await fundRequestService.cancelRequest(req.params.id as string, req.user!.id);
  res.json({ message: 'Request cancelled' });
});

// Admin
export const adminList = asyncHandler(async (_req, res) => {
  const requests = await fundRequestService.adminListRequests(_req.query as Record<string, unknown>);
  res.json({ data: requests });
});

export const adminGetById = asyncHandler(async (req, res) => {
  const request = await fundRequestService.getRequestById(req.params.id as string);
  res.json({ data: request });
});

export const adminApprove = asyncHandler(async (req, res) => {
  const result = await fundRequestService.approveRequest(req.params.id as string, req.user!.id);
  res.json({ message: 'Request approved', data: result });
});

export const adminReject = asyncHandler(async (req, res) => {
  const { reason } = req.body as { reason?: string };
  await fundRequestService.rejectRequest(req.params.id as string, req.user!.id, reason ?? '');
  res.json({ message: 'Request rejected' });
});

export const adminComplete = asyncHandler(async (req, res) => {
  const requestId = req.params.id as string;
  const { transactionId } = req.body as { transactionId?: string };
  const file = req.file as Express.Multer.File | undefined;

  // Validate before touching the filesystem so a failed request never clobbers an existing proof
  const current = await prisma.fundRequest.findUnique({ where: { id: requestId }, select: { type: true, status: true } });
  if (!current) throw new ApiError(404, 'Request not found');
  if (current.type !== 'WITHDRAWAL') throw new ApiError(400, 'Only withdrawal requests can be marked completed');
  if (current.status !== 'APPROVED') throw new ApiError(400, 'Request must be approved before it can be marked completed');

  let completionProofImagePath: string | undefined;
  if (file) {
    // Deterministic path per request: re-uploads overwrite the same file, stored path stays valid
    completionProofImagePath = `fund_requests/${requestId}_completion.${PROOF_EXT}`;
    const targetPath = path.join(uploadDir, `${requestId}_completion.${PROOF_EXT}`);
    await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(targetPath);
  }

  const data = await fundRequestService.completeWithdrawal(requestId, req.user!.id, {
    transactionId: transactionId ?? '',
    completionProofImagePath,
  });
  res.json({ message: 'Withdrawal marked completed', data });
});

export const getProofImage = asyncHandler(async (req, res) => {
  const reqId = req.params.id as string;
  const request = await prisma.fundRequest.findUnique({ where: { id: reqId }, select: { userId: true, proofImagePath: true } });
  if (!request) throw new ApiError(404, 'Request not found');

  // Only the owner or an ADMIN / ODDS_MANAGER can view the proof
  const isStaff = req.user!.role === 'ADMIN' || req.user!.role === 'ODDS_MANAGER';
  if (!isStaff && request.userId !== req.user!.id) throw new ApiError(403, 'Not allowed to view this proof');

  if (!request.proofImagePath) throw new ApiError(404, 'No proof image on this request');

  const abs = resolveUploadPath(request.proofImagePath);
  if (!fs.existsSync(abs)) throw new ApiError(404, 'Proof image not found');

  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(abs)}"`);
  fs.createReadStream(abs).pipe(res);
});

export const getCompletionProof = asyncHandler(async (req, res) => {
  const reqId = req.params.id as string;
  const request = await prisma.fundRequest.findUnique({ where: { id: reqId }, select: { userId: true, completionProofImagePath: true } });
  if (!request) throw new ApiError(404, 'Request not found');

  const isStaff = req.user!.role === 'ADMIN' || req.user!.role === 'ODDS_MANAGER';
  if (!isStaff && request.userId !== req.user!.id) throw new ApiError(403, 'Not allowed to view this proof');

  if (!request.completionProofImagePath) throw new ApiError(404, 'No completion proof image on this request');

  const abs = resolveUploadPath(request.completionProofImagePath);
  if (!fs.existsSync(abs)) throw new ApiError(404, 'Completion proof image not found');

  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(abs)}"`);
  fs.createReadStream(abs).pipe(res);
});
