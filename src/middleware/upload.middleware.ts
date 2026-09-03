import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const unlink = promisify(fs.unlink);

const uploadsRoot = path.join(process.cwd(), 'uploads');
const uploadDir = path.join(uploadsRoot, 'fund_requests');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.memoryStorage();

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 8 * 1024 * 1024;

export const fundRequestUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG or WebP images allowed'));
  },
});

// Stored paths are relative like `fund_requests/<id>.webp`.
// Legacy rows may already carry a `uploads/fund_requests/...` prefix, so normalize both.
export function resolveUploadPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/?uploads\//, '');
  return path.join(uploadsRoot, normalized);
}

// Return true if the file existed and was removed, false if it was already gone.
export async function deleteUploadFile(relativePath: string): Promise<boolean> {
  const abs = resolveUploadPath(relativePath);
  try {
    await unlink(abs);
    return true;
  } catch {
    return false;
  }
}

export { uploadsRoot, uploadDir };
