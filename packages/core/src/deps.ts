import type { Telemetry } from '@hostmark/telemetry';
import type { CachePurger, Clock, Db, ImageProcessor, ObjectStorage, Queue } from './ports';

export interface AppConfig {
  /** `x-platform` header, e.g. `cloudflare-portable`; also the `daily_stats.platform` key. */
  platform: string;
  /** `x-version` header, the commit SHA. */
  version: string;
  /**
   * Public origin of the app, e.g. `https://hostmark.example` (the same value as the auth base URL). Absolute
   * URLs in `/f/:id` come from it, which is what makes that page safe to cache (D82). Without it the page is
   * rendered from the request's host and sent `no-store`.
   */
  publicUrl?: string;
  /** Overrides for the RUM attributes of rendered pages (D80); each defaults from `platform`. Closed lists. */
  rum?: Partial<{ platform: string; variant: string; topology: string; region: string }>;
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
  /** D100: required wherever a CDN caches `/media` and `/f`; see `CachePurger`. */
  purger?: CachePurger;
}
