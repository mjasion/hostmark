import { refuseExampleSecret } from '@hostmark/auth';
import { z } from 'zod';

const httpUrl = z
  .url()
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), 'must be an http or https URL');

/**
 * Environment variables of the three Lambda functions. `AWS_REGION` and the `AWS_*` credentials are set by the Lambda
 * runtime from the execution role; the rest comes from the template (adapters/aws/template.yaml). A deployment that
 * forgets ENVIRONMENT is treated as production, so the checks below stay on.
 */
export const varsSchema = z.object({
  ENVIRONMENT: z.string().trim().min(1).default('production'),
  APP_VERSION: z.string().default('dev'),
  /** Origin of the deployment (the CloudFront domain or a custom one): auth base URL and base of /f/:id links (D82). */
  PUBLIC_URL: httpUrl,
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().trim().min(32, 'must be at least 32 characters (spaces do not count)'),
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
  // D7, D335: signup is off unless the deployment turns it on (a run with scenario S13 does).
  AUTH_SIGNUP_ENABLED: z.enum(['true', 'false']).default('false'),
  HOSTMARK_TOPOLOGY: z.string().optional(),
  HOSTMARK_REGION: z.string().optional(),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  /** Present with the temporary credentials of an execution role; absent for the static keys of a stand-in. */
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(3),
  /** Server side and presigned URLs both use `https://s3.<region>.amazonaws.com`; only the stand-in tests override these. */
  S3_ENDPOINT: httpUrl.optional(),
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
  SQS_QUEUE_URL: httpUrl,
  /** Only the stand-in tests set it (ElasticMQ). */
  SQS_ENDPOINT: httpUrl.optional(),
  /** CloudFront distribution whose cache `/media` and `/f` fill (D100). */
  CLOUDFRONT_DISTRIBUTION_ID: z.string().min(1).optional(),
  /** Shared with the distribution's origin custom header; the api refuses any request that lacks it (D80). */
  ORIGIN_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  /**
   * OTLP/HTTP base URL of the OTel backend (acceptance criterion 3). Empty or absent: nothing is exported and logs are
   * JSON lines on stdout (CloudWatch Logs) only.
   */
  OTLP_ENDPOINT: z.union([z.literal(''), httpUrl]).default(''),
  /**
   * Read by the OTLP exporters themselves (the OpenTelemetry convention: `key=value` pairs, comma separated, values
   * URL-encoded, for example `authorization=Basic%20...`). Listed here so that the template may set it.
   */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  /** Multiplies the retry delays. Only the chaos tests set it below 1: the real schedule takes 400 s. */
  QUEUE_BACKOFF_SCALE: z.coerce.number().min(0).default(1),
});

/**
 * The S3 endpoint of the functions, path-style: `https://s3.<region>.amazonaws.com` unless a stand-in overrides it. Its
 * origin is the storage source of the HTML policy in template.yaml (D310), which `template-check` compares with it.
 */
export const s3Endpoint = (vars: { S3_ENDPOINT?: string; AWS_REGION: string }): string =>
  vars.S3_ENDPOINT ?? `https://s3.${vars.AWS_REGION}.amazonaws.com`;

export type Vars = z.infer<typeof varsSchema>;

/**
 * Header the CloudFront Function `viewer-request` sets from `event.viewer.ip` on every request and overwrites if the
 * viewer sent one (D80, adapters/aws/README.md). The api answers 403 to a request that did not come through the
 * distribution, so the header cannot be set by a client that calls the function URL directly.
 */
export const CLIENT_IP_HEADER = 'x-hostmark-client-ip';

/** The header carrying the origin secret, added by CloudFront as an origin custom header. */
export const ORIGIN_SECRET_HEADER = 'x-hostmark-origin-secret';

export class ConfigError extends Error {}

/** Parses the variables and applies the checks that need more than one field. Throws `ConfigError` with every problem. */
export function parseVars(
  source: Record<string, unknown>,
  service: 'api' | 'worker' | 'scheduler' = 'api',
): Vars {
  const parsed = varsSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join('\n')}`);
  }
  const vars = parsed.data;
  const problems: string[] = [];
  if (vars.ENVIRONMENT !== 'local') {
    // /media is cached for a year (D6): without a purge, unpublish and delete leave public copies behind (D100).
    if (!vars.CLOUDFRONT_DISTRIBUTION_ID)
      problems.push(
        `  CLOUDFRONT_DISTRIBUTION_ID: required when ENVIRONMENT is "${vars.ENVIRONMENT}" (no CDN purge, D100)`,
      );
    if (service === 'api' && !vars.ORIGIN_SECRET)
      problems.push(
        `  ORIGIN_SECRET: required when ENVIRONMENT is "${vars.ENVIRONMENT}" (the client address header is only trustworthy behind CloudFront, D80)`,
      );
  }
  if (problems.length) throw new ConfigError(`Invalid environment:\n${problems.join('\n')}`);
  try {
    refuseExampleSecret(vars.BETTER_AUTH_SECRET, vars.ENVIRONMENT);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return vars;
}
