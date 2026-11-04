import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { Clock } from '@hostmark/core/ports';
import { createNodeDb } from '@hostmark/db/node';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry, type Telemetry } from '@hostmark/telemetry';
import { type NodeTelemetry, startNodeTelemetry } from '@hostmark/telemetry/node';
import type { Env } from './env';
import type { NodePlatform, RuntimeEnv, RuntimeQueue } from './platform';
import { createBullQueue } from './queue';

export type Service = 'api' | 'worker' | 'scheduler';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createStorage(env: RuntimeEnv) {
  return createS3Storage({
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}

export interface Runtime<E extends RuntimeEnv = Env, Q extends RuntimeQueue = RuntimeQueue> {
  env: E;
  deps: CoreDeps;
  queue: Q;
  sdk: NodeTelemetry;
  telemetry: Telemetry;
  /** Flushes telemetry and closes connections. Idempotent callers should guard against double calls. */
  shutdown(): Promise<void>;
}

/**
 * Telemetry first: instrumentation must exist before the first span, log or metric is created. The queue comes from
 * the platform's factory, or is BullMQ on `REDIS_URL` when the platform has none (D185).
 */
export function createRuntime(service: Service, env: Env, platform: NodePlatform): Runtime;
export function createRuntime<E extends RuntimeEnv, Q extends RuntimeQueue>(
  service: Service,
  env: E,
  platform: NodePlatform<E, Q> & { queue: NonNullable<NodePlatform<E, Q>['queue']> },
): Runtime<E, Q>;
export function createRuntime(
  service: Service,
  env: RuntimeEnv,
  // The overloads tie the factories to the adapter's environment type; here it is only passed through.
  platform: Pick<NodePlatform, 'key'> & {
    queue?: (env: never, logger: Telemetry['logger']) => RuntimeQueue;
    purger?: (env: never) => CoreDeps['purger'];
  },
): Runtime<RuntimeEnv, RuntimeQueue> {
  // Only the api handles sessions. It refuses to start without a real secret rather than run with a default (D88).
  if (service === 'api' && (!env.BETTER_AUTH_SECRET || !env.PUBLIC_URL)) {
    console.error(
      'Invalid environment:\n  BETTER_AUTH_SECRET (32+ characters) and PUBLIC_URL are required by the api',
    );
    process.exit(1);
  }
  const sdk = startNodeTelemetry({
    service,
    platform: platform.key,
    variant: 'portable',
    imageImpl: 'wasm',
    version: env.APP_VERSION,
    environment: env.ENVIRONMENT,
    otlpEndpoint: env.OTLP_ENDPOINT,
  });
  const telemetry = createTelemetry(service, { write: sdk.write });
  const nodeDb = createNodeDb(env.DATABASE_URL);
  const queue = platform.queue
    ? platform.queue(env as never, telemetry.logger)
    : createBullQueue((env as Env).REDIS_URL, undefined, telemetry.logger);
  const rum = {
    ...(env.HOSTMARK_TOPOLOGY ? { topology: env.HOSTMARK_TOPOLOGY } : {}),
    ...(env.HOSTMARK_REGION ? { region: env.HOSTMARK_REGION } : {}),
  };
  const auth =
    service === 'api' && env.BETTER_AUTH_SECRET && env.PUBLIC_URL
      ? createAuth({
          db: nodeDb.db,
          secret: env.BETTER_AUTH_SECRET,
          baseUrl: new URL(env.PUBLIC_URL).origin,
          clientIpHeader: env.AUTH_CLIENT_IP_HEADER || undefined,
          trustedOrigins: env.AUTH_TRUSTED_ORIGINS.split(',')
            .map((o) => o.trim())
            .filter(Boolean),
          signupEnabled: env.AUTH_SIGNUP_ENABLED === 'true',
        })
      : undefined;
  const deps: CoreDeps = {
    auth,
    db: nodeDb.db,
    storage: createStorage(env),
    queue,
    images: createWasmImageProcessor(nodeLoader),
    clock: systemClock,
    telemetry,
    purger: platform.purger?.(env as never),
    config: {
      platform: platform.key,
      version: env.APP_VERSION,
      publicUrl: env.PUBLIC_URL && new URL(env.PUBLIC_URL).origin,
      rum,
    },
  };
  return {
    env,
    deps,
    queue,
    sdk,
    telemetry,
    async shutdown() {
      await queue.close();
      await nodeDb.close();
      await sdk.shutdown();
    },
  };
}

/** Runs `stop` once on SIGTERM or SIGINT, then exits. */
export function onTerminate(stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    stop().then(
      () => process.exit(0),
      (err) => {
        console.error('shutdown failed', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
