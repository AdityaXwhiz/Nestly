import { setupQueues } from './sqs/setupQueues.js';
import { setupStorage } from './s3/setupStorage.js';
import { ensureAliasesExist } from './opensearch/setupIndices.js';
import { openSearchClient } from './opensearch/client.js';

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

export async function runInit() {
  console.log('[init] Running infrastructure initialization...');

  await withRetry('setupQueues', () => setupQueues());
  await withRetry('setupStorage', () => setupStorage());
  await withRetry('ensureAliasesExist', () => ensureAliasesExist());

  await openSearchClient.close().catch(() => {});
  console.log('[init] Infrastructure initialization complete.');
}

if (process.argv[1]?.endsWith('init.js')) {
  runInit()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[init] Initialization failed:', err);
      process.exit(1);
    });
}
