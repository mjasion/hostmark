// D310: the security headers of every response. The values are `@hostmark/contract`'s; this file decides which set a
// response gets and whether it went over HTTPS. Adapters use it for the few responses they build themselves.
import { securityHeaders } from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';

/**
 * Whether the deployment answers over HTTPS, which decides HSTS. The configured public URL wins (D82: it is the
 * deployment's own origin and no client can change it); without one, the scheme the proxy reports in the first
 * `x-forwarded-proto` entry, else the scheme of the request URL, as `pageOrigin` does. A browser ignores HSTS on a
 * plain HTTP response (RFC 6797, 8.1), so a client that fakes the header gains nothing.
 */
export function isHttps(req: Request, publicUrl?: string): boolean {
  if (publicUrl) return publicUrl.startsWith('https:');
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded === 'https';
  return new URL(req.url).protocol === 'https:';
}

const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

/** The D310 headers `res` lacks, for the request `req` (see `withSecurityHeaders`). */
export function missingSecurityHeaders(
  res: Response,
  req: Request,
  publicUrl?: string,
): Record<string, string> {
  const path = new URL(req.url).pathname;
  const headers = securityHeaders(isApi(path) ? 'api' : 'other', { https: isHttps(req, publicUrl) });
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !res.headers.has(name)));
}

/**
 * Sets each D310 header the response does not carry yet and returns it (a copy when its headers are immutable, as
 * those of a `fetch()` answer are). The JSON API gets its own policy; everything else, the common set. A response that
 * already chose a value keeps it: `/f/*` its share policy and `same-origin` referrer.
 */
export function withSecurityHeaders(res: Response, req: Request, publicUrl?: string): Response {
  const missing = Object.entries(missingSecurityHeaders(res, req, publicUrl));
  if (missing.length === 0) return res;
  let out = res;
  try {
    for (const [name, value] of missing) out.headers.set(name, value);
  } catch {
    out = new Response(res.body, res);
    for (const [name, value] of missing) out.headers.set(name, value);
  }
  return out;
}

/**
 * The full set for an HTML document of the web app (the prerendered pages and the panel shell), for the platforms that
 * serve those files from code: the Node static handler and the Cloudflare Worker's shell routes. `storageOrigin` is the
 * origin of the presigned URLs (`presignedOrigin` of `@hostmark/storage-s3`).
 */
export function htmlSecurityHeaders(options: {
  https: boolean;
  storageOrigin: string;
}): Record<string, string> {
  return securityHeaders('html', { ...options, styleHashes: STYLE_HASHES });
}
