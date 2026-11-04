import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { createRuntime, noImages, type Runtime, withFlush } from './runtime';

/** Input of each EventBridge Scheduler schedule (template.yaml): the job to run. */
export interface SchedulerEvent {
  job: SchedulerJobName;
}

export function isSchedulerEvent(event: unknown): event is SchedulerEvent {
  const job = (event as { job?: unknown } | null)?.job;
  return typeof job === 'string' && Object.hasOwn(SCHEDULER_JOBS, job);
}

let runtime: Runtime | undefined;

/**
 * EventBridge Scheduler invokes asynchronously; `SchedulerInvokeConfig` in the template turns off Lambda's own retries,
 * so a failed run is not repeated before the next tick. The telemetry is flushed before the invocation returns.
 */
export async function handler(event: unknown): Promise<void> {
  if (!isSchedulerEvent(event)) throw new Error(`Not a scheduler event: ${JSON.stringify(event)}`);
  await withFlush(
    () => runtime,
    async () => {
      runtime ??= createRuntime(process.env, { service: 'scheduler', images: noImages });
      await createSchedulerJobs(runtime.deps)[event.job]();
    },
  );
}
