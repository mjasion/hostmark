import { QUEUE_NAME } from '@hostmark/contract';
import { checkAuthSecret, envSchema as nodeEnvSchema } from '@hostmark/node-runtime/env';
import { z } from 'zod';

/**
 * The Node runtime's variables without Redis (the queue is Pub/Sub here) and with the GCP ones. `S3_*` point at the
 * Cloud Storage XML API with an HMAC key of the service account (see the README).
 */
export const envSchema = nodeEnvSchema.omit({ REDIS_URL: true }).extend({
  GCP_PROJECT: z.string().min(1),
  /** Topic of the image jobs and the subscription the worker pulls from. The dead letter topic is configured on the subscription. */
  PUBSUB_TOPIC: z.string().min(1).default(QUEUE_NAME),
  PUBSUB_SUBSCRIPTION: z.string().min(1).default(`${QUEUE_NAME}-worker`),
  /** Name of the URL map of the load balancer whose Cloud CDN holds `/media` and `/f` (D100). Unset only for a deployment without a CDN. */
  CDN_URL_MAP: z.string().min(1).optional(),
  /** Seconds a handler may keep a message before the lease is no longer renewed. Only the contract tests lower it. */
  LEASE_MAX_SECONDS: z.coerce.number().int().min(1).default(600),
});

export type GcpEnv = z.infer<typeof envSchema>;

export function loadGcpEnv(source: Record<string, string | undefined> = process.env): GcpEnv {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) {
    checkAuthSecret(parsed.data);
    return parsed.data;
  }
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment:\n${lines.join('\n')}`);
  process.exit(1);
}
