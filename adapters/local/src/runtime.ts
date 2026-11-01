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
import { type BullQueueHandle, createBullQueue } from './queue';

export const PLATFORM = 'local-portable';

export type Service = 'api' | 'worker' | 'scheduler';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createStorage(env: Env) {
  return createS3Storage({
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}

export interface Runtime {
  deps: CoreDeps;
  queue: BullQueueHandle;
  sdk: NodeTelemetry;
  telemetry: Telemetry;
  /** Flushes telemetry and closes connections. Idempotent callers should guard against double calls. */
  shutdown(): Promise<void>;
}

/** Telemetry first: instrumentation must exist before the first span, log or metric is created. */
export function createRuntime(service: Service, env: Env): Runtime {
  // Only the api handles sessions. It refuses to start without a real secret rather than run with a default (D88).
  if (service === 'api' && (!env.BETTER_AUTH_SECRET || !env.PUBLIC_URL)) {
    console.error(
      'Invalid environment:\n  BETTER_AUTH_SECRET (32+ characters) and PUBLIC_URL are required by the api',
    );
    process.exit(1);
  }
  const sdk = startNodeTelemetry({
    service,
    platform: PLATFORM,
    variant: 'portable',
    imageImpl: 'wasm',
    version: env.APP_VERSION,
    environment: env.ENVIRONMENT,
    otlpEndpoint: env.OTLP_ENDPOINT,
  });
  const telemetry = createTelemetry(service, { write: sdk.write });
  const nodeDb = createNodeDb(env.DATABASE_URL);
  const queue = createBullQueue(env.REDIS_URL, undefined, telemetry.logger);
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
    config: {
      platform: PLATFORM,
      version: env.APP_VERSION,
      publicUrl: env.PUBLIC_URL && new URL(env.PUBLIC_URL).origin,
      rum,
    },
  };
  return {
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
