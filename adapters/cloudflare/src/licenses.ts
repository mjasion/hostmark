// The text travels inside the bundle: a deployed Worker has no node_modules next to it. Regenerate with
// `pnpm licenses` (`pnpm check` fails when it is stale).
import text from '../licenses/THIRD-PARTY-LICENSES.txt';

export const LICENSES_PATH = '/THIRD-PARTY-LICENSES.txt';

export function licensesResponse(): Response {
  return new Response(text, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
