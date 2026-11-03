import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
});

/**
 * Executes a function within a database transaction.
 * Begins transaction, passes the client to fn, commits on success,
 * rolls back on error, and always releases the client.
 */
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const db = {
  pool,
  query: (...args) => pool.query(...args),
  withTx,
};

/**
 * Quick connectivity check — runs a trivial query.
 * Resolves true if Postgres is reachable, false otherwise.
 */
export async function pingPostgres() {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
