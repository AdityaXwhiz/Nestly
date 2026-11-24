import app from './app.js';
import { env } from './config/env.js';
import { logger } from './middleware/requestLogger.js';
import { pool } from './infrastructure/postgres.js';
import { redis } from './infrastructure/redis.js';
import { ensureAliasesExist } from './infrastructure/opensearch/setupIndices.js';
import { startMetricsServer } from './infrastructure/metrics/server.js';
import { createGracefulShutdown } from './shutdown.js';

// Connect Redis eagerly so readyz reflects actual state.
await redis.connect();

// Ensure OpenSearch aliases exist (safe against concurrent startup)
ensureAliasesExist().catch((err) => {
  logger.warn({ err: err.message }, 'Could not ensure OpenSearch aliases on startup; will retry on demand');
});

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, trustProxy: env.TRUST_PROXY },
    '🚀 Nestly server listening',
  );
});

// Separate internal-only HTTP port for Prometheus /metrics scraping (Step 13B Change #1)
const metricsServer = startMetricsServer({
  port: env.API_METRICS_PORT,
  label: 'api',
});

// --------------- Graceful shutdown (20s timeout, Change #3) ---------------
const shutdown = createGracefulShutdown({
  server,
  metricsServer,
  app,
  pool,
  redis,
  logger,
  timeoutMs: 20000,
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
