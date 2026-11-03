import { AppError } from '../errors/AppError.js';

/**
 * Authorization middleware (AuthZ / RBAC).
 * Checks if the authenticated user's role is permitted.
 *
 * @param {...string} allowedRoles - List of allowed roles (e.g. 'ADMIN', 'HOST')
 */
export function authZ(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user || !req.user.role) {
      return next(
        new AppError('UNAUTHORIZED', 401, 'Authentication token required'),
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError('FORBIDDEN', 403, 'Forbidden: insufficient permissions'),
      );
    }

    next();
  };
}
