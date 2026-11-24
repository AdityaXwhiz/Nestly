/**
 * Creates a reusable graceful shutdown handler for the HTTP server, PG pool, and Redis.
 * Stops accepting new connections, closes idle keep-alive sockets, waits for active
 * in-flight requests to drain, closes DB/Redis connections, and enforces a timeout fallback.
 */
export function createGracefulShutdown({
  server,
  metricsServer = null,
  app,
  pool,
  redis,
  logger,
  timeoutMs = 20000,
  onExit = (code) => process.exit(code),
}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal, timeoutMs }, 'Received shutdown signal; beginning graceful shutdown...');

    if (app?.locals) {
      app.locals.isShuttingDown = true;
    }

    const forceTimer = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out; forcing process exit');
      onExit(1);
    }, timeoutMs);
    forceTimer.unref();

    server.close(async (closeErr) => {
      if (closeErr) {
        logger.error({ err: closeErr }, 'Error closing HTTP server');
      } else {
        logger.info('HTTP server drained in-flight requests and closed');
      }

      try {
        if (metricsServer?.close) {
          await new Promise((resolve) => metricsServer.close(() => resolve()));
          metricsServer.closeIdleConnections?.();
        }
        const cleanupPromises = [];
        if (pool?.end) {
          cleanupPromises.push(pool.end());
        }
        if (redis?.quit && redis.status !== 'end') {
          cleanupPromises.push(redis.quit());
        }
        await Promise.allSettled(cleanupPromises);
        logger.info('PostgreSQL pool and Redis client closed cleanly');
      } catch (err) {
        logger.error({ err }, 'Error closing database/Redis during shutdown');
      } finally {
        clearTimeout(forceTimer);
        onExit(closeErr ? 1 : 0);
      }
    });

    // Immediately close idle keep-alive connections so they do not hold server.close() open,
    // while allowing active in-flight requests to finish cleanly.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  };
}
