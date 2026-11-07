import type { NodePlatform } from '@hostmark/node-runtime/platform';
import type { GcpEnv } from './env';
import { createCloudCdnPurger } from './purge';
import { createPubSubQueue, type PubSubQueueHandle } from './queue';

/**
 * The load balancer sets this header from `{client_ip_address}` on every request through the backend service's custom
 * request headers, which replace a header of the same name that the client sent (D182). Cloud Run is closed to every other
 * path (`ingress = internal-and-cloud-load-balancing`, run.app URL off), so no request reaches the api without it.
 */
export const CLIENT_IP_HEADER = 'X-Client-Ip';

export const platform: NodePlatform<GcpEnv, PubSubQueueHandle> & {
  queue: NonNullable<NodePlatform<GcpEnv, PubSubQueueHandle>['queue']>;
} = {
  key: 'gcp-portable',
  env: (source) => ({ ...source, AUTH_CLIENT_IP_HEADER: CLIENT_IP_HEADER }),
  // Pub/Sub instead of BullMQ (D180).
  queue: (env, logger) => createPubSubQueue({ project: env.GCP_PROJECT, topic: env.PUBSUB_TOPIC, logger }),
  // D100: every process that unpublishes or deletes purges; only a deployment without a CDN has none. No `host`: the
  // cache key includes the request Host and the URL map sends every Host to the CDN backend, so an invalidation scoped
  // to PUBLIC_URL's host would leave copies cached under another Host (D333).
  purger: (env) =>
    env.CDN_URL_MAP ? createCloudCdnPurger({ project: env.GCP_PROJECT, urlMap: env.CDN_URL_MAP }) : undefined,
};
