import { z } from 'zod';

const url = z.url();
const httpUrl = url.refine(
  (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
  'must be an http or https URL',
);

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: url,
  S3_ENDPOINT: url,
  S3_PUBLIC_ENDPOINT: url.optional(),
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** OTLP/HTTP base URL. Empty disables export. */
  OTLP_ENDPOINT: z.string().default(''),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  APP_VERSION: z.string().default('dev'),
  ENVIRONMENT: z.string().default('local'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** Directory with the Vite build and prerendered pages; only the api serves it (D88). */
  WEB_DIST: z.string().default('web'),
  /** Signs session cookies (D80). No default: a missing or short value stops the process at startup. */
  BETTER_AUTH_SECRET: z
    .string()
    .trim()
    .min(32, 'must be at least 32 characters (spaces do not count)')
    .optional(),
  /** Public origin of the app, also the auth base URL and the origin of absolute links in /f/:id (D82). Only its origin is used. */
  PUBLIC_URL: httpUrl.optional(),
  /** Comma separated origins besides PUBLIC_URL that pass Better Auth's origin check. Core's own check for cookie API mutations still wants the request's own origin (D84). */
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
  /** Header a trusted proxy overwrites with the client address. Set: the sign-in rate limiter is on and /api/auth/* answers 400 without one valid address in it. Unset: no limiter. */
  AUTH_CLIENT_IP_HEADER: z.string().trim().optional(),
  AUTH_SIGNUP_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Overrides of the RUM attributes of rendered pages; closed lists in packages/contract. */
  HOSTMARK_TOPOLOGY: z.string().optional(),
  HOSTMARK_REGION: z.string().optional(),
  /** Multiplies the retry delays. Only the chaos tests set it below 1: the real schedule takes 400 s. */
  QUEUE_BACKOFF_SCALE: z.coerce.number().min(0).default(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment:\n${lines.join('\n')}`);
  process.exit(1);
}
