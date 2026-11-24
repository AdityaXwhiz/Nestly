import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  resolveRouteTemplate,
  statusClass,
} from '../infrastructure/metrics/index.js';

const EXCLUDED_PATHS = new Set(['/metrics', '/healthz']);

/**
 * Express middleware measuring HTTP request count and duration histogram
 * partitioned by method, route template (req.route.path or UNMATCHED), and status_class.
 * Excludes /metrics and /healthz (Step 13B Change #10).
 */
export function httpMetrics(req, res, next) {
  if (EXCLUDED_PATHS.has(req.path)) {
    return next();
  }

  const startNs = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    const labels = {
      method: req.method,
      route: resolveRouteTemplate(req),
      status_class: statusClass(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });

  next();
}
