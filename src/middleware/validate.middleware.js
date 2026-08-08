const ApiError = require('../utils/ApiError');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validate = (rules) => (req, res, next) => {
  const source = req.body;
  for (const [field, rule] of Object.entries(rules)) {
    const value = source[field];

    if (rule.required && (value === undefined || value === null || value === '')) {
      return next(new ApiError(400, `${field} is required`));
    }
    if (value === undefined || value === null) continue;

    if (rule.type === 'email' && !EMAIL_REGEX.test(String(value))) {
      return next(new ApiError(400, `${field} must be a valid email`));
    }
    if (rule.type === 'number' && Number.isNaN(Number(value))) {
      return next(new ApiError(400, `${field} must be a number`));
    }
    if (rule.min !== undefined && Number(value) < rule.min) {
      return next(new ApiError(400, `${field} must be at least ${rule.min}`));
    }
    if (rule.maxLength !== undefined && String(value).length > rule.maxLength) {
      return next(new ApiError(400, `${field} must be at most ${rule.maxLength} characters`));
    }
  }
  next();
};

module.exports = { validate };
