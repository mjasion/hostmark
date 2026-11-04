// The `_headers` file of the static assets (D88, D251). Kept apart from build.mjs so a test can read it.
//
// Every rule whose pattern matches a request applies, in file order, and a header set by two rules is joined with a
// comma (Workers static assets, "Headers"). `/assets/*` (hashed, immutable) is also matched by `/*`, so it first
// detaches the short policy with `! Cache-Control` and then sets its own: a hashed file gets exactly one value.
// Everything else, the HTML pages and `rum.js` (not hashed, D85), is revalidated after five minutes, the same policy
// as the Node static handler (packages/node-runtime/src/static.ts).

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=300';

export function headersFile() {
  return [
    '/*',
    `  Cache-Control: ${SHORT}`,
    '/assets/*',
    '  ! Cache-Control',
    `  Cache-Control: ${IMMUTABLE}`,
    '',
  ].join('\n');
}
