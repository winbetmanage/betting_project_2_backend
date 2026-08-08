const ApiError = require('../utils/ApiError');

const notFound = (req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

const errorHandler = (err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ status: 'error', message: err.message });
  }

  if (err.code === 'P2002') {
    return res.status(409).json({ status: 'error', message: 'Duplicate entry already exists' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ status: 'error', message: 'Record not found' });
  }
  if (err.code === 'P2003') {
    return res.status(400).json({ status: 'error', message: 'Invalid related record' });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
  if (err.name === 'ValidationError' || err.type === 'validation') {
    return res.status(400).json({ status: 'error', message: err.message });
  }

  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
};

module.exports = { notFound, errorHandler };
