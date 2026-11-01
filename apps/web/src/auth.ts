import { traceparent } from './api';

// Better Auth JSON endpoints under `/api/auth/*`, used with plain fetch (D86).

export interface Session {
  user: { id: string; email: string; name: string };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const MESSAGES: Record<string, string> = {
  EMAIL_PASSWORD_SIGN_UP_DISABLED: 'Signup is disabled on this deployment.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with this email already exists.',
  INVALID_EMAIL_OR_PASSWORD: 'Wrong email or password.',
  INVALID_EMAIL: 'This email address is not valid.',
  PASSWORD_TOO_SHORT: 'The password is too short (at least 8 characters).',
  PASSWORD_TOO_LONG: 'The password is too long.',
};

async function post(path: string, body: object): Promise<unknown> {
  const res = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', traceparent: traceparent() },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return data;
  const { code, message } = (data ?? {}) as { code?: string; message?: string };
  let text = (code && MESSAGES[code]) || message;
  if (!text) {
    if (res.status === 403)
      text = 'The request was refused. Open the app from its own address and try again.';
    else if (res.status === 429) text = 'Too many attempts. Wait a moment and try again.';
    else text = `The server answered HTTP ${res.status}.`;
  }
  throw new AuthError(text, code, res.status);
}

/** The session, or null when signed out. */
export async function getSession(): Promise<Session | null> {
  const res = await fetch('/api/auth/get-session', {
    credentials: 'same-origin',
    headers: { accept: 'application/json', traceparent: traceparent() },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as Session | null;
  return data?.user ? data : null;
}

export async function signIn(email: string, password: string): Promise<void> {
  await post('sign-in/email', { email, password });
}

/** Better Auth requires a name; the panel has no profile, so it uses the part before the `@`. */
export async function signUp(email: string, password: string): Promise<void> {
  await post('sign-up/email', { email, password, name: email.split('@')[0] || email });
}

export async function signOut(): Promise<void> {
  await post('sign-out', {});
}
