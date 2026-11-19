import app from './app.js';
import { env } from './config/env.js';
import { logger } from './middleware/requestLogger.js';
import { redis } from './infrastructure/redis.js';
import { ensureAliasesExist } from './infrastructure/opensearch/setupIndices.js';

// Connect Redis eagerly so readyz reflects actual state.
await redis.connect();

// Ensure OpenSearch aliases exist (Change #8: safe against concurrent startup)
ensureAliasesExist().catch((err) => {
  logger.warn({ err: err.message }, 'Could not ensure OpenSearch aliases on startup; will retry on demand');
});

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    '🚀 Nestly server listening',
  );
});

// --------------- Graceful shutdown ---------------
const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutting down…');
  server.close(async () => {
    await redis.quit().catch(() => {});
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
