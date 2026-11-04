/** Cloud Run sends SIGKILL this long after SIGTERM to a service instance; the documentation gives no setting for it. */
export const CLOUD_RUN_SIGTERM_GRACE_MS = 10_000;

/**
 * The worker exits by itself at the latest this long after SIGTERM, before Cloud Run's SIGKILL, so the exit is logged and
 * not a kill. The consumer's close comes first (at most `CLOSE_MAX_MS`, 8 s), the rest is for closing the database
 * and flushing telemetry.
 */
export const SHUTDOWN_DEADLINE_MS = 9_000;

/**
 * Wraps a shutdown so that it ends within `deadlineMs`: when `stop` has not settled by then, `onTimeout` runs
 * (the worker exits with code 1). The timer does not keep the process alive.
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
