import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { usersService } from '../users/service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';

const BCRYPT_SALT_ROUNDS = 10;

// Precomputed bcrypt hash used for timing attack protection when email is not found
const DUMMY_HASH = '$2b$10$EpaqMiYIv5k10CgLli1XruVdMoocCe0akHa.Oo45U7AGzW58m6YR6';

export const authService = {
  /**
   * Register a new user with CUSTOMER, HOST, or PROVIDER role.
   */
  async register({ email, password, role }) {
    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await usersService.getUserForAuth(normalizedEmail);
    if (existingUser) {
      throw new AppError('EMAIL_TAKEN', 409, 'Email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    const user = await usersService.createUser({
      email: normalizedEmail,
      role,
      passwordHash,
    });

    return user;
  },

  /**
   * Authenticate credentials and return a short-lived access JWT.
   * Constant-time response is preserved against non-existent emails.
   */
  async login({ email, password }) {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await usersService.getUserForAuth(normalizedEmail);

    if (!user) {
      // Execute bcrypt compare against dummy hash to match execution time and prevent enumeration
      await bcrypt.compare(password, DUMMY_HASH);
      throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password');
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password');
    }

    const payload = {
      sub: user.id,
      role: user.role,
    };

    const accessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_TTL,
      audience: env.JWT_AUDIENCE,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: env.JWT_TTL,
    };
  },

  /**
   * Fetch current user profile without password_hash.
   */
  async getMe(userId) {
    return usersService.getUserById(userId);
  },

  /**
   * Verify and decode a JWT access token.
   */
  verifyToken(token) {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      audience: env.JWT_AUDIENCE,
    });
  },
};
