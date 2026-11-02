import { refuseExampleSecret } from '@hostmark/auth';
import { z } from 'zod';

const httpUrl = z
  .url()
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), 'must be an http or https URL');

/**
 * Environment variables of the api, queue and cron functions (Vercel project settings). Files live in an external
 * S3 compatible bucket (Cloudflare R2, D197); `S3_*` are its credentials. A deployment that forgets ENVIRONMENT is
 * treated as production, so the checks below stay on.
 */
export const varsSchema = z.object({
  ENVIRONMENT: z.string().trim().min(1).default('production'),
  APP_VERSION: z.string().default('dev'),
  PUBLIC_URL: httpUrl,
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().trim().min(32, 'must be at least 32 characters (spaces do not count)'),
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
  AUTH_SIGNUP_ENABLED: z.enum(['true', 'false']).default('true'),
  HOSTMARK_TOPOLOGY: z.string().optional(),
  HOSTMARK_REGION: z.string().optional(),
  S3_ENDPOINT: httpUrl,
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().min(1).default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** Vercel sends it to cron routes as `Authorization: Bearer <value>`; Vercel asks for at least 16 characters. */
  CRON_SECRET: z.string().min(16),
  /** Name of the topic; the dead letter topic is `<topic>-dlq`. */
  QUEUE_TOPIC: z.string().min(1).default('image-jobs'),
});

export type Vars = z.infer<typeof varsSchema>;

/**
 * Vercel overwrites `x-forwarded-for` and does not forward external addresses; `x-vercel-forwarded-for` is documented
 * as identical and as the one to use behind another proxy. Chosen in the adapter, not from the environment (D158).
 */
export const CLIENT_IP_HEADER = 'x-vercel-forwarded-for';

export class ConfigError extends Error {}

export function parseVars(source: Record<string, unknown>): Vars {
  const parsed = varsSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  try {
    refuseExampleSecret(parsed.data.BETTER_AUTH_SECRET, parsed.data.ENVIRONMENT);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return parsed.data;
}
