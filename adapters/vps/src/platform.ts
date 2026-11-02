import type { NodePlatform } from '@hostmark/node-runtime/platform';

/** Caddy sets this header from the TCP peer on every request (Caddyfile), so a client cannot choose its address. */
export const CLIENT_IP_HEADER = 'X-Client-Ip';

export const platform: NodePlatform = {
  key: 'vps-portable',
  env: (source) => ({ ...source, AUTH_CLIENT_IP_HEADER: CLIENT_IP_HEADER }),
};
