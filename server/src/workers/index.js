import { withTx, pool } from '../infrastructure/postgres.js';
import { publishOutbox } from '../modules/outbox/publisher.js';
import { sagaOrchestrator } from '../modules/orders/saga.js';
import { logger } from '../middleware/requestLogger.js';
import { env } from '../config/env.js';

// Advisory lock constants for single-runner scheduler ticks
export const ADVISORY_LOCK_OUTBOX = 1001;
export const ADVISORY_LOCK_SAGA_RECOVERY = 1002;

/**
 * Execute a scheduler tick protected by a transaction-level advisory lock.
 * Change #7: Runs as ONE transaction — acquires pg_try_advisory_xact_lock first,
 * then executes the work using the exact same transaction client.
 */
export async function runSchedulerTick(lockId, taskName, taskFn) {
  return withTx(async (tx) => {
    const res = await tx.query('SELECT pg_try_advisory_xact_lock($1) AS locked;', [lockId]);
    const acquired = res.rows[0]?.locked;

    if (!acquired) {
      logger.debug({ taskName }, 'Advisory lock busy; tick skipped by this worker');
      return { skipped: true, reason: 'LOCK_BUSY' };
    }

    const result = await taskFn(tx);
    return { skipped: false, result };
  });
}

export async function runOutboxTick(client = null) {
  if (client) {
    return publishOutbox({ client });
  }
  return runSchedulerTick(ADVISORY_LOCK_OUTBOX, 'outbox_publisher', (tx) =>
    publishOutbox({ client: tx }),
  );
}

export async function runSagaRecoveryTick(client = null) {
  if (client) {
    return sagaOrchestrator.recoverSagas();
  }
  return runSchedulerTick(ADVISORY_LOCK_SAGA_RECOVERY, 'saga_recovery', async (tx) => {
    return sagaOrchestrator.recoverSagas();
  });
}

let outboxInterval = null;
let sagaInterval = null;

export function startWorker({
  outboxIntervalMs = 5000,
  sagaIntervalMs = 60000,
} = {}) {
  logger.info('🚀 Nestly Worker starting up (outbox publisher & saga recovery)...');

  // Immediate initial run
  runOutboxTick().catch((err) => logger.error({ err: err.message }, 'Outbox tick error'));
  runSagaRecoveryTick().catch((err) => logger.error({ err: err.message }, 'Saga recovery tick error'));

  outboxInterval = setInterval(() => {
    runOutboxTick().catch((err) => logger.error({ err: err.message }, 'Outbox tick error'));
  }, outboxIntervalMs);

  sagaInterval = setInterval(() => {
    runSagaRecoveryTick().catch((err) => logger.error({ err: err.message }, 'Saga recovery tick error'));
  }, sagaIntervalMs);

  const shutdown = async () => {
    logger.info('Shutting down Nestly Worker...');
    if (outboxInterval) clearInterval(outboxInterval);
    if (sagaInterval) clearInterval(sagaInterval);
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { stop: shutdown };
}

// Auto-run when executed directly (node src/workers/index.js)
if (process.argv[1] && process.argv[1].endsWith('workers/index.js')) {
  startWorker();
}
