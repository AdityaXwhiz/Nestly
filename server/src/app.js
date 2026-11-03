import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { pingPostgres } from './infrastructure/postgres.js';
import { pingRedis } from './infrastructure/redis.js';

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

export default app;
