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
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:');
  console.error(result.error.format());
  process.exit(1);
}

export const env = Object.freeze(result.data);
