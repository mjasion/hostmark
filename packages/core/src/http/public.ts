import {
  RUM_PLATFORMS,
  RUM_REGIONS,
  RUM_TOPOLOGIES,
  RUM_VARIANTS,
  securityHeaders,
  VARIANT_SIZES,
} from '@hostmark/contract';
import { type PublicFile, type PublicFileUrls, type RumAttributes, STYLE_HASHES } from '@hostmark/pages';
import type { Context } from 'hono';
import type { AppConfig } from '../deps';
import type { HttpEnv } from './context';

/** Page for browsers and crawlers: shared caches may keep it for a minute and serve it stale for ten more. */
export const PUBLIC_PAGE_CACHE = 's-maxage=60, stale-while-revalidate=600';

/**
 * The share page's own headers (D82, D310): a CSP that allows the inline style by its hash and the one same-origin
 * script, a defence in depth in case escaping ever fails, with a `frame-ancestors` guard so nobody frames the page;
 * `nosniff`; and the `same-origin` referrer policy. HSTS is added by the middleware of `createApp`, which knows the
 * scheme.
 */
const SHARE_HEADERS = securityHeaders('share', { https: false, styleHashes: STYLE_HASHES });

const pick = <T extends string>(list: readonly T[], value: string | undefined, fallback: T): T =>
  list.find((item) => item === value) ?? fallback;

/** D80: the platform key (`aws-portable`) splits into the RUM platform and variant; `config.rum` overrides. */
export function rumAttributes(config: AppConfig): RumAttributes {
  const [head = '', tail] = config.platform.split(/-(?=[^-]+$)/);
  const platform = pick(RUM_PLATFORMS, config.rum?.platform ?? head, 'local');
  return {
    platform,
    variant: pick(RUM_VARIANTS, config.rum?.variant ?? tail, 'portable'),
    topology: pick(RUM_TOPOLOGIES, config.rum?.topology, 'single'),
    region: pick(RUM_REGIONS, config.rum?.region, 'local'),
  };
}

const HOST =
  /^(?:[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * D82: the origin for absolute URLs in a page that a CDN may cache by path. The configured public URL is the
 * only trusted source. Without it the origin comes from the request (the first `x-forwarded-host`, else
 * `host`, as D51 does), which a client controls, so the page must not be cached: `cacheable` is false.
 */
export function pageOrigin(
  c: Context<HttpEnv>,
  config: AppConfig,
): { origin: string | null; cacheable: boolean } {
  if (config.publicUrl) return { origin: new URL(config.publicUrl).origin, cacheable: true };
  const req = c.req.raw;
  const host = (
    req.headers.get('x-forwarded-host')?.split(',')[0] ??
    req.headers.get('host') ??
    new URL(req.url).host
  ).trim();
  if (!HOST.test(host)) return { origin: null, cacheable: false };
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : new URL(req.url).protocol.slice(0, -1);
  return { origin: `${proto}://${host}`, cacheable: false };
}

export interface FileRowForPage {
  id: string;
  width: number | null;
  height: number | null;
  contentType: string;
  bytes: number | null;
  createdAt: Date;
}

export function pageModel(
  row: FileRowForPage,
  origin: string | null,
): { file: PublicFile; urls: PublicFileUrls } {
  const path = (size: number) => `/media/${row.id}/${size}.webp`;
  const largest = Math.max(...VARIANT_SIZES);
  return {
    file: {
      id: row.id,
      title: row.width && row.height ? `Image ${row.width} x ${row.height}` : 'Shared image',
      width: row.width,
      height: row.height,
      contentType: row.contentType,
      bytes: row.bytes,
      createdAt: row.createdAt,
    },
    urls: {
      page: origin ? `${origin}/f/${row.id}` : undefined,
      ogImage: origin ? `${origin}${path(largest)}` : undefined,
      variants: VARIANT_SIZES.map((size) => [size, path(size)]),
    },
  };
}

/**
 * Every `/f/*` page, the 200 included. D300: share pages stay out of search results; link previews still read the
 * Open Graph tags, which `noindex` does not hide.
 */
export function htmlResponse(status: number, html: string, cacheControl: string): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
      ...SHARE_HEADERS,
      'x-robots-tag': 'noindex',
    },
  });
}
