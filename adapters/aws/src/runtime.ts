import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { CachePurger, Clock, ImageProcessor } from '@hostmark/core/ports';
import { databaseFromPostgresJs } from '@hostmark/db/postgres-js';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry, type Telemetry } from '@hostmark/telemetry';
import { startNodeTelemetry } from '@hostmark/telemetry/node';
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
  /**
   * Exports the buffered spans, metrics and logs; resolves after at most `FLUSH_TIMEOUT_MS` and never throws. Each
   * entrypoint awaits it before the invocation returns, because Lambda freezes the environment then and the batch
   * timers of the SDK do not run while it is frozen.
   */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Upper bound of the flush at the end of an invocation: an unreachable collector must not hold the function. */
export const FLUSH_TIMEOUT_MS = 2_000;

interface ServiceTelemetry {
  telemetry: Telemetry;
  forceFlush(): Promise<void>;
}

const telemetry = new Map<Service, ServiceTelemetry>();
/**
 * One per service and process. With `OTLP_ENDPOINT` the Node SDK exports over OTLP/HTTP with `service.name` = the
 * service (api, worker, scheduler); the exporters read `OTEL_EXPORTER_OTLP_HEADERS` themselves. Without it spans and
 * metrics are no-ops and logs are JSON lines on stdout (CloudWatch Logs). The SDK registers global providers, so only
 * the first service of a process exports: a Lambda environment runs one function, only tests create several.
 */
function telemetryFor(service: Service, vars: Vars): ServiceTelemetry {
  let t = telemetry.get(service);
  if (!t) {
    if (vars.OTLP_ENDPOINT) {
      const sdk = startNodeTelemetry({
        service,
        platform: PLATFORM,
        variant: 'portable',
        imageImpl: 'wasm',
        version: vars.APP_VERSION,
        environment: vars.ENVIRONMENT,
        otlpEndpoint: vars.OTLP_ENDPOINT,
      });
      t = { telemetry: createTelemetry(service, { write: sdk.write }), forceFlush: () => sdk.flush() };
    } else {
      t = { telemetry: createTelemetry(service), forceFlush: async () => {} };
    }
    telemetry.set(service, t);
  }
  return t;
}

/** `forceFlush` bounded by `timeoutMs`; a failure or a timeout is logged, never thrown. */
export async function boundedFlush(
  forceFlush: () => Promise<void>,
  logger: Telemetry['logger'],
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([forceFlush().then(() => 'done' as const), timeout]);
    if (result === 'timeout') logger.warn('telemetry flush timed out', { timeoutMs });
  } catch (err) {
    logger.warn('telemetry flush failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one invocation and flushes the telemetry after it, whether it returned or threw. */
export async function withFlush<T>(runtime: () => Runtime | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await runtime()?.flush();
  }
}

/**
 * One runtime per execution environment (a warm container serves many invocations, one at a time), so the database
 * connection and the SDK clients are reused. `max: 1` because Lambda handles one request per environment; the
 * connection count is therefore the concurrency of the function, which the template caps: `ApiReservedConcurrency`
 * for the api, `WorkerMaxConcurrency` for the worker (README, "Database").
 */
export function createRuntime(source: Record<string, unknown>, options: RuntimeOptions): Runtime {
  const vars = parseVars(source, options.service);
  const client = postgres(vars.DATABASE_URL, { max: 1, idle_timeout: 20, onnotice: () => {} });
  const db = databaseFromPostgresJs(client);
  const st = telemetryFor(options.service, vars);
  const t = st.telemetry;
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
    flush: () => boundedFlush(st.forceFlush, t.logger),
    close: async () => {
      await client.end({ timeout: 5 });
      sqs.destroy();
    },
  };
}
