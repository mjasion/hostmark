import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { CachePurger, Clock, ImageProcessor } from '@hostmark/core/ports';
import { databaseFromPostgresJs } from '@hostmark/db/postgres-js';
import { createS3Storage } from '@hostmark/storage-s3';
import { createTelemetry } from '@hostmark/telemetry';
import postgres from 'postgres';
import { CLIENT_IP_HEADER, parseVars, type Vars } from './env';
import { createVercelQueue, type QueueSdk } from './queue';

export const PLATFORM = 'vercel-portable';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RuntimeOptions {
  images: ImageProcessor;
  queueSdk: QueueSdk;
  purger: CachePurger;
  clock?: Clock;
}

export interface Runtime {
  deps: CoreDeps;
  vars: Vars;
  close(): Promise<void>;
}

/**
 * One runtime per function instance. Fluid compute runs several requests concurrently in one instance, so the pool
 * holds 5 connections; `attachDatabasePool` of `@vercel/functions` is not used (it takes `pg` pools, not postgres.js).
 */
export function createRuntime(source: Record<string, unknown>, options: RuntimeOptions): Runtime {
  const vars = parseVars(source);
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
    telemetry: createTelemetry('api'),
    purger: options.purger,
    config: { platform: PLATFORM, version: vars.APP_VERSION, publicUrl: origin, rum },
    auth: {
      handler: (req: Request) => getAuth().handler(req),
      getSession: (h: Headers) => getAuth().getSession(h),
    },
  };
  return { deps, vars, close: () => client.end({ timeout: 5 }) };
}
