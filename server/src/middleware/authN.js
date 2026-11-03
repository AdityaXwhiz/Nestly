import jwt from 'jsonwebtoken';
import { authService } from '../modules/auth/service.js';
import { AppError } from '../errors/AppError.js';

/**
 * Authentication middleware (AuthN).
 * Verifies JWT signature, expiry, audience, and algorithm.
 * Attaches { id, role } to req.user.
 */
export function authN(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError('UNAUTHORIZED', 401, 'Authentication token required'),
    );
  }

  const token = authHeader.slice(7).trim();

  try {
    const decoded = authService.verifyToken(token);
    req.user = {
      id: decoded.sub,
      role: decoded.role,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError('TOKEN_EXPIRED', 401, 'Token has expired'));
    }
    return next(new AppError('INVALID_TOKEN', 401, 'Invalid authentication token'));
  }
}
