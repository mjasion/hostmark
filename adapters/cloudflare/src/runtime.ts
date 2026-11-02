import { createAuth } from '@hostmark/auth';
import type { CoreDeps } from '@hostmark/core';
import type { CachePurger, Clock, ImageProcessor } from '@hostmark/core/ports';
import { databaseFromPostgresJs } from '@hostmark/db/postgres-js';
import { createTelemetry } from '@hostmark/telemetry';
import postgres from 'postgres';
import { type Bindings, CLIENT_IP_HEADER, parseVars, type Vars } from './env';
import { createCloudflareQueue } from './queue';
import { createR2Storage } from './storage';

export const PLATFORM = 'cloudflare-portable';

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

export interface ScopeOptions {
  service: Service;
  /** Per isolate: the wasm instances are expensive to build and safe to share. */
  images: ImageProcessor;
  /** Required: `createWorkersCachePurger` throws `ConfigError` when the `MEDIA` binding is missing (D100). */
  purger: CachePurger;
  /** Overrides the clock; tests only. */
  clock?: Clock;
}

export interface Scope {
  deps: CoreDeps;
  vars: Vars;
  /** Closes the Hyperdrive connections. Call it after the response, through `waitUntil`. */
  close(): Promise<void>;
}

const telemetry = new Map<Service, ReturnType<typeof createTelemetry>>();
function telemetryFor(service: Service) {
  let t = telemetry.get(service);
  if (!t) {
    // No SDK provider on Workers: spans and metrics are no-ops, logs are JSON lines on console (D102).
    t = createTelemetry(service);
    telemetry.set(service, t);
  }
  return t;
}

/**
 * One scope per request or invocation. A Workers isolate must not carry a database socket from one request to the
 * next ("Cannot perform I/O on behalf of a different request"), so the client is created here and closed by the caller.
 * Hyperdrive pools the real connections behind it.
 */
export function createScope(env: Bindings & Record<string, unknown>, options: ScopeOptions): Scope {
  const vars = parseVars(env);
  const client = postgres(env.HYPERDRIVE.connectionString, {
    // Workers allows 6 simultaneous connections per invocation; Hyperdrive docs recommend max 5.
    max: 5,
    // Hyperdrive cannot serve the type lookup that postgres.js does by default.
    fetch_types: false,
    prepare: true,
    onnotice: () => {},
  });
  const db = databaseFromPostgresJs(client);
  const t = telemetryFor(options.service);
  const origin = new URL(vars.PUBLIC_URL).origin;

  // Better Auth is costly to build and only some requests need it, so it is built on first use.
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
    storage: createR2Storage({
      bucket: env.BUCKET,
      accountId: vars.R2_ACCOUNT_ID,
      bucketName: vars.R2_BUCKET_NAME,
      accessKeyId: vars.R2_ACCESS_KEY_ID,
      secretAccessKey: vars.R2_SECRET_ACCESS_KEY,
      publicEndpoint: vars.R2_PUBLIC_ENDPOINT,
    }),
    queue: createCloudflareQueue(env.QUEUE),
    images: options.images,
    clock: options.clock ?? systemClock,
    telemetry: t,
    purger: options.purger,
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
  return { deps, vars, close: () => client.end({ timeout: 5 }) };
}
