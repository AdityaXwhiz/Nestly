import { usersRepository } from './repository.js';
import { AppError } from '../../errors/AppError.js';

export const usersService = {
  /**
   * Create a new user record in the database.
   */
  async createUser({ email, role, passwordHash }) {
    const normalizedEmail = email.trim().toLowerCase();
    return usersRepository.createUser({
      email: normalizedEmail,
      role,
      passwordHash,
    });
  },

  /**
   * Find a user by ID (safe for external consumption, excludes password_hash).
   */
  async getUserById(id) {
    const user = await usersRepository.findById(id);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 404, 'User not found');
    }
    return user;
  },

  /**
   * Find a user by email for authentication (internal use only, includes password_hash).
   */
  async getUserForAuth(email) {
    const normalizedEmail = email.trim().toLowerCase();
    return usersRepository.findByEmail(normalizedEmail);
  },

  /**
   * Get the role of a given user ID (LLD section 2 contract).
   */
  async roleOf(id) {
    const user = await this.getUserById(id);
    return user.role;
  },

  /**
   * Delete a user by ID (for cleanup).
   */
  async deleteUser(id) {
    return usersRepository.deleteById(id);
  },
};
