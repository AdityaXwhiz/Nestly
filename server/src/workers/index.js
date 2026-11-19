import { withTx, pool } from '../infrastructure/postgres.js';
import { publishOutbox } from '../modules/outbox/publisher.js';
import { outboxRepository } from '../modules/outbox/repository.js';
import { sagaOrchestrator } from '../modules/orders/saga.js';
import { reservationsService } from '../modules/reservations/service.js';
import { paymentsService } from '../modules/payments/service.js';
import { notificationsService } from '../modules/notifications/service.js';
import { propertyImagesService } from '../modules/properties/imagesService.js';
import { monitorDlqs } from '../infrastructure/sqs/dlqTool.js';
import { createNotificationConsumer } from './consumers/notificationConsumer.js';
import { createProviderActionConsumer } from './consumers/providerActionConsumer.js';
import { createAnalyticsConsumer } from './consumers/analyticsConsumer.js';
import { createSearchIndexConsumer } from './consumers/searchIndexConsumer.js';
import { ensureAliasesExist } from '../infrastructure/opensearch/setupIndices.js';
import { logger } from '../middleware/requestLogger.js';
import { env } from '../config/env.js';

// Advisory lock constants for single-runner scheduler ticks
export const ADVISORY_LOCK_OUTBOX = 1001;
export const ADVISORY_LOCK_SAGA_RECOVERY = 1002;
export const ADVISORY_LOCK_HOLD_SWEEPER = 1003;
export const ADVISORY_LOCK_PAYMENT_RECONCILER = 1004;
export const ADVISORY_LOCK_CLEANUP = 1005;
export const ADVISORY_LOCK_NOTIFICATION_RETRY = 1006;
export const ADVISORY_LOCK_DLQ_MONITOR = 1007;

/**
 * Execute a scheduler tick protected by a transaction-level advisory lock.
 * - For DB-only schedulers (hold sweeper, cleanup), taskFn receives and performs
 *   its work directly on `tx` (the lock's transaction client).
 * - For network-calling schedulers (payment reconciler, saga recovery), the
 *   advisory-lock transaction acts ONLY as a mutex: no writes are performed on `tx`,
 *   batches are small, and ticks enforce a max duration (Change #4).
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

/**
 * 1. Outbox publisher tick (role: publisher)
 */
export async function runOutboxTick(client = null) {
  if (client) {
    return publishOutbox({ client });
  }
  return runSchedulerTick(ADVISORY_LOCK_OUTBOX, 'outbox_publisher', (tx) =>
    publishOutbox({ client: tx }),
  );
}

/**
 * 2. Saga crash recovery tick (role: schedulers)
 * Advisory-lock transaction is used only as a mutex (no writes on mutex tx).
 */
export async function runSagaRecoveryTick(client = null) {
  if (client) {
    return sagaOrchestrator.recoverSagas();
  }
  return runSchedulerTick(ADVISORY_LOCK_SAGA_RECOVERY, 'saga_recovery', async () => {
    return sagaOrchestrator.recoverSagas();
  });
}

/**
 * 3. Hold sweeper tick (role: schedulers, every ~30s)
 * DB-only scheduler: executes directly on the lock's client `tx` in batches of 200 (Change #4 & #5).
 */
export async function runHoldSweeperTick({ batchSize = 200 } = {}, client = null) {
  if (client) {
    return reservationsService.sweepExpiredHolds({ batchSize }, client);
  }
  return runSchedulerTick(ADVISORY_LOCK_HOLD_SWEEPER, 'hold_sweeper', (tx) =>
    reservationsService.sweepExpiredHolds({ batchSize }, tx),
  );
}

/**
 * 4. Payment reconciler tick (role: schedulers)
 * Network-calling scheduler: advisory-lock transaction is ONLY a mutex (no writes on mutex tx),
 * small batches, and a max time per tick (Change #4).
 */
export async function runPaymentReconcilerTick({
  olderThanSeconds = 30,
  batchSize = 10,
  maxDurationMs = 8000,
} = {}) {
  return runSchedulerTick(ADVISORY_LOCK_PAYMENT_RECONCILER, 'payment_reconciler', async () => {
    return paymentsService.reconcileStuckPayments({
      olderThanSeconds,
      batchSize,
      maxDurationMs,
    });
  });
}

/**
 * 5. Notification retry tick (role: schedulers, Change #1)
 * Retries notifications stuck in PENDING for over N minutes.
 * Advisory lock used as mutex.
 */
export async function runNotificationRetryTick({
  olderThanMinutes = env.NOTIFICATION_RETRY_MINUTES,
  limit = 50,
} = {}) {
  return runSchedulerTick(ADVISORY_LOCK_NOTIFICATION_RETRY, 'notification_retry', async () => {
    return notificationsService.retryPendingNotifications({
      olderThanMinutes,
      limit,
    });
  });
}

/**
 * 6. Cleanup tick (role: schedulers)
 * Deletes expired idempotency_keys, old published outbox rows,
 * and sweeps orphaned PENDING images older than 24 hours (S3 object + DB row).
 */
export async function runCleanupTick(
  {
    retentionDays = env.OUTBOX_RETENTION_DAYS,
    orphanedImageHours = 24,
  } = {},
  client = null,
) {
  const executeCleanup = async (tx) => {
    const expiredKeysDeleted = await paymentsService.deleteExpiredIdempotencyKeys(tx);
    const oldOutboxDeleted = await outboxRepository.deleteOldPublished(retentionDays, tx);
    const orphanedImagesDeleted = await propertyImagesService.sweepOrphanedPendingImages({
      olderThanHours: orphanedImageHours,
    });
    return {
      expiredKeysDeleted,
      oldOutboxDeleted,
      orphanedImagesDeleted,
    };
  };

  if (client) {
    return executeCleanup(client);
  }
  return runSchedulerTick(ADVISORY_LOCK_CLEANUP, 'cleanup', (tx) => executeCleanup(tx));
}

/**
 * 7. DLQ monitor tick (role: schedulers)
 * Logs a WARNING whenever any DLQ depth > 0 or oldest message is too old.
 */
export async function runDlqMonitorTick({ maxAgeSeconds = 300 } = {}) {
  return runSchedulerTick(ADVISORY_LOCK_DLQ_MONITOR, 'dlq_monitor', async () => {
    return monitorDlqs({ maxAgeSeconds });
  });
}

/**
 * Parse WORKER_ROLES env or array into a normalized Set of enabled role names.
 * Valid roles: publisher, schedulers, notification, provider-actions, analytics
 */
export function parseWorkerRoles(rolesInput = env.WORKER_ROLES) {
  if (Array.isArray(rolesInput)) {
    return new Set(rolesInput.map((r) => r.trim().toLowerCase()).filter(Boolean));
  }
  return new Set(
    String(rolesInput)
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Start the worker process with configurable roles (Requirement 7).
 */
export function startWorker({
  roles = env.WORKER_ROLES,
  outboxIntervalMs = 5000,
  sagaIntervalMs = 60000,
  holdSweeperIntervalMs = 30000,
  reconcilerIntervalMs = 30000,
  notificationRetryIntervalMs = 60000,
  cleanupIntervalMs = 300000,
  dlqMonitorIntervalMs = 60000,
  consumerOptions = {},
  closePoolOnStop = false,
} = {}) {
  const enabledRoles = parseWorkerRoles(roles);
  const intervals = [];
  const consumers = [];

  logger.info(
    { roles: [...enabledRoles] },
    '🚀 Nestly Worker starting up with enabled roles...',
  );

  // Role 1: Outbox Publisher
  if (enabledRoles.has('publisher')) {
    runOutboxTick().catch((err) => logger.error({ err: err.message }, 'Outbox tick error'));
    intervals.push(
      setInterval(() => {
        runOutboxTick().catch((err) => logger.error({ err: err.message }, 'Outbox tick error'));
      }, outboxIntervalMs),
    );
  }

  // Role 2: Schedulers (saga recovery, hold sweeper, payment reconciler, notification retry, cleanup, DLQ monitor)
  if (enabledRoles.has('schedulers')) {
    runSagaRecoveryTick().catch((err) =>
      logger.error({ err: err.message }, 'Saga recovery tick error'),
    );
    runHoldSweeperTick().catch((err) =>
      logger.error({ err: err.message }, 'Hold sweeper tick error'),
    );
    runPaymentReconcilerTick().catch((err) =>
      logger.error({ err: err.message }, 'Payment reconciler tick error'),
    );
    runNotificationRetryTick().catch((err) =>
      logger.error({ err: err.message }, 'Notification retry tick error'),
    );
    runCleanupTick().catch((err) => logger.error({ err: err.message }, 'Cleanup tick error'));
    runDlqMonitorTick().catch((err) =>
      logger.error({ err: err.message }, 'DLQ monitor tick error'),
    );

    intervals.push(
      setInterval(() => {
        runSagaRecoveryTick().catch((err) =>
          logger.error({ err: err.message }, 'Saga recovery tick error'),
        );
      }, sagaIntervalMs),
    );

    intervals.push(
      setInterval(() => {
        runHoldSweeperTick().catch((err) =>
          logger.error({ err: err.message }, 'Hold sweeper tick error'),
        );
      }, holdSweeperIntervalMs),
    );

    intervals.push(
      setInterval(() => {
        runPaymentReconcilerTick().catch((err) =>
          logger.error({ err: err.message }, 'Payment reconciler tick error'),
        );
      }, reconcilerIntervalMs),
    );

    intervals.push(
      setInterval(() => {
        runNotificationRetryTick().catch((err) =>
          logger.error({ err: err.message }, 'Notification retry tick error'),
        );
      }, notificationRetryIntervalMs),
    );

    intervals.push(
      setInterval(() => {
        runCleanupTick().catch((err) => logger.error({ err: err.message }, 'Cleanup tick error'));
      }, cleanupIntervalMs),
    );

    intervals.push(
      setInterval(() => {
        runDlqMonitorTick().catch((err) =>
          logger.error({ err: err.message }, 'DLQ monitor tick error'),
        );
      }, dlqMonitorIntervalMs),
    );
  }

  // Role 3: Notification Consumer
  if (enabledRoles.has('notification') || enabledRoles.has('notifications')) {
    const notifConsumer = createNotificationConsumer(consumerOptions);
    notifConsumer.start();
    consumers.push(notifConsumer);
  }

  // Role 4: Provider-Actions Consumer
  if (enabledRoles.has('provider-actions')) {
    const providerConsumer = createProviderActionConsumer(consumerOptions);
    providerConsumer.start();
    consumers.push(providerConsumer);
  }

  // Role 5: Analytics Consumer
  if (enabledRoles.has('analytics')) {
    const analyticsConsumer = createAnalyticsConsumer(consumerOptions);
    analyticsConsumer.start();
    consumers.push(analyticsConsumer);
  }

  // Role 6: Search-Index Consumer
  if (enabledRoles.has('search-index')) {
    ensureAliasesExist().catch((err) =>
      logger.warn({ err: err.message }, 'Failed to ensure OpenSearch aliases on worker start'),
    );
    const searchConsumer = createSearchIndexConsumer(consumerOptions);
    searchConsumer.start();
    consumers.push(searchConsumer);
  }

  let stopped = false;

  const stop = async ({ exitProcess = false } = {}) => {
    if (stopped) return;
    stopped = true;
    logger.info('Shutting down Nestly Worker...');

    for (const timer of intervals) {
      clearInterval(timer);
    }

    await Promise.allSettled(consumers.map((c) => c.stop()));

    if (closePoolOnStop || exitProcess) {
      await pool.end().catch(() => {});
    }
    if (exitProcess) {
      process.exit(0);
    }
  };

  const onSignal = () => stop({ exitProcess: true });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    stop: async () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await stop({ exitProcess: false });
    },
    roles: [...enabledRoles],
    consumers,
  };
}

// Auto-run when executed directly (node src/workers/index.js)
if (process.argv[1] && process.argv[1].endsWith('workers/index.js')) {
  startWorker({ closePoolOnStop: true });
}
