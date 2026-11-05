import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

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

const app = express();

// --------------- Global middleware ---------------
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestId);
app.use(requestLogger);

// --------------- Health routes ---------------

/** Liveness — is the process alive? */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness — can we serve traffic? (Postgres + Redis reachable) */
app.get('/readyz', async (req, res) => {
  const [pg, rd] = await Promise.all([pingPostgres(), pingRedis()]);

  const status = pg && rd ? 'ok' : 'degraded';
  const code = pg && rd ? 200 : 503;

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
