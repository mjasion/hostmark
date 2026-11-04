import { ApiError, createClient } from '@hostmark/contract/client';
import { MAX_UPLOAD_BYTES } from '@hostmark/contract/constants';

function hex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const traceparent = () => `00-${hex(16)}-${hex(8)}-01`;

/**
 * What one signed-in session holds open: its API requests (through this controller) and its event streams.
 * `endSession` ends both, on sign-out, on a 401 and on sign-in (D302).
 */
let session = new AbortController();
const streams = new Set<EventSource>();

/** Aborted when the session that is current now ends. */
export const sessionSignal = (): AbortSignal => session.signal;

/** Registers an event stream so that `endSession` closes it; returns the function that unregisters it. */
export function trackStream(es: EventSource): () => void {
  streams.add(es);
  return () => void streams.delete(es);
}

/** Aborts every API request of the current session and closes its event streams. Later requests are unaffected. */
export function endSession(): void {
  session.abort();
  session = new AbortController();
  for (const es of streams) es.close();
  streams.clear();
}

/**
 * Every request belongs to the session that started it. One still running when that session ends is aborted, and
 * an answer that arrives anyway (a 401 above all) is dropped, so it can never sign out the next user (D302).
 */
function sessionFetch(signal?: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const own = session.signal;
    const signals = [own, signal, init.signal ?? undefined].filter((s): s is AbortSignal => s !== undefined);
    // `fetch` is resolved per call rather than captured at import time.
    const res = await fetch(input, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : own });
    if (own.aborted) throw new DOMException('The session ended.', 'AbortError');
    return res;
  };
}

const clientFor = (signal?: AbortSignal) =>
  createClient({
    credentials: 'same-origin',
    fetch: sessionFetch(signal),
    headers: () => ({ traceparent: traceparent() }),
  });

/** The trace starts in the browser (spec, Telemetry): every `fetch` to the API carries a fresh `traceparent`. */
export const client = clientFor();

/** The same client with one more signal, for requests a user can cancel (the create and complete of an upload). */
export const cancellableClient = (signal: AbortSignal) => clientFor(signal);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path segment can name a file at all. Anything else is never sent to the API. */
export const isFileId = (id: string): boolean => UUID.test(id);

/** Dates are shown in English whatever the browser's language, in the browser's time zone. */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });

/** A readable message for any error: the RFC 9457 `detail` when there is one. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const { problem, status } = error;
    if (status === 413)
      return problem?.detail ?? `The file is larger than ${MAX_UPLOAD_BYTES / 1_048_576} MiB.`;
    if (problem?.errors?.length) {
      const fields = problem.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return `${problem.detail ?? problem.title} (${fields})`;
    }
    if (problem) return problem.detail ?? problem.title;
    if (status === 401) return 'You are signed out.';
    return `The server answered HTTP ${status}.`;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
