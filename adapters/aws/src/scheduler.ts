import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { createRuntime, noImages, type Runtime } from './runtime';

/** Input of each EventBridge Scheduler schedule (template.yaml): the job to run. */
export interface SchedulerEvent {
  job: SchedulerJobName;
}

export function isSchedulerEvent(event: unknown): event is SchedulerEvent {
  const job = (event as { job?: unknown } | null)?.job;
  return typeof job === 'string' && Object.hasOwn(SCHEDULER_JOBS, job);
}

let runtime: Runtime | undefined;

export async function handler(event: unknown): Promise<void> {
  if (!isSchedulerEvent(event)) throw new Error(`Not a scheduler event: ${JSON.stringify(event)}`);
  runtime ??= createRuntime(process.env, { service: 'scheduler', images: noImages });
  await createSchedulerJobs(runtime.deps)[event.job]();
}
