import crypto from 'node:crypto';

/**
 * Middleware: accept X-Request-Id from the caller or generate a new UUID.
 * Stores it on req.id and echoes it back in the response header.
 */
export function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}
