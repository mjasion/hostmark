import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { CachePurger, Clock, ImageProcessor } from '@hostmark/core/ports';
import { databaseFromPostgresJs } from '@hostmark/db/postgres-js';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry } from '@hostmark/telemetry';
import postgres from 'postgres';
import { CLIENT_IP_HEADER, parseVars, type Vars } from './env';
import { createCloudFrontPurger } from './purge';
import { createSqsQueue } from './queue';

export const PLATFORM = 'aws-portable';

export type Service = 'api' | 'worker' | 'scheduler';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Stand-in for services that never decode an image; any use is a wiring error. */
export const noImages: ImageProcessor = {
  impl: 'wasm',
  async process() {
    throw new Error('This service does not process images');
  },
};

export interface RuntimeOptions {
  service: Service;
  images: ImageProcessor;
  /** Replaces the CloudFront purger; tests only. */
  purger?: CachePurger;
  clock?: Clock;
}

export interface Runtime {
  deps: CoreDeps;
  vars: Vars;
  sqs: SQSClient;
  queueUrl: string;
  close(): Promise<void>;
}

const telemetry = new Map<Service, ReturnType<typeof createTelemetry>>();
function telemetryFor(service: Service) {
  let t = telemetry.get(service);
  if (!t) {
    // No collector next to a Lambda: spans and metrics are no-ops, logs are JSON lines on stdout (CloudWatch Logs).
    t = createTelemetry(service);
    telemetry.set(service, t);
  }
  return t;
}

/**
 * One runtime per execution environment (a warm container serves many invocations, one at a time), so the database
 * connection and the SDK clients are reused. `max: 1` because Lambda handles one request per environment; the
 * connection count is therefore the concurrency of the function, which the template caps (README, "Database").
 */
export function createRuntime(source: Record<string, unknown>, options: RuntimeOptions): Runtime {
  const vars = parseVars(source, options.service);
  const client = postgres(vars.DATABASE_URL, { max: 1, idle_timeout: 20, onnotice: () => {} });
  const db = databaseFromPostgresJs(client);
  const t = telemetryFor(options.service);
  const origin = new URL(vars.PUBLIC_URL).origin;

  const credentials = {
    accessKeyId: vars.AWS_ACCESS_KEY_ID,
    secretAccessKey: vars.AWS_SECRET_ACCESS_KEY,
    ...(vars.AWS_SESSION_TOKEN ? { sessionToken: vars.AWS_SESSION_TOKEN } : {}),
  };
  const sqs = new SQSClient({
    region: vars.AWS_REGION,
    credentials,
    ...(vars.SQS_ENDPOINT ? { endpoint: vars.SQS_ENDPOINT } : {}),
  });
  const purger =
    options.purger ??
    (vars.CLOUDFRONT_DISTRIBUTION_ID
      ? createCloudFrontPurger(
          // CloudFront is a global service; its endpoint is signed for us-east-1 whatever the function's region.
          new CloudFrontClient({ region: 'us-east-1', credentials }),
          vars.CLOUDFRONT_DISTRIBUTION_ID,
        )
      : undefined);

  let auth: ReturnType<typeof createAuth> | undefined;
  const getAuth = () =>
    (auth ??= createAuth({
      db,
      secret: vars.BETTER_AUTH_SECRET,
      baseUrl: origin,
      clientIpHeader: CLIENT_IP_HEADER,
      trustedOrigins: vars.AUTH_TRUSTED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      signupEnabled: vars.AUTH_SIGNUP_ENABLED === 'true',
    }));

  const rum = {
    ...(vars.HOSTMARK_TOPOLOGY ? { topology: vars.HOSTMARK_TOPOLOGY } : {}),
    ...(vars.HOSTMARK_REGION ? { region: vars.HOSTMARK_REGION } : {}),
  };
  const deps: CoreDeps = {
    db,
    storage: createS3Storage({
      endpoint: vars.S3_ENDPOINT ?? `https://s3.${vars.AWS_REGION}.amazonaws.com`,
      publicEndpoint: vars.S3_PUBLIC_ENDPOINT,
      bucket: vars.S3_BUCKET,
      region: vars.AWS_REGION,
      ...credentials,
    }),
    queue: createSqsQueue(sqs, vars.SQS_QUEUE_URL),
    images: options.images,
    clock: options.clock ?? systemClock,
    telemetry: t,
    purger,
    config: { platform: PLATFORM, version: vars.APP_VERSION, publicUrl: origin, rum },
    ...(options.service === 'api'
      ? {
          auth: {
            handler: (req: Request) => getAuth().handler(req),
            getSession: (h: Headers) => getAuth().getSession(h),
          },
        }
      : {}),
  };
  return {
    deps,
    vars,
    sqs,
    queueUrl: vars.SQS_QUEUE_URL,
    close: async () => {
      await client.end({ timeout: 5 });
      sqs.destroy();
    },
  };
}
