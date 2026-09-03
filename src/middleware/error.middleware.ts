import type { Request, Response, NextFunction } from 'express';
import ApiError from '../utils/ApiError';

export const notFound = (req: Request, _res: Response, next: NextFunction): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ status: 'error', message: err.message });
    return;
  }

  const prismaErr = err as { code?: string; name?: string; message?: string; type?: string };
  if (prismaErr.code === 'P2002') {
    res.status(409).json({ status: 'error', message: 'Duplicate entry already exists' });
    return;
  }
  if (prismaErr.code === 'P2025') {
    res.status(404).json({ status: 'error', message: 'Record not found' });
    return;
  }
  if (prismaErr.code === 'P2003') {
    res.status(400).json({ status: 'error', message: 'Invalid related record' });
    return;
  }
  if (prismaErr.name === 'JsonWebTokenError' || prismaErr.name === 'TokenExpiredError') {
    res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
    return;
  }
  if (prismaErr.name === 'ValidationError' || prismaErr.type === 'validation') {
    res.status(400).json({ status: 'error', message: prismaErr.message });
    return;
  }

  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
};
