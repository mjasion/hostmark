import {
  createRuntime as createNodeRuntime,
  type Runtime as NodeRuntime,
} from '@hostmark/node-runtime/runtime';
import { type GcpEnv, loadGcpEnv } from './env';
import { platform } from './platform';
import type { PubSubQueueHandle } from './queue';

export type Service = 'api' | 'worker' | 'scheduler';

export type Runtime = NodeRuntime<GcpEnv, PubSubQueueHandle>;

/** The shared Node runtime with the queue and purger of `platform` (Pub/Sub, Cloud CDN; D185). */
export function createRuntime(
  service: Service,
  env: GcpEnv = loadGcpEnv(platform.env?.(process.env) ?? process.env),
): Runtime {
  return createNodeRuntime(service, env, platform);
}
