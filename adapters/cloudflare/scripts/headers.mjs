// The `_headers` file of the static assets (D88, D251, D310). Kept apart from build.mjs so a test can read it. Imports
// TypeScript sources (the contract and the pages' style hashes): run it under `node --import tsx`, as `pnpm build` does.
//
// Every rule whose pattern matches a request applies, in file order, and a header set by two rules is joined with a
// comma (Workers static assets, "Headers"). `/assets/*` (hashed, immutable) is also matched by `/*`, so it first
// detaches the short policy with `! Cache-Control` and then sets its own: a hashed file gets exactly one value.
// Everything else, the HTML pages and `rum.js` (not hashed, D85), is revalidated after five minutes, the same policy
// as the Node static handler (packages/node-runtime/src/static.ts).
//
// Security headers (D310): `/*` carries the common set for every file, HSTS included (the assets are only served on
// the custom domain over TLS; a browser ignores HSTS on plain HTTP). The prerendered pages get the HTML set from rules
// that match nothing else, so no header is set by two rules. The panel shell (`/app/`) has no rule here: the Worker
// serves it for `/login`, `/signup`, `/app` and `/app/*` and adds the HTML set itself (src/api.ts).
import { readFileSync } from 'node:fs';
import { COMMON_SECURITY_HEADERS, HSTS, HTML_SECURITY_HEADERS, htmlCsp } from '@hostmark/contract/security';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { parseJsonc } from '../pipeline/preview-config.mjs';
import { r2PresignedOrigin } from '../src/storage.ts';

const apiConfig = new URL('../wrangler.api.jsonc', import.meta.url);

/**
 * D310: the origin of presigned R2 URLs for the prerendered pages' policy, from the vars the Worker presigns with:
 * R2_ACCOUNT_ID, R2_BUCKET_NAME and R2_PUBLIC_ENDPOINT from the environment first, else from the `vars` of
 * wrangler.api.jsonc. Those pages never contact storage, so a preview built without the account id (a secret, D241)
 * only names the committed value; the panel shell's policy comes from the Worker's own vars at runtime.
 */
export function storageOriginForBuild(env = process.env, configText = readFileSync(apiConfig, 'utf8')) {
  const vars = parseJsonc(configText).vars ?? {};
  const pick = (name) => env[name] || vars[name] || undefined;
  return r2PresignedOrigin({
    accountId: pick('R2_ACCOUNT_ID'),
    bucketName: pick('R2_BUCKET_NAME'),
    publicEndpoint: pick('R2_PUBLIC_ENDPOINT'),
  });
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=300';

/** The request paths of the prerendered pages, as the asset server sees them (`auto-trailing-slash` redirects). */
export const PAGE_PATHS = ['/', '/index.html', '/pricing', '/pricing/', '/pricing/index.html'];

const lines = (headers) => Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);

/** `storageOrigin`: the origin of presigned R2 URLs, for the policy of the pages (`r2PresignedOrigin`). */
export function headersFile({ storageOrigin }) {
  const html = {
    'content-security-policy': htmlCsp({ storageOrigin, styleHashes: STYLE_HASHES }),
    ...HTML_SECURITY_HEADERS,
  };
  return [
    '/*',
    `  Cache-Control: ${SHORT}`,
    ...lines({ ...COMMON_SECURITY_HEADERS, 'strict-transport-security': HSTS }),
    '/assets/*',
    '  ! Cache-Control',
    `  Cache-Control: ${IMMUTABLE}`,
    ...PAGE_PATHS.flatMap((path) => [path, ...lines(html)]),
    '',
  ].join('\n');
}
