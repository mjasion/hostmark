import { refuseExampleSecret } from '@hostmark/auth';
import { z } from 'zod';
import type { PurgeTarget } from './purge';

const httpUrl = z
  .url()
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), 'must be an http or https URL');

/**
 * Variables and secrets of the Workers (`vars` in wrangler.jsonc, secrets from `wrangler secret put`). Bindings are
 * `Bindings` below. There is no default for ENVIRONMENT's strictness the other way round: a deployment that forgets it
 * is treated as production, so the checks stay on.
 */
export const varsSchema = z.object({
  ENVIRONMENT: z.string().trim().min(1).default('production'),
  APP_VERSION: z.string().default('dev'),
  /** Origin of the deployment, also the auth base URL and the base of absolute links in /f/:id (D82). */
  PUBLIC_URL: httpUrl,
  BETTER_AUTH_SECRET: z.string().trim().min(32, 'must be at least 32 characters (spaces do not count)'),
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
  AUTH_SIGNUP_ENABLED: z.enum(['true', 'false']).default('true'),
  HOSTMARK_TOPOLOGY: z.string().optional(),
  HOSTMARK_REGION: z.string().optional(),
  /** Cloudflare account id: the host of presigned R2 URLs is `<id>.r2.cloudflarestorage.com`. */
  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(3),
  /** An R2 API token (S3 compatible), used for presigning only; reads and writes go through the binding. */
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  /** Replaces the `<id>.r2.cloudflarestorage.com` origin of presigned URLs. Only the emulator tests set it. */
  R2_PUBLIC_ENDPOINT: httpUrl.optional(),
});

export type Vars = z.infer<typeof varsSchema>;

/** Header Cloudflare overwrites on every request (D80). Not configurable: it is the platform's, not the operator's. */
export const CLIENT_IP_HEADER = 'cf-connecting-ip';

export interface Bindings extends Record<string, unknown> {
  HYPERDRIVE: Hyperdrive;
  BUCKET: R2Bucket;
  QUEUE: Queue;
  /** Service binding to the `Media` entrypoint of the api Worker: the only place that can purge its cache (D100). */
  MEDIA: PurgeTarget;
  ASSETS?: Fetcher;
}

export class ConfigError extends Error {}

/** Parses the vars and applies the checks that need more than one field. Throws `ConfigError` with every problem. */
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
