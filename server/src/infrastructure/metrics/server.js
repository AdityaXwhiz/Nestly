import http from 'node:http';
import { registry } from './index.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Starts a dedicated, internal-only HTTP metrics server serving GET /metrics.
 * Used by both the API process (API_METRICS_PORT, unpublished) and worker processes
 * (WORKER_METRICS_PORT, unpublished) per Step 13B Change #1.
 */
export function startMetricsServer({ port, host = '0.0.0.0', label = 'process' } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        res.statusCode = 200;
        res.setHeader('Content-Type', registry.contentType);
        res.end(await registry.metrics());
      } catch (err) {
        logger.error({ err: err.message, label }, 'Failed to serialize Prometheus metrics');
        res.statusCode = 500;
        res.end('Metrics collection error');
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  server.listen(port, host, () => {
    logger.info({ port, host, label }, 'Prometheus metrics server listening');
  });

  return server;
}
