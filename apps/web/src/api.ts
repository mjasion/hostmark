import { ApiError, createClient } from '@hostmark/contract/client';
import { MAX_UPLOAD_BYTES } from '@hostmark/contract/constants';

function hex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const traceparent = () => `00-${hex(16)}-${hex(8)}-01`;

/** The trace starts in the browser (spec, Telemetry): every `fetch` to the API carries a fresh `traceparent`. */
export const client = createClient({
  credentials: 'same-origin',
  // Resolved per call rather than captured at import time.
  fetch: (input, init) => fetch(input, init),
  headers: () => ({ traceparent: traceparent() }),
});

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
