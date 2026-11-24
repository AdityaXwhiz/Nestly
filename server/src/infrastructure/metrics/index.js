import promClient from 'prom-client';

export const registry = new promClient.Registry();

promClient.collectDefaultMetrics({
  register: registry,
  prefix: 'nestly_',
  eventLoopMonitoringPrecision: 10,
});

// --------------- HTTP Metrics (API only; excludes /metrics and /healthz per Change #10) ---------------
export const httpRequestsTotal = new promClient.Counter({
  name: 'nestly_http_requests_total',
  help: 'Total HTTP requests partitioned by method, route template, and status class',
  labelNames: ['method', 'route', 'status_class'],
  registers: [registry],
});

export const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'nestly_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// --------------- DB Pool & Dependency Metrics ---------------
export const dbPoolConnections = new promClient.Gauge({
  name: 'nestly_db_pool_connections',
  help: 'PostgreSQL connection pool counts by state (total, idle, waiting)',
  labelNames: ['state'],
  registers: [registry],
});

let registeredPool = null;
export function registerDbPoolMetrics(pool) {
  registeredPool = pool;
}

// Wrap collect hook on dbPoolConnections so scrape reads live pg pool metrics on demand
dbPoolConnections.collect = function collectPoolMetrics() {
  if (!registeredPool) return;
  this.set({ state: 'total' }, registeredPool.totalCount ?? 0);
  this.set({ state: 'idle' }, registeredPool.idleCount ?? 0);
  this.set({ state: 'waiting' }, registeredPool.waitingCount ?? 0);
};

export const cacheOperationsTotal = new promClient.Counter({
  name: 'nestly_cache_operations_total',
  help: 'Cache lookup outcomes partitioned by resource and outcome (hit, miss, bypass)',
  labelNames: ['resource', 'outcome'],
  registers: [registry],
});

export const redisLockOutcomesTotal = new promClient.Counter({
  name: 'nestly_redis_lock_outcomes_total',
  help: 'Redis distributed lock outcomes (acquired, busy, unavailable)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const searchDegradedTotal = new promClient.Counter({
  name: 'nestly_search_degraded_total',
  help: 'Count of catalog searches falling back to Postgres because OpenSearch degraded',
  labelNames: ['target'],
  registers: [registry],
});

// Change #3: probed dependency health gauges (postgres, redis, opensearch, elasticmq, minio)
export const dependencyUp = new promClient.Gauge({
  name: 'nestly_dependency_up',
  help: 'Dependency liveness probe from scheduler collector (1 = up, 0 = down)',
  labelNames: ['dependency'],
  registers: [registry],
});

// --------------- Business Domain Counters ---------------
export const ordersTotal = new promClient.Counter({
  name: 'nestly_orders_total',
  help: 'Order lifecycle transitions (created, held, confirmed, failed)',
  labelNames: ['status'],
  registers: [registry],
});

export const reservationsTotal = new promClient.Counter({
  name: 'nestly_reservations_total',
  help: 'Reservation engine outcomes (held, confirmed, released, expired, conflict)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const paymentsTotal = new promClient.Counter({
  name: 'nestly_payments_total',
  help: 'Payment transitions by status (created, processing, succeeded, failed, refunded, provider_unavailable)',
  labelNames: ['status'],
  registers: [registry],
});

export const paymentIdempotencyReplaysTotal = new promClient.Counter({
  name: 'nestly_payment_idempotency_replays_total',
  help: 'Total idempotency key replays served for payment requests',
  registers: [registry],
});

export const webhookEventsTotal = new promClient.Counter({
  name: 'nestly_webhook_events_total',
  help: 'Webhook event outcomes (processed, duplicate, rejected_signature, rejected_stale)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const sagaOutcomesTotal = new promClient.Counter({
  name: 'nestly_saga_outcomes_total',
  help: 'Saga compensation and recovery outcomes (compensation, recovery)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const refundsIssuedTotal = new promClient.Counter({
  name: 'nestly_refunds_issued_total',
  help: 'Total refunds completed via payment provider',
  registers: [registry],
});

// --------------- Worker & Queue Metrics ---------------
export const workerMessagesReceivedTotal = new promClient.Counter({
  name: 'nestly_worker_messages_received_total',
  help: 'SQS messages received by worker consumers partitioned by queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const workerConsumerFailuresTotal = new promClient.Counter({
  name: 'nestly_worker_consumer_failures_total',
  help: 'SQS consumer processing failures partitioned by queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const workerConsumerDurationSeconds = new promClient.Histogram({
  name: 'nestly_worker_consumer_duration_seconds',
  help: 'SQS consumer message processing duration in seconds',
  labelNames: ['queue'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30],
  registers: [registry],
});

// Change #6: message age at processing start (now - SentTimestamp)
export const workerMessageAgeSeconds = new promClient.Histogram({
  name: 'nestly_worker_message_age_seconds',
  help: 'Age of SQS message in seconds at processing start (now minus SentTimestamp)',
  labelNames: ['queue'],
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const workerSchedulerTickDurationSeconds = new promClient.Histogram({
  name: 'nestly_worker_scheduler_tick_duration_seconds',
  help: 'Duration of worker scheduler ticks in seconds',
  labelNames: ['task'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30],
  registers: [registry],
});

export const workerSchedulerSkippedTotal = new promClient.Counter({
  name: 'nestly_worker_scheduler_skipped_total',
  help: 'Total scheduler ticks skipped due to advisory lock contention',
  labelNames: ['task'],
  registers: [registry],
});

// --------------- Scheduler Periodic Collector Gauges (Change #2: schedulers role only) ---------------
export const outboxUnpublishedCount = new promClient.Gauge({
  name: 'nestly_outbox_unpublished_count',
  help: 'Current number of unpublished rows in outbox table',
  registers: [registry],
});

export const outboxOldestUnpublishedAgeSeconds = new promClient.Gauge({
  name: 'nestly_outbox_oldest_unpublished_age_seconds',
  help: 'Age in seconds of the oldest unpublished row in outbox table',
  registers: [registry],
});

export const sqsQueueDepth = new promClient.Gauge({
  name: 'nestly_sqs_queue_depth',
  help: 'Approximate visible + in-flight messages per primary SQS queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const sqsDlqDepth = new promClient.Gauge({
  name: 'nestly_sqs_dlq_depth',
  help: 'Approximate messages in dead-letter queue per queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const paymentsStuckProcessingCount = new promClient.Gauge({
  name: 'nestly_payments_stuck_processing_count',
  help: 'Number of payments stuck in PROCESSING beyond threshold',
  registers: [registry],
});

export const paymentsStuckOldestAgeSeconds = new promClient.Gauge({
  name: 'nestly_payments_stuck_oldest_age_seconds',
  help: 'Age in seconds of oldest payment currently in PROCESSING beyond threshold',
  registers: [registry],
});

export const sagasStaleNonTerminalCount = new promClient.Gauge({
  name: 'nestly_sagas_stale_non_terminal_count',
  help: 'Count of non-terminal saga instances stale beyond SAGA_STALE_SECONDS',
  registers: [registry],
});

// Pre-initialize bounded status/outcome label sets to 0 so dashboards & alerts have clean series on boot
export function initializeBoundedSeries() {
  for (const status of ['created', 'held', 'confirmed', 'failed']) {
    ordersTotal.inc({ status }, 0);
  }
  for (const outcome of ['held', 'confirmed', 'released', 'expired', 'conflict']) {
    reservationsTotal.inc({ outcome }, 0);
  }
  for (const status of ['created', 'processing', 'succeeded', 'failed', 'refunded', 'provider_unavailable']) {
    paymentsTotal.inc({ status }, 0);
  }
  for (const outcome of ['processed', 'duplicate', 'rejected_signature', 'rejected_stale']) {
    webhookEventsTotal.inc({ outcome }, 0);
  }
  for (const outcome of ['compensation', 'recovery']) {
    sagaOutcomesTotal.inc({ outcome }, 0);
  }
  for (const outcome of ['acquired', 'busy', 'unavailable']) {
    redisLockOutcomesTotal.inc({ outcome }, 0);
  }
  for (const target of ['properties', 'services']) {
    searchDegradedTotal.inc({ target }, 0);
  }
}

initializeBoundedSeries();

/**
 * Helper to resolve route template from Express req without exposing IDs or raw URLs.
 */
export function resolveRouteTemplate(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    const routePath = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
    const full = `${base}${routePath === '/' && base ? '' : routePath}`;
    return full || '/';
  }
  return 'UNMATCHED';
}

export function statusClass(statusCode) {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

export const metrics = {
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  dbPoolConnections,
  cacheOperationsTotal,
  redisLockOutcomesTotal,
  searchDegradedTotal,
  dependencyUp,
  ordersTotal,
  reservationsTotal,
  paymentsTotal,
  paymentIdempotencyReplaysTotal,
  webhookEventsTotal,
  sagaOutcomesTotal,
  refundsIssuedTotal,
  workerMessagesReceivedTotal,
  workerConsumerFailuresTotal,
  workerConsumerDurationSeconds,
  workerMessageAgeSeconds,
  workerSchedulerTickDurationSeconds,
  workerSchedulerSkippedTotal,
  outboxUnpublishedCount,
  outboxOldestUnpublishedAgeSeconds,
  sqsQueueDepth,
  sqsDlqDepth,
  paymentsStuckProcessingCount,
  paymentsStuckOldestAgeSeconds,
  sagasStaleNonTerminalCount,
  registerDbPoolMetrics,
  resolveRouteTemplate,
  statusClass,
};
