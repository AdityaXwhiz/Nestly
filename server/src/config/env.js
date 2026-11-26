import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the repo root (one level above server/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const emptyToUndefined = (val) =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

const disabledOrUrl = (val) => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed || ['disabled', 'none', 'false'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
};

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default('3000'),

  API_METRICS_PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default('9100'),

  WORKER_METRICS_PORT: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default('9101'),

  TRUST_PROXY: z
    .string()
    .default('false'),

  ENABLE_TEST_HOOKS: z
    .string()
    .optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
      'Must be a postgresql:// or postgres:// connection string',
    ),

  DB_SSL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
  ),

  DB_SSL_CA_PATH: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),

  DB_POOL_MAX: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('10'),

  REDIS_URL: z
    .string()
    .url()
    .refine(
      (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
      'Must be a redis:// or rediss:// connection string',
    ),

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

  PAYMENT_PROVIDER: z
    .enum(['mock', 'stripe', 'razorpay'])
    .optional(),

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
    .default('publisher,schedulers,notification,provider-actions,analytics,search-index'),

  OUTBOX_RETENTION_DAYS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('7'),

  OUTBOX_BATCH_SIZE: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive().max(500))
    .default('100'),

  OUTBOX_POLL_INTERVAL_MS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(250).max(60000))
    .default('1000'),

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

  SQS_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  AWS_ACCESS_KEY_ID: z.preprocess(
    emptyToUndefined,
    z.string().optional(),
  ),

  AWS_SECRET_ACCESS_KEY: z.preprocess(
    emptyToUndefined,
    z.string().optional(),
  ),

  INIT_TARGET: z.preprocess(
    emptyToUndefined,
    z.enum(['local', 'aws']).default('local'),
  ),

  SQS_QUEUE_URL_NOTIFICATIONS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/notifications'),

  SQS_QUEUE_URL_NOTIFICATIONS_DLQ: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  SQS_QUEUE_URL_PROVIDER_ACTIONS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/provider-actions'),

  SQS_QUEUE_URL_PROVIDER_ACTIONS_DLQ: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  SQS_QUEUE_URL_ANALYTICS: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/analytics'),

  SQS_QUEUE_URL_ANALYTICS_DLQ: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  SQS_QUEUE_URL_SEARCH_INDEX: z
    .string()
    .url()
    .default('http://localhost:9324/000000000000/search-index'),

  SQS_QUEUE_URL_SEARCH_INDEX_DLQ: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  // S3 / MinIO (media storage)
  S3_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  // Browser-facing S3 endpoint used strictly for generating presigned PUT URLs (Change #1)
  S3_PUBLIC_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),

  S3_BUCKET: z
    .string()
    .default('nestly-media'),

  S3_FORCE_PATH_STYLE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('true')
      .transform((v) => v === 'true' || v === '1'),
  ),

  MEDIA_PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:9000/nestly-media'),

  // OpenSearch (catalog search — optional/disabled in AWS when using Postgres full-text search)
  OPENSEARCH_ENDPOINT: z.preprocess(
    disabledOrUrl,
    z.string().url().nullable().optional(),
  ),

  OPENSEARCH_INDEX_PREFIX: z
    .string()
    .default('nestly'),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production') {
    const isWeakSecret = (val) => {
      const lower = val.toLowerCase();
      const forbiddenTokens = ['replace_with', 'development', 'changeme', 'nestly_dev', 'default', 'example', 'secret'];
      if (forbiddenTokens.some((token) => lower.includes(token))) return true;
      if (new Set(val).size < 8) return true;
      return false;
    };

    if (isWeakSecret(data.JWT_ACCESS_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Refusing to start in production with weak or default JWT_ACCESS_SECRET',
      });
    }

    if (isWeakSecret(data.PAYMENT_WEBHOOK_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_WEBHOOK_SECRET'],
        message: 'Refusing to start in production with weak or default PAYMENT_WEBHOOK_SECRET',
      });
    }

    if (data.JWT_ACCESS_SECRET === data.PAYMENT_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_WEBHOOK_SECRET'],
        message: 'JWT_ACCESS_SECRET and PAYMENT_WEBHOOK_SECRET must be distinct in production',
      });
    }

    if (data.ENABLE_TEST_HOOKS === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENABLE_TEST_HOOKS'],
        message: 'Refusing to start in production with ENABLE_TEST_HOOKS enabled',
      });
    }

    if (!data.PAYMENT_PROVIDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'PAYMENT_PROVIDER must be explicitly configured in production (set PAYMENT_PROVIDER=mock explicitly if running local prod stack)',
      });
    }

    if ((data.SQS_ENDPOINT || data.S3_ENDPOINT) && (!data.AWS_ACCESS_KEY_ID || !data.AWS_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_ACCESS_KEY_ID'],
        message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be explicitly provided when SQS_ENDPOINT or S3_ENDPOINT is set in production',
      });
    }
  }
}).transform((data) => ({
  ...data,
  PAYMENT_PROVIDER: data.PAYMENT_PROVIDER || 'mock',
  S3_PUBLIC_ENDPOINT: data.S3_PUBLIC_ENDPOINT || data.S3_ENDPOINT,
  OPENSEARCH_ENDPOINT:
    data.OPENSEARCH_ENDPOINT !== undefined
      ? data.OPENSEARCH_ENDPOINT
      : data.NODE_ENV === 'production'
        ? null
        : 'http://localhost:9200',
  // AWS key defaults apply ONLY in non-production when SQS_ENDPOINT or S3_ENDPOINT is set
  AWS_ACCESS_KEY_ID:
    data.AWS_ACCESS_KEY_ID ||
    (data.NODE_ENV !== 'production' && (data.SQS_ENDPOINT || data.S3_ENDPOINT) ? 'nestly_local_key' : undefined),
  AWS_SECRET_ACCESS_KEY:
    data.AWS_SECRET_ACCESS_KEY ||
    (data.NODE_ENV !== 'production' && (data.SQS_ENDPOINT || data.S3_ENDPOINT) ? 'nestly_local_secret' : undefined),
}));

export function parseEnv(rawEnv = process.env) {
  return envSchema.safeParse(rawEnv);
}

const result = parseEnv(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:');
  console.error(result.error.format());
  process.exit(1);
}

export const env = Object.freeze(result.data);
