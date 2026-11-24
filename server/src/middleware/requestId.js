import crypto from 'node:crypto';
import { requestContext } from './requestLogger.js';

const VALID_REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Sanitize caller-supplied X-Request-Id header (Change #7).
 * Accepts only [A-Za-z0-9._-]{8,64}; otherwise generates a fresh UUID.
 */
export function sanitizeRequestId(rawHeader) {
  if (typeof rawHeader === 'string' && VALID_REQUEST_ID_REGEX.test(rawHeader)) {
    return rawHeader;
  }
  return crypto.randomUUID();
}

/**
 * Middleware: sanitize or generate X-Request-Id, bind to req.id & AsyncLocalStorage,
 * and echo it back in the X-Request-Id response header.
 */
export function requestId(req, res, next) {
  const id = sanitizeRequestId(req.headers['x-request-id']);
  req.id = id;
  res.setHeader('x-request-id', id);

  requestContext.run({ requestId: id, originRequestId: null }, () => {
    next();
  });
}
