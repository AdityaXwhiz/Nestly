import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runPgMigrations } from 'node-pg-migrate';
import { env } from '../config/env.js';
import { pool } from './postgres.js';
import { setupQueues } from './sqs/setupQueues.js';
import { setupStorage } from './s3/setupStorage.js';
import { ensureAliasesExist } from './opensearch/setupIndices.js';
import { openSearchClient } from './opensearch/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function withRetry(name, fn, maxAttempts = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      console.warn(`[init] ${name} failed on attempt ${attempt}/${maxAttempts} (${err.message}); retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await runPgMigrations({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: 'pgmigrations',
    });
  } finally {
    client.release();
  }
}

/**
 * Runs one-off environment initialization.
 * - local (default): creates local SQS queues + S3 bucket + OpenSearch aliases (if enabled).
 * - aws (INIT_TARGET=aws): runs DB migrations + OpenSearch aliases ONLY when enabled;
 *   never attempts sqs:CreateQueue or s3:CreateBucket (Change #3).
 */
export async function runInit({
  target = env.INIT_TARGET,
  openSearchEnabled = Boolean(env.OPENSEARCH_ENDPOINT),
  migrationsFn = runMigrations,
  setupQueuesFn = setupQueues,
  setupStorageFn = setupStorage,
  ensureAliasesFn = ensureAliasesExist,
  osClient = openSearchClient,
} = {}) {
  console.log(`[init] Running infrastructure initialization (target=${target})...`);

  if (target === 'aws') {
    await withRetry('runMigrations', () => migrationsFn());
    if (openSearchEnabled && osClient) {
      await withRetry('ensureAliasesExist', () => ensureAliasesFn({ client: osClient }));
    } else {
      console.log('[init] OpenSearch disabled; skipping index/alias setup.');
    }
  } else {
    await withRetry('setupQueues', () => setupQueuesFn());
    await withRetry('setupStorage', () => setupStorageFn());
    if (openSearchEnabled && osClient) {
      await withRetry('ensureAliasesExist', () => ensureAliasesFn({ client: osClient }));
    } else {
      console.log('[init] OpenSearch disabled; skipping index/alias setup.');
    }
  }

  if (osClient?.close) {
    await osClient.close().catch(() => {});
  }
  console.log('[init] Infrastructure initialization complete.');
}

if (process.argv[1]?.endsWith('init.js')) {
  runInit()
    .then(() => pool.end().catch(() => {}))
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[init] Initialization failed:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
