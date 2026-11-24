import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';
import pino from 'pino';
import { env } from '../config/env.js';

export const requestContext = new AsyncLocalStorage();

const logSinks = new Set();

export function addLogSink(fn) {
  logSinks.add(fn);
}

export function removeLogSink(fn) {
  logSinks.delete(fn);
}

export function getRequestId() {
  return requestContext.getStore()?.requestId || null;
}

export function getOriginRequestId() {
  return requestContext.getStore()?.originRequestId || null;
}

export function setOriginRequestId(originRequestId) {
  const store = requestContext.getStore();
  if (store && originRequestId) {
    store.originRequestId = originRequestId;
  }
}

export function runWithRequestContext({ requestId = null, originRequestId = null }, fn) {
  const current = requestContext.getStore();
  const nextStore = {
    requestId: requestId ?? current?.requestId ?? null,
    originRequestId: originRequestId ?? current?.originRequestId ?? null,
  };
  return requestContext.run(nextStore, fn);
}

const destinationStream = new Writable({
  write(chunk, _encoding, callback) {
    const str = chunk.toString();
    process.stdout.write(str);
    if (logSinks.size > 0) {
      try {
        const parsed = JSON.parse(str);
        for (const sink of logSinks) {
          sink(parsed);
        }
      } catch {
        // ignore non-JSON chunks
      }
    }
    callback();
  },
});

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    mixin() {
      const store = requestContext.getStore();
      if (!store) return {};
      const out = {};
      if (store.requestId) out.reqId = store.requestId;
      if (store.originRequestId) out.origin_request_id = store.originRequestId;
      return out;
    },
  },
  destinationStream,
);

/**
 * Middleware: structured request/response logging via pino.
 * Excludes noisy /healthz and /metrics endpoints? No, logs normal API calls with reqId.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const storeSnapshot = {
    requestId: req.id,
    originRequestId: getOriginRequestId(),
  };

  req.log = logger;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const latestOrigin = getOriginRequestId() || storeSnapshot.originRequestId || res.locals?.originRequestId || null;
    runWithRequestContext({ requestId: req.id, originRequestId: latestOrigin }, () => {
      req.log.info(
        {
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: duration,
        },
        'request completed',
      );
    });
  });

  next();
}
