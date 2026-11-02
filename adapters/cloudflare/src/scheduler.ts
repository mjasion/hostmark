import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import type { Bindings } from './env';
import { createWorkersCachePurger } from './purge';
import { createScope, noImages } from './runtime';

/** The cron expression of each job, so a trigger maps back to a job by its schedule (D19). */
export function jobsForCron(cron: string): SchedulerJobName[] {
  return (Object.keys(SCHEDULER_JOBS) as SchedulerJobName[]).filter((name) => SCHEDULER_JOBS[name] === cron);
}

export default {
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    const names = jobsForCron(controller.cron);
    if (names.length === 0) throw new Error(`No scheduler job has the schedule "${controller.cron}"`);
    const scope = createScope(env, {
      service: 'scheduler',
      images: noImages,
      purger: createWorkersCachePurger(env.MEDIA),
    });
    try {
      const jobs = createSchedulerJobs(scope.deps);
      for (const name of names) await jobs[name]();
    } finally {
      await scope.close();
    }
  },
} satisfies ExportedHandler<Bindings>;
