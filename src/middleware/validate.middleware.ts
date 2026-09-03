import type { Request, Response, NextFunction } from 'express';
import ApiError from '../utils/ApiError';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidationRule = {
  required?: boolean;
  type?: 'email' | 'number' | 'string';
  min?: number;
  maxLength?: number;
};

export type ValidationRules = Record<string, ValidationRule>;

export const validate =
  (rules: ValidationRules) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const source = req.body as Record<string, unknown>;
    for (const [field, rule] of Object.entries(rules)) {
      const value = source[field];

      if (rule.required && (value === undefined || value === null || value === '')) {
        next(new ApiError(400, `${field} is required`));
        return;
      }
      if (value === undefined || value === null) continue;

      if (rule.type === 'email' && !EMAIL_REGEX.test(String(value))) {
        next(new ApiError(400, `${field} must be a valid email`));
        return;
      }
      if (rule.type === 'number' && Number.isNaN(Number(value))) {
        next(new ApiError(400, `${field} must be a number`));
        return;
      }
      if (rule.min !== undefined && Number(value) < rule.min) {
        next(new ApiError(400, `${field} must be at least ${rule.min}`));
        return;
      }
      if (rule.maxLength !== undefined && String(value).length > rule.maxLength) {
        next(new ApiError(400, `${field} must be at most ${rule.maxLength} characters`));
        return;
      }
    }
    next();
  };
