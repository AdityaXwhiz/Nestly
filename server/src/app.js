import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { authN } from './middleware/authN.js';
import { authZ } from './middleware/authZ.js';
import { errorHandler } from './middleware/errorHandler.js';
import { AppError } from './errors/AppError.js';
import { pingPostgres } from './infrastructure/postgres.js';
import { pingRedis } from './infrastructure/redis.js';

import authRoutes from './modules/auth/routes.js';
import usersRoutes from './modules/users/routes.js';
import propertiesRoutes from './modules/properties/routes.js';
import providersRoutes from './modules/providers/routes.js';
import servicesRoutes from './modules/services/routes.js';
import availabilityRoutes from './modules/availability/routes.js';
import ordersRoutes from './modules/orders/routes.js';
import paymentsRoutes from './modules/payments/routes.js';
import searchRoutes from './modules/search/routes.js';

const app = express();

// --------------- Global middleware ---------------
app.use(helmet());

const allowedOrigins = new Set(env.CORS_ORIGINS);
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  }),
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf-8');
    },
  }),
);
app.use(requestId);
app.use(requestLogger);

// --------------- Health routes ---------------

/** Liveness — is the process alive? */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness — can we serve traffic? (Postgres is required, Redis is optional/degraded) */
app.get('/readyz', async (req, res) => {
  const [pg, rd] = await Promise.all([pingPostgres(), pingRedis()]);

  const status = pg && rd ? 'ok' : 'degraded';
  const code = pg ? 200 : 503;

  const body = { status, postgres: pg, redis: rd };
  req.log.info(body, 'readiness check');
  res.status(code).json(body);
});

// --------------- Domain API Routes ---------------
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/properties', propertiesRoutes);
app.use('/api/v1/properties/:id/availability', availabilityRoutes);
app.use('/api/v1/providers', providersRoutes);
app.use('/api/v1/services', servicesRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/search', searchRoutes);

// --------------- Temporary RBAC Verification Routes ---------------
// TEMPORARY: for proving RBAC (admin only)
app.get('/api/v1/admin/ping', authN, authZ('ADMIN'), (_req, res) => {
  res.json({ message: 'admin pong' });
});

// TEMPORARY: for proving RBAC (host or admin)
app.get('/api/v1/host/ping', authN, authZ('HOST', 'ADMIN'), (_req, res) => {
  res.json({ message: 'host pong' });
});

// --------------- 404 handler ---------------
app.use((_req, _res, next) => {
  next(new AppError('NOT_FOUND', 404, 'Endpoint not found'));
});

// --------------- Global Error Handler ---------------
app.use(errorHandler);

export default app;
