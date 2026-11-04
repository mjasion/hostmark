import type { CachePurger, Queue } from '@hostmark/core/ports';
import type { Telemetry } from '@hostmark/telemetry';
import { type Env, loadEnv } from './env';

/** The queue a runtime holds: the port, plus the health check and the shutdown the processes need. */
export interface RuntimeQueue extends Queue {
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** The variables `createRuntime` reads. The queue's own (`REDIS_URL` for BullMQ) belong to the queue factory. */
export type RuntimeEnv = Omit<Env, 'REDIS_URL'>;

/**
 * What an adapter tells the shared runtime about itself; everything else is configuration. `E` is the adapter's
 * validated environment and `Q` its queue; without `queue` the runtime builds BullMQ on `REDIS_URL` (D185).
 */
export interface NodePlatform<E extends RuntimeEnv = Env, Q extends RuntimeQueue = RuntimeQueue> {
  /** Platform and variant, e.g. `fly-portable`: the `bench.platform` attribute and the platform of `/api/health`. */
  key: string;
  /**
   * Maps variables the platform provides to ours (for example the ones a managed bucket sets). Receives the process
   * environment and returns the one to validate; variables already set by the operator win.
   */
  env?: (source: Record<string, string | undefined>) => Record<string, string | undefined>;
  /** Builds the job queue. Absent: BullMQ on `REDIS_URL`. */
  queue?: (env: E, logger: Telemetry['logger']) => Q;
  /** D100: the CDN purger of every process that unpublishes or deletes. Absent: none (D205). */
  purger?: (env: E) => CachePurger | undefined;
}

/** Validates `process.env` (after the platform's mapping) and exits with a readable message when it is wrong. */
export function loadPlatformEnv(platform: NodePlatform): Env {
  return loadEnv(platform.env?.(process.env) ?? process.env);
}
