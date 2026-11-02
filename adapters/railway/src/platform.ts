import type { NodePlatform } from '@hostmark/node-runtime/platform';

/**
 * Railway's edge sets X-Real-IP to the client address and replaces a client-sent value (Railway Station staff
 * answers; not in the official reference, see README). Requests over the private network (*.railway.internal) are not
 * sanitised, so the api must only be reachable through its public domain.
 */
export const CLIENT_IP_HEADER = 'X-Real-IP';

export const platform: NodePlatform = {
  key: 'railway-portable',
  env: (source) => ({ ...source, AUTH_CLIENT_IP_HEADER: CLIENT_IP_HEADER }),
};
