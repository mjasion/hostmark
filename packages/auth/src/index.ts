import type { SessionAuth } from '@hostmark/core';
import { type Database, isReservedEmail, schema } from '@hostmark/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';

export interface AuthOptions {
  db: Database;
  /** Signs and encrypts cookies and tokens; at least 32 characters. Changing it logs everyone out. */
  secret: string;
  /** Public origin of the app, e.g. `https://hostmark.example`. `Secure` cookies follow its scheme. */
  baseUrl: string;
  /**
   * Origins, besides `baseUrl`, that pass Better Auth's own origin check on its routes (sign-in, sign-up). They do not
   * pass the same-origin check on API mutations (D51). Each entry must parse as a URL; only its origin is kept.
   */
  trustedOrigins?: string[];
  /**
   * D80: header carrying the client address, which the platform overwrites on every request (for example
   * `cf-connecting-ip`). It turns the rate limiter on, keyed on that header alone. Unset means no trusted address,
   * so no limiter. With it set, an auth request without a single valid address in that header is refused.
   */
  clientIpHeader?: string;
  /** D7: `false` refuses registration. */
  signupEnabled: boolean;
}

/**
 * D7, D80: Better Auth over the existing tables, email and password only, sessions in Postgres. Nothing here
 * imports a Node module, so it runs on Workers too.
 */
export function createAuth(options: AuthOptions): SessionAuth {
  const clientIpHeader = options.clientIpHeader?.trim().toLowerCase() || undefined;
  const auth = betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: (options.trustedOrigins ?? []).map(normalizeOrigin),
    // Better Auth's default is on in production only, and keyed on `x-forwarded-for`, which a client can forge.
    rateLimit: { enabled: clientIpHeader !== undefined },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.signupEnabled,
      requireEmailVerification: false,
    },
    advanced: {
      useSecureCookies: new URL(options.baseUrl).protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ...(clientIpHeader ? { ipAddress: { ipAddressHeaders: [clientIpHeader] } } : {}),
    },
    databaseHooks: {
      user: {
        create: {
          // The last gate, whatever route created the user (D80).
          before: async (created) => {
            if (isReservedEmail(created.email))
              throw new APIError('BAD_REQUEST', { message: 'This email address cannot be registered' });
          },
        },
      },
    },
  });

  return {
    handler: (req) => {
      // Without a valid address the limiter would put every such request into one shared bucket.
      if (clientIpHeader && !isSingleIp(req.headers.get(clientIpHeader)))
        return Promise.resolve(Response.json({ message: 'Client address unavailable' }, { status: 400 }));
      return auth.handler(req);
    },
    async getSession(headers) {
      const session = await auth.api.getSession({ headers });
      return session ? { userId: session.user.id } : null;
    },
  };
}

function normalizeOrigin(entry: string): string {
  const invalid = new Error(`trustedOrigins: "${entry}" is not an http(s) URL such as https://app.example`);
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw invalid;
  }
  // `spa.test:8080` parses as the scheme `spa.test:`, with an opaque origin.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid;
  return url.origin;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** One address, no list: Better Auth ignores a multi-value header, which would put the request in a shared bucket. */
function isSingleIp(value: string | null): boolean {
  const ip = value?.trim();
  if (!ip) return false;
  if (IPV4.test(ip)) return true;
  if (!ip.includes(':') || /[^0-9a-f:.]/i.test(ip)) return false;
  try {
    new URL(`http://[${ip}]/`);
    return true;
  } catch {
    return false;
  }
}
