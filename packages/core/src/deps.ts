import type { Telemetry } from '@hostmark/telemetry';
import type { Clock, Db, ImageProcessor, ObjectStorage, Queue } from './ports';

export interface AppConfig {
  /** `x-platform` header, e.g. `cloudflare-portable`; also the `daily_stats.platform` key. */
  platform: string;
  /** `x-version` header, the commit SHA. */
  version: string;
}

/** Cookie sessions. Configured by the adapter (stage E1); Bearer keys work without it. */
export interface SessionAuth {
  /** Mounted at `/api/auth/*`. */
  handler(req: Request): Promise<Response>;
  getSession(headers: Headers): Promise<{ userId: string } | null>;
}

export interface CoreDeps {
  db: Db;
  storage: ObjectStorage;
  queue: Queue;
  images: ImageProcessor;
  clock: Clock;
  telemetry: Telemetry;
  config: AppConfig;
  auth?: SessionAuth;
}
