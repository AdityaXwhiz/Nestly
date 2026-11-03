import { AppError } from '../errors/AppError.js';

/**
 * Global Express error handling middleware.
 * Formats errors into the standard contract shape from LLD section 10:
 * { error: { code, message, requestId, details } }
 * Never leaks stack traces, raw SQL queries, or sensitive internals.
 */
export function errorHandler(err, req, res, _next) {
  const requestId = req.id || 'unknown';

  if (err instanceof AppError) {
    if (req.log) {
      req.log.warn(
        {
          code: err.code,
          httpStatus: err.httpStatus,
          details: err.details,
          errMessage: err.message,
        },
        'Operational error handled',
      );
    }

    return res.status(err.httpStatus).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
        details: err.details || {},
      },
    });
  }

  // Handle JSON parse errors from express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON payload',
        requestId,
        details: {},
      },
    });
  }

  // Unexpected internal errors — log full details privately, never leak to client
  if (req.log) {
    req.log.error({ err }, 'Unhandled internal server error');
  } else {
    console.error('Unhandled internal server error:', err);
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
      details: {},
    },
  });
}
