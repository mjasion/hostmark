import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { CachePurger, Clock, ImageProcessor } from '@hostmark/core/ports';
import { databaseFromPostgresJs } from '@hostmark/db/postgres-js';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry } from '@hostmark/telemetry';
import { type NodeTelemetry, type NodeTelemetryOptions, startNodeTelemetry } from '@hostmark/telemetry/node';
import postgres from 'postgres';
import { CLIENT_IP_HEADER, parseVars, type Vars } from './env';
import { createVercelQueue, type QueueSdk } from './queue';

export const PLATFORM = 'vercel-portable';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The service each function is, as on every other platform: api, the queue consumer, the cron route (D274). */
export type Service = NodeTelemetryOptions['service'];

export interface RuntimeOptions {
  service: Service;
  images: ImageProcessor;
  queueSdk: QueueSdk;
  purger: CachePurger;
  clock?: Clock;
  /** Starts the OTLP export when `OTLP_ENDPOINT` is set; tests pass a fake. */
  startTelemetry?: (opts: NodeTelemetryOptions) => NodeTelemetry;
}

export interface Runtime {
  service: Service;
  deps: CoreDeps;
  vars: Vars;
  /** Exports the telemetry batched so far; one run at a time, calls during a run share the next one. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Runs `fn` for every call, but never twice at once: a call during a run waits for that run and shares one more, which
 * covers everything recorded before the call. Fluid compute answers many requests per instance, and each asks for a
 * flush when it ends.
 */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (!current) {
      current = fn().finally(() => {
        current = undefined;
      });
      return current;
    }
    queued ??= current
      .catch(() => {})
      .then(() => {
        queued = undefined;
        return run();
      });
    return queued;
  };
  return run;
}

/**
 * One runtime per function instance. Fluid compute runs several requests concurrently in one instance, so the pool
 * holds 5 connections. `attachDatabasePool` of `@vercel/functions` is not used: it accepts `pg`, `mysql2`,
 * `mariadb` and similar pools, not postgres.js, so idle connections are closed by `idle_timeout` and not before the
 * instance is suspended (D278).
 */
export function createRuntime(source: Record<string, unknown>, options: RuntimeOptions): Runtime {
  const vars = parseVars(source);
  // Without a collector, spans and metrics are no-ops and logs are JSON lines on stdout (Vercel's runtime logs).
  const exporter = vars.OTLP_ENDPOINT
    ? (options.startTelemetry ?? startNodeTelemetry)({
        service: options.service,
        platform: PLATFORM,
        variant: 'portable',
        imageImpl: 'wasm',
        version: vars.APP_VERSION,
        environment: vars.ENVIRONMENT,
        otlpEndpoint: vars.OTLP_ENDPOINT,
      })
    : undefined;
  const client = postgres(vars.DATABASE_URL, { max: 5, idle_timeout: 20, onnotice: () => {} });
  const db = databaseFromPostgresJs(client);
  const origin = new URL(vars.PUBLIC_URL).origin;
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
      endpoint: vars.S3_ENDPOINT,
      publicEndpoint: vars.S3_PUBLIC_ENDPOINT,
      bucket: vars.S3_BUCKET,
      region: vars.S3_REGION,
      accessKeyId: vars.S3_ACCESS_KEY_ID,
      secretAccessKey: vars.S3_SECRET_ACCESS_KEY,
    }),
    queue: createVercelQueue(options.queueSdk, vars.QUEUE_TOPIC),
    images: options.images,
    clock: options.clock ?? systemClock,
    telemetry: createTelemetry(options.service, exporter ? { write: exporter.write } : undefined),
    purger: options.purger,
    config: { platform: PLATFORM, version: vars.APP_VERSION, publicUrl: origin, rum },
    auth: {
      handler: (req: Request) => getAuth().handler(req),
      getSession: (h: Headers) => getAuth().getSession(h),
    },
  };
  return {
    service: options.service,
    deps,
    vars,
    flush: exporter ? coalesce(() => exporter.flush()) : async () => {},
    async close() {
      await client.end({ timeout: 5 });
      await exporter?.shutdown();
    },
  };
}
