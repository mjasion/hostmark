// Security response headers (D310). One definition for every platform: core sets them on what the app answers, and
// each platform's static file serving (the Node handler, Cloudflare `_headers`, `vercel.json`, the CloudFront response
// headers policies) is generated from or checked against these values. No dependency, so build scripts can import it.

/** HSTS for one host: no `includeSubDomains`, no `preload` (owner's choice, D310). Sent only over HTTPS. */
export const HSTS = 'max-age=31536000';
export const HSTS_SECONDS = 31_536_000;

/** Every response, whatever its type: API, `/media`, HTML, assets, `rum.js`, `robots.txt`, the favicon, errors. */
export const COMMON_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

/** `/f/:id` keeps the stricter referrer policy of D82: a share page does not tell other sites which file was open. */
export const SHARE_REFERRER_POLICY = 'same-origin';

/** The JSON API (`/api/*`): nothing in an answer may load or run anything, and nobody frames it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** HTML documents only (`/`, `/pricing`, the panel shell for `/app`, `/app/*`, `/login`, `/signup`), besides the CSP. */
export const HTML_SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
} as const;

export interface HtmlCspOptions {
  /**
   * Origin of the presigned URLs (`https://<host>[:port]`): the panel shows thumbnails from presigned GETs and uploads
   * with presigned PUTs from the browser. Absent: the policy allows only the own origin.
   */
  storageOrigin?: string | null;
  /** CSP hash sources (`sha256-<base64>`, without quotes) of every inline `<style>` the documents contain. */
  styleHashes: readonly string[];
}

const quoted = (hashes: readonly string[]) => hashes.map((h) => ` '${h}'`).join('');

/** Throws unless `origin` is a plain `http(s)://host[:port]` origin, so nothing else can enter a policy. */
export function checkOrigin(origin: string): string {
  if (
    !URL.canParse(origin) ||
    new URL(origin).origin !== origin ||
    !/^https?:$/.test(new URL(origin).protocol)
  )
    throw new Error(`not an http(s) origin: ${JSON.stringify(origin)}`);
  return origin;
}

function checkHashes(hashes: readonly string[]): readonly string[] {
  for (const h of hashes)
    if (!/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(h))
      throw new Error(`not a CSP hash source: ${JSON.stringify(h)}`);
  return hashes;
}

/** The policy of every HTML document of the web app (D310). */
export function htmlCsp({ storageOrigin, styleHashes }: HtmlCspOptions): string {
  const storage = storageOrigin ? ` ${checkOrigin(storageOrigin)}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self'${quoted(checkHashes(styleHashes))}`,
    `img-src 'self' data:${storage}`,
    `connect-src 'self'${storage}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The policy of `/f/:id` (D82, D89): own origin only, no frames; the inline styles are allowed by hash instead of
 * `'unsafe-inline'` (D310).
 */
export function shareCsp(styleHashes: readonly string[]): string {
  return `default-src 'none'; style-src${quoted(checkHashes(styleHashes))}; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** What a response is, for the header set it gets. */
export type SecurityKind = 'html' | 'api' | 'share' | 'other';

export interface SecurityHeaderOptions {
  /** The response goes over HTTPS under the deployment's own origin: only then is HSTS sent. */
  https: boolean;
  /** For `html`: see `HtmlCspOptions.storageOrigin`. */
  storageOrigin?: string | null;
  /** For `html` and `share`: see `HtmlCspOptions.styleHashes`. */
  styleHashes?: readonly string[];
}

/** The complete set of D310 for one kind of response, lowercase names. */
export function securityHeaders(kind: SecurityKind, options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = { ...COMMON_SECURITY_HEADERS };
  if (options.https) headers['strict-transport-security'] = HSTS;
  const styleHashes = options.styleHashes ?? [];
  if (kind === 'api') headers['content-security-policy'] = API_CSP;
  if (kind === 'share') {
    headers['content-security-policy'] = shareCsp(styleHashes);
    headers['referrer-policy'] = SHARE_REFERRER_POLICY;
  }
  if (kind === 'html') {
    headers['content-security-policy'] = htmlCsp({ storageOrigin: options.storageOrigin, styleHashes });
    Object.assign(headers, HTML_SECURITY_HEADERS);
  }
  return headers;
}
