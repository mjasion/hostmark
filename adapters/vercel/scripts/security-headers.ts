// D310: the security headers of the static output. `vercel.json` carries every fixed value (the common set on all paths
// the CDN serves from files, the HTML set on the HTML paths). The HTML Content-Security-Policy names the origin of the
// presigned URLs, which depends on the deployment's S3 variables, so `scripts/deploy.mjs` writes vercel.json plus that
// header to a temporary file and builds with `vercel build --local-config <file>`:
//   node --import tsx scripts/security-headers.ts <out.json>
// Function answers (/api, /media, /f) get their headers from core, not from here (`pnpm check` pins the split).
import { readFileSync, writeFileSync } from 'node:fs';
import { htmlCsp } from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { presignedOrigin } from '@hostmark/storage-s3';

type Header = { key: string; value: string };
export type HeaderRule = { source: string; headers: Header[] };
type Config = { headers?: HeaderRule[] } & Record<string, unknown>;

/** The rules that carry `X-Frame-Options` are the HTML rules; the policy goes into exactly those. */
const isHtmlRule = (rule: HeaderRule) => rule.headers.some((h) => h.key.toLowerCase() === 'x-frame-options');

/** The origin the functions presign with (src/runtime.ts): path-style on S3_PUBLIC_ENDPOINT, else S3_ENDPOINT. */
export function storageOriginOf(env: Record<string, string | undefined>): string {
  const endpoint = env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT;
  if (!endpoint || !env.S3_BUCKET)
    throw new Error('S3_ENDPOINT (or S3_PUBLIC_ENDPOINT) and S3_BUCKET are required');
  return presignedOrigin({ endpoint, bucket: env.S3_BUCKET });
}

/** `config` with the HTML policy added to every HTML rule. Throws when the config has none or already has a policy. */
export function withContentSecurityPolicy<C extends Config>(config: C, storageOrigin: string): C {
  const rules = config.headers ?? [];
  if (!rules.some(isHtmlRule)) throw new Error('vercel.json has no HTML header rule (X-Frame-Options)');
  if (rules.some((r) => r.headers.some((h) => h.key.toLowerCase() === 'content-security-policy')))
    throw new Error('vercel.json must not set Content-Security-Policy itself');
  const csp = {
    key: 'Content-Security-Policy',
    value: htmlCsp({ storageOrigin, styleHashes: STYLE_HASHES }),
  };
  return {
    ...config,
    headers: rules.map((r) => (isHtmlRule(r) ? { ...r, headers: [...r.headers, csp] } : r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: security-headers.ts <out.json>');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as Config;
  const origin = storageOriginOf(process.env);
  writeFileSync(out, `${JSON.stringify(withContentSecurityPolicy(config, origin), null, 2)}\n`);
  console.log(`vercel.json with the HTML Content-Security-Policy (storage ${origin}) written to ${out}`);
}
