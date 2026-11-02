import type { NodePlatform } from '@hostmark/node-runtime/platform';

/**
 * The load balancer sets this header from `{client_ip_address}` on every request through the backend service's custom
 * request headers, which replace a header of the same name that the client sent (D182). Cloud Run is closed to every other
 * path (`ingress = internal-and-cloud-load-balancing`, run.app URL off), so no request reaches the api without it.
 */
export const CLIENT_IP_HEADER = 'X-Client-Ip';

export const platform: NodePlatform = {
  key: 'gcp-portable',
  env: (source) => ({ ...source, AUTH_CLIENT_IP_HEADER: CLIENT_IP_HEADER }),
};
