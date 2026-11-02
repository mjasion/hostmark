import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import { createNodeDb } from '@hostmark/db/node';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { systemClock } from '@hostmark/node-runtime/runtime';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry, type Telemetry } from '@hostmark/telemetry';
import { type NodeTelemetry, startNodeTelemetry } from '@hostmark/telemetry/node';
import { type GcpEnv, loadGcpEnv } from './env';
import { platform } from './platform';
import { createCloudCdnPurger } from './purge';
import { createPubSubQueue, type PubSubQueueHandle } from './queue';

export type Service = 'api' | 'worker' | 'scheduler';

export interface Runtime {
  env: GcpEnv;
  deps: CoreDeps;
  queue: PubSubQueueHandle;
  sdk: NodeTelemetry;
  telemetry: Telemetry;
  shutdown(): Promise<void>;
}

/**
 * Same wiring as `@hostmark/node-runtime/runtime` with Pub/Sub for BullMQ and the Cloud CDN purger. Telemetry first:
 * instrumentation must exist before the first span, log or metric is created.
 */
export function createRuntime(
  service: Service,
  env: GcpEnv = loadGcpEnv(platform.env?.(process.env) ?? process.env),
): Runtime {
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
  const queue = createPubSubQueue({
    project: env.GCP_PROJECT,
    topic: env.PUBSUB_TOPIC,
    logger: telemetry.logger,
  });
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
    storage: createS3Storage({
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }),
    queue,
    images: createWasmImageProcessor(nodeLoader),
    clock: systemClock,
    telemetry,
    // D100: every process that unpublishes or deletes purges; only a deployment without a CDN has none.
    purger: env.CDN_URL_MAP
      ? createCloudCdnPurger({
          project: env.GCP_PROJECT,
          urlMap: env.CDN_URL_MAP,
          host: env.PUBLIC_URL ? new URL(env.PUBLIC_URL).host : undefined,
        })
      : undefined,
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
