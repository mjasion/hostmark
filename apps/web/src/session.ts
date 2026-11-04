import { ApiError } from '@hostmark/contract/client';
import type { QueryClient } from '@tanstack/react-query';
import { endSession } from './api';
import { getSession } from './auth';

export const sessionKey = ['session'] as const;

export const loadSession = (qc: QueryClient) =>
  qc.fetchQuery({ queryKey: sessionKey, queryFn: getSession, staleTime: 30_000 });

/** Everything the previous user may have left behind: all cached queries but the session. */
export const clearUserData = (qc: QueryClient) =>
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });

export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

const redirects = new WeakMap<QueryClient, () => void>();

/** Where `signedOut` sends the user; set once by `createAppQueryClient`. */
export const redirectWhenSignedOut = (qc: QueryClient, go: () => void) => redirects.set(qc, go);

/**
 * The one handling of a 401, for queries, mutations and uploads alike: end the session's requests and event
 * streams, forget user data, then go to login.
 */
export function signedOut(qc: QueryClient) {
  endSession();
  clearUserData(qc);
  qc.setQueryData(sessionKey, null);
  redirects.get(qc)?.();
}
