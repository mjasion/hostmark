import { z } from 'zod';

const url = z.url();

const schema = z.object({
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
  /** Multiplies the retry delays. Only the chaos tests set it below 1: the real schedule takes 400 s. */
  QUEUE_BACKOFF_SCALE: z.coerce.number().min(0).default(1),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment:\n${lines.join('\n')}`);
  process.exit(1);
}
