import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the repo root (one level above server/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default('3000'),

  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://', 'Must be a postgresql:// connection string'),

  DB_POOL_MAX: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('10'),

  REDIS_URL: z
    .string()
    .url()
    .startsWith('redis://', 'Must be a redis:// connection string'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),

  JWT_TTL: z
    .string()
    .default('15m'),

  JWT_AUDIENCE: z
    .string()
    .default('nestly-api'),

  RATE_LIMIT_AUTH_MAX: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('10'),

  RATE_LIMIT_AUTH_WINDOW_SEC: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('60'),

  HOLD_TTL_SECONDS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('600'),

  PAYMENT_WEBHOOK_SECRET: z
    .string()
    .min(32, 'PAYMENT_WEBHOOK_SECRET must be at least 32 characters'),

  PAYMENT_PROVIDER_URL: z
    .string()
    .url()
    .default('http://localhost:3001'),

  PAYMENT_MIN_HOLD_SECONDS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().nonnegative())
    .default('60'),

  SAGA_STALE_SECONDS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('60'),

  WORKER_ROLES: z
    .string()
    .default('publisher,schedulers,notification,provider-actions,analytics'),

  OUTBOX_RETENTION_DAYS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('7'),

  NOTIFICATION_RETRY_MINUTES: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('5'),

  PUBLISHER: z
    .enum(['sqs', 'log', 'memory'])
    .default('log'),

  AWS_REGION: z
    .string()
    .default('us-east-1'),

  SQS_ENDPOINT: z
    .string()
    .url()
    .optional(),

  AWS_ACCESS_KEY_ID: z
    .string()
    .optional(),

  AWS_SECRET_ACCESS_KEY: z
    .string()
    .optional(),

  SQS_QUEUE_URL_NOTIFICATIONS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/notifications'),

  SQS_QUEUE_URL_PROVIDER_ACTIONS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/provider-actions'),

  SQS_QUEUE_URL_ANALYTICS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/analytics'),

  SQS_QUEUE_URL_SEARCH_INDEX: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/search-index'),
}).transform((data) => ({
  ...data,
  // AWS key defaults apply ONLY when SQS_ENDPOINT is set (local ElasticMQ)
  AWS_ACCESS_KEY_ID:
    data.AWS_ACCESS_KEY_ID || (data.SQS_ENDPOINT ? 'nestly_local_key' : undefined),
  AWS_SECRET_ACCESS_KEY:
    data.AWS_SECRET_ACCESS_KEY || (data.SQS_ENDPOINT ? 'nestly_local_secret' : undefined),
}));

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:');
  console.error(result.error.format());
  process.exit(1);
}

export const env = Object.freeze(result.data);
