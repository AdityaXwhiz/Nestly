import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
});

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
