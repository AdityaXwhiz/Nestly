import { db } from '../../infrastructure/postgres.js';

/**
 * Users repository: parameterized SQL only.
 * Accepts an optional db client to participate in transactions.
 */
export const usersRepository = {
  /**
   * Insert a new user record.
   * Returns the user row without password_hash.
   */
  async createUser({ email, role, passwordHash }, client = db) {
    const query = `
      INSERT INTO users (email, role, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, email, role, created_at, updated_at
    `;
    const result = await client.query(query, [email, role, passwordHash]);
    return result.rows[0];
  },

  /**
   * Find a user by email, including password_hash for authentication.
   */
  async findByEmail(email, client = db) {
    const query = `
      SELECT id, email, role, password_hash, created_at, updated_at
      FROM users
      WHERE email = $1
    `;
    const result = await client.query(query, [email]);
    return result.rows[0] || null;
  },

  /**
   * Find a user by ID, excluding password_hash.
   */
  async findById(id, client = db) {
    const query = `
      SELECT id, email, role, created_at, updated_at
      FROM users
      WHERE id = $1
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  /**
   * Delete a user by ID (useful for tests and cleanup).
   */
  async deleteById(id, client = db) {
    const query = `
      DELETE FROM users
      WHERE id = $1
      RETURNING id
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },
};
