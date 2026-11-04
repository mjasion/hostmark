import type { Server } from 'node:http';

/** Cloud Run sends SIGKILL this long after SIGTERM to a service instance; the documentation gives no setting for it. */
export const CLOUD_RUN_SIGTERM_GRACE_MS = 10_000;

/**
 * The api and the worker exit by themselves at the latest this long after SIGTERM, before Cloud Run's SIGKILL, so the
 * exit is logged and not a kill. The worker's consumer close comes first (at most `CLOSE_MAX_MS`, 8 s); the api's
 * server close at most `API_DRAIN_MS` and the time the cut connections take to close. The rest is for closing the
 * database and flushing telemetry.
 */
export const SHUTDOWN_DEADLINE_MS = 9_000;

/**
 * The api lets open requests run this long after SIGTERM, then cuts every connection still open. In practice those are
 * the SSE streams of `/api/files/:id/events`, which last up to 60 s (D20); `EventSource` reconnects, through the load
 * balancer, to an instance that is not stopping (D296).
 */
export const API_DRAIN_MS = 3_000;

/**
 * Wraps a shutdown so that it ends within `deadlineMs`: when `stop` has not settled by then, `onTimeout` runs
 * (the process exits with code 1). The timer does not keep the process alive.
 */
export function withDeadline(
  stop: () => Promise<void>,
  deadlineMs: number,
  onTimeout: () => void,
): () => Promise<void> {
  return async () => {
    const timer = setTimeout(onTimeout, deadlineMs);
    timer.unref();
    try {
      await stop();
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `onTimeout` of `withDeadline` for a process: log one line and exit with code 1. */
export function exitAfterDeadline(): void {
  console.error(JSON.stringify({ level: 'error', msg: 'shutdown deadline passed, exiting' }));
  process.exit(1);
}

/**
 * Stops accepting connections and closes the idle ones at once; requests in flight get `drainMs` to finish, then every
 * connection still open is destroyed. Resolves when the server has closed.
 */
export function closeServer(server: Server, drainMs: number = API_DRAIN_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), drainMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
