import prisma from '../../utils/prisma.js';
import { deleteUploadFile } from '../../middleware/upload.middleware.js';

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const CLEANUP_STATUSES = ['REJECTED', 'CANCELLED'];

export async function runFundRequestProofCleanupJob() {
  const timestamp = new Date().toISOString();
  try {
    const cutoff = new Date(Date.now() - SIX_MONTHS_MS);

    const stale = await prisma.fundRequest.findMany({
      where: {
        status: { in: CLEANUP_STATUSES as never },
        updatedAt: { lt: cutoff },
        proofImagePath: { not: null },
      },
      select: { id: true, proofImagePath: true },
    });

    let filesDeleted = 0;
    let rowsUpdated = 0;

    for (const row of stale) {
      if (!row.proofImagePath) continue;
      const deleted = await deleteUploadFile(row.proofImagePath);
      if (deleted) filesDeleted++;
      await prisma.fundRequest.update({ where: { id: row.id }, data: { proofImagePath: null } });
      rowsUpdated++;
    }

    console.log(
      `[fund-request-proof-cleanup] ${timestamp} - stale found ${stale.length}, files deleted ${filesDeleted}, rows updated ${rowsUpdated}`
    );
    return { staleFound: stale.length, filesDeleted, rowsUpdated };
  } catch (err) {
    console.error(
      `[fund-request-proof-cleanup] ${timestamp} - failed:`,
      err instanceof Error ? err.message : String(err)
    );
    return { staleFound: 0, filesDeleted: 0, rowsUpdated: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runFundRequestProofCleanupJob;
