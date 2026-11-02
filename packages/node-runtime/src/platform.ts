import { type Env, loadEnv } from './env';

/** What an adapter tells the shared runtime about itself; everything else is configuration. */
export interface NodePlatform {
  /** Platform and variant, e.g. `fly-portable`: the `bench.platform` attribute and the platform of `/api/health`. */
  key: string;
  /**
   * Maps variables the platform provides to ours (for example the ones a managed bucket sets). Receives the process
   * environment and returns the one to validate; variables already set by the operator win.
   */
  env?: (source: Record<string, string | undefined>) => Record<string, string | undefined>;
}

/** Validates `process.env` (after the platform's mapping) and exits with a readable message when it is wrong. */
export function loadPlatformEnv(platform: NodePlatform): Env {
  return loadEnv(platform.env?.(process.env) ?? process.env);
}
