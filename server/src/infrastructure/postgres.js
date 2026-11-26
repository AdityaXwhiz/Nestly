import fs from 'node:fs';
import pg from 'pg';
import { env } from '../config/env.js';
import { registerDbPoolMetrics } from './metrics/index.js';

// Parse PostgreSQL int8 (bigint / OID 20) as JavaScript integer numbers
pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

/**
 * Builds pg.Pool configuration from environment settings.
 * Enforces rejectUnauthorized: true whenever DB_SSL is enabled (Change #2).
 */
export function buildPgPoolConfig(envConfig = env) {
  const config = {
    connectionString: envConfig.DATABASE_URL,
    max: envConfig.DB_POOL_MAX,
  };

  if (envConfig.DB_SSL) {
    config.ssl = {
      rejectUnauthorized: true,
    };
    if (envConfig.DB_SSL_CA_PATH) {
      config.ssl.ca = fs.readFileSync(envConfig.DB_SSL_CA_PATH, 'utf8');
    }
  }

  return config;
}

export const pool = new pg.Pool(buildPgPoolConfig(env));

registerDbPoolMetrics(pool);

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
