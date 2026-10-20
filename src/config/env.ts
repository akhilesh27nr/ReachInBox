import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const DEFAULT_DEV_SESSION_SECRET = 'reachinbox-scheduler-super-secret-key-32-chars-minimum';
export const DEFAULT_DEV_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const DEFAULT_DEV_BULL_PASS = 'admin123';

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce
    .number()
    .int()
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),
  APP_URL: z.string().optional().default(''),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL').default('http://localhost:3000'),
  BACKEND_URL: z.string().url('BACKEND_URL must be a valid URL').default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters').default(DEFAULT_DEV_SESSION_SECRET),
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters').default(DEFAULT_DEV_ENCRYPTION_KEY),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (val) =>
        val.startsWith('postgresql://') ||
        val.startsWith('postgres://') ||
        val.startsWith('file:'),
      'DATABASE_URL must start with postgresql://, postgres://, or file:'
    )
    .default('postgresql://reachinbox:reachinbox@localhost:5432/reachinbox'),

  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (val) => val.startsWith('redis://') || val.startsWith('rediss://'),
      'REDIS_URL must start with redis:// or rediss://'
    )
    .default('redis://127.0.0.1:6379'),

  ELASTICSEARCH_URL: z
    .string()
    .url('ELASTICSEARCH_URL must be a valid HTTP/HTTPS URL')
    .default('http://localhost:9200'),
  ES_EMAILS_INDEX: z.string().min(1).default('emails'),

  QUEUE_NAME: z.string().min(1).default('email-send'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  RATE_LIMIT_LOOKAHEAD_WINDOWS: z.coerce.number().int().min(1).max(168).default(72),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  STALE_CLAIM_MS: z.coerce.number().int().min(1000).default(120000),
  MAX_LEADS_PER_REQUEST: z.coerce.number().int().min(1).max(20000).default(5000),
  ENQUEUE_CHUNK_SIZE: z.coerce.number().int().min(1).max(2000).default(500),

  ETHEREAL_HOST: z.string().min(1).default('smtp.ethereal.email'),
  ETHEREAL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  ETHEREAL_USER: z.string().optional().default(''),
  ETHEREAL_PASS: z.string().optional().default(''),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),

  SLACK_CLIENT_ID: z.string().optional().default(''),
  SLACK_CLIENT_SECRET: z.string().optional().default(''),
  SLACK_REDIRECT_URI: z.string().optional().default(''),
  SLACK_SCOPES: z.string().default('incoming-webhook,chat:write'),

  BULL_BOARD_USER: z.string().min(1).default('admin'),
  BULL_BOARD_PASS: z.string().min(1).default(DEFAULT_DEV_BULL_PASS),

  DEMO_FAST_MODE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),

  // Infrastructure & Security Mode Controls:
  // When STRICT_INFRASTRUCTURE=true, PostgreSQL and Redis are strictly required and embedded fallbacks are disabled.
  STRICT_INFRASTRUCTURE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),

  // Explicit opt-in for embedded LibSQL/memory fallback in container/preview environments without external daemons
  ALLOW_EMBEDDED_FALLBACK: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(true),

  // Strict authentication mode: disables unauthenticated fallback user when true
  STRICT_AUTH: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
});

export type Config = z.infer<typeof baseEnvSchema>;

/**
 * Parses and validates environment variables with fail-fast production and assignment safeguards.
 */
export function parseConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  const envCopy: Record<string, string | undefined> = { ...rawEnv };

  // Cloud Run container proxy routes traffic to port 3000 while setting PORT=8080 for nginx
  if (envCopy.PORT === '8080' && envCopy.K_SERVICE) {
    envCopy.PORT = '3000';
  }

  // In the managed Cloud Run preview container (K_SERVICE), local Postgres/Redis OS daemons
  // are not installed on localhost. Unless FORCE_STRICT_BOOT=true is explicitly passed,
  // allow embedded fallback for process.env so the preview HTTP server stays alive on port 3000.
  const isManagedPreviewBoot =
    rawEnv === process.env &&
    Boolean(envCopy.K_SERVICE) &&
    envCopy.FORCE_STRICT_BOOT !== 'true' &&
    (!envCopy.DATABASE_URL ||
      envCopy.DATABASE_URL.includes('localhost') ||
      envCopy.DATABASE_URL.includes('127.0.0.1'));

  if (isManagedPreviewBoot) {
    envCopy.STRICT_INFRASTRUCTURE = 'false';
    envCopy.ALLOW_EMBEDDED_FALLBACK = 'true';
    envCopy.STRICT_AUTH = 'false';
  }

  const parsed = baseEnvSchema.parse(envCopy);

  // If STRICT_INFRASTRUCTURE is enabled, disable embedded fallback automatically
  if (parsed.STRICT_INFRASTRUCTURE) {
    parsed.ALLOW_EMBEDDED_FALLBACK = false;
  }

  // Enforce strict production security checks when NODE_ENV=production (outside managed Cloud Run preview) or STRICT_INFRASTRUCTURE=true
  const enforceProductionSecrets =
    parsed.STRICT_INFRASTRUCTURE || (parsed.NODE_ENV === 'production' && !rawEnv.K_SERVICE);

  if (enforceProductionSecrets) {
    if (
      !rawEnv.SESSION_SECRET ||
      parsed.SESSION_SECRET === DEFAULT_DEV_SESSION_SECRET ||
      parsed.SESSION_SECRET.length < 32
    ) {
      throw new Error(
        'Configuration Error: SESSION_SECRET must be explicitly set to a strong secret (>= 32 chars) in production/strict mode.'
      );
    }

    if (
      !rawEnv.ENCRYPTION_KEY ||
      parsed.ENCRYPTION_KEY === DEFAULT_DEV_ENCRYPTION_KEY ||
      parsed.ENCRYPTION_KEY.length < 32
    ) {
      throw new Error(
        'Configuration Error: ENCRYPTION_KEY must be explicitly set to a strong 32-byte key in production/strict mode.'
      );
    }

    if (
      parsed.BULL_BOARD_PASS === DEFAULT_DEV_BULL_PASS ||
      parsed.BULL_BOARD_PASS === 'admin' ||
      parsed.BULL_BOARD_PASS === 'password' ||
      parsed.BULL_BOARD_PASS.length < 8
    ) {
      throw new Error(
        'Configuration Error: BULL_BOARD_PASS cannot use weak default credentials (e.g. admin123) in production/strict mode.'
      );
    }

    if (
      !parsed.DATABASE_URL.startsWith('postgresql://') &&
      !parsed.DATABASE_URL.startsWith('postgres://')
    ) {
      throw new Error(
        'Configuration Error: DATABASE_URL must be a valid PostgreSQL connection string (postgresql://...) in strict/production mode.'
      );
    }
  }

  return parsed;
}

export const config = parseConfig(process.env);
