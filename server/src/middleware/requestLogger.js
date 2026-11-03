import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({ level: env.LOG_LEVEL });

/**
 * Middleware: structured request/response logging via pino.
 * Binds a child logger with the request ID to req.log.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  req.log = logger.child({ reqId: req.id });

  res.on('finish', () => {
    const duration = Date.now() - start;
    req.log.info(
      {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      'request completed',
    );
  });

  next();
}
