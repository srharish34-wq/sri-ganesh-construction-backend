import { env, isProd } from '../config/env.js';

/*
  One place that turns every error into the same JSON shape:
    { success: false, message: '...', details: ... }
  The mobile app reads `message` to show the user, and `details.code`
  (for example TOKEN_EXPIRED) to decide what to do.
*/
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let message = err.message || 'Server error';
  let details = err.details;

  if (err.code === 11000) {
    // Duplicate value in a unique index
    status = 409;
    message = 'A record with this value already exists';
    details = { fields: Object.keys(err.keyPattern || {}) };
  } else if (err.name === 'ValidationError' && err.errors) {
    // Mongoose schema validation
    status = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.name === 'CastError') {
    status = 400;
    message = 'Invalid ID or value format';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON in request body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request is too large';
  }

  if (status >= 500) {
    console.error(`❌ ${req.method} ${req.originalUrl}`, err);
    // Never leak internal error text in production
    if (isProd) {
      message = 'Something went wrong. Please try again.';
      details = undefined;
    }
  }

  res.status(status).json({
    success: false,
    message,
    ...(details !== undefined && { details }),
    ...(env.NODE_ENV === 'development' && status >= 500 && { stack: err.stack }),
  });
}