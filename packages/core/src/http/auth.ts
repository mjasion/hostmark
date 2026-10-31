import { apiKeys, hashApiKey } from '@hostmark/db';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ForbiddenError, UnauthorizedError } from '../errors';
import type { HttpEnv } from './context';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BEARER = /^Bearer\s+(\S+)$/i;

/** Host comparison only: behind a TLS terminating proxy the scheme seen by the app can differ from the browser's. */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // A proxy chain appends to x-forwarded-host; the first entry is the one the browser used.
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const hosts = [forwarded, req.headers.get('host')].filter((h): h is string => !!h);
  if (hosts.length === 0) hosts.push(new URL(req.url).host);
  return hosts.some((host) => host.toLowerCase() === originHost);
}

/** D7: Bearer API key, else a Better Auth session cookie. */
export const authenticate: MiddlewareHandler<HttpEnv> = async (c, next) => {
  const { db, auth } = c.get('deps');
  const header = c.req.header('authorization');

  if (header !== undefined) {
    const match = BEARER.exec(header.trim());
    if (!match) throw new UnauthorizedError('Expected a Bearer API key');
    // Lookup by hash only; the key itself is never compared, stored or logged.
    const keyHash = await hashApiKey(match[1] as string);
    const [row] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isAdmin: apiKeys.isAdmin })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    if (!row) throw new UnauthorizedError('Invalid API key');
    c.set('principal', { userId: row.userId, apiKeyId: row.id, isAdmin: row.isAdmin });
    return next();
  }

  const session = auth ? await auth.getSession(c.req.raw.headers) : null;
  if (!session) throw new UnauthorizedError('Missing credentials');
  if (MUTATING.has(c.req.method) && !isSameOrigin(c.req.raw)) {
    throw new ForbiddenError('Cross-origin request rejected');
  }
  c.set('principal', { userId: session.userId, apiKeyId: null, isAdmin: false });
  return next();
};
