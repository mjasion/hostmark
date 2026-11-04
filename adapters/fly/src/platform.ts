import type { NodePlatform } from '@hostmark/node-runtime/platform';

/** The Fly proxy sets this header to the client address as it sees it, on requests that arrive through the proxy. */
export const CLIENT_IP_HEADER = 'Fly-Client-IP';

/**
 * `fly storage create` (Tigris) stores AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION and
 * BUCKET_NAME as app secrets. They fill the S3_* variables of the runtime unless those are set explicitly. Tigris
 * wants virtual-hosted-style URLs (presigned URLs must be, and buckets created since 2025-02-19 do not support
 * path-style), so S3_VIRTUAL_HOST defaults to `true` here (D280).
 */
export const platform: NodePlatform = {
  key: 'fly-portable',
  env: (source) => ({
    S3_ENDPOINT: source.AWS_ENDPOINT_URL_S3,
    S3_BUCKET: source.BUCKET_NAME,
    S3_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
    S3_REGION: source.AWS_REGION || 'auto',
    S3_VIRTUAL_HOST: 'true',
    ...definedOnly(source),
    AUTH_CLIENT_IP_HEADER: CLIENT_IP_HEADER,
  }),
};

function definedOnly(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
}
