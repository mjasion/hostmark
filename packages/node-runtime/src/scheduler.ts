import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { Cron } from 'croner';
import { loadPlatformEnv, type NodePlatform } from './platform';
import { createRuntime, onTerminate } from './runtime';

/**
 * The scheduler process: the three jobs on their cron schedules, until SIGTERM. Run exactly one per deployment: `protect`
 * stops overlap inside this process only, so two replicas run every job twice (the database claims keep that safe, D19).
 */
export function runScheduler(platform: NodePlatform): void {
  const env = loadPlatformEnv(platform);
  const runtime = createRuntime('scheduler', env, platform);
  const jobs = createSchedulerJobs(runtime.deps);

  // `protect` skips a tick while the previous run of the same job is still going (one process only).
  const crons = (Object.keys(SCHEDULER_JOBS) as SchedulerJobName[]).map(
    (name) =>
      new Cron(
        SCHEDULER_JOBS[name],
        {
          name,
          timezone: 'UTC',
          protect: () =>
            runtime.telemetry.logger.warn('scheduler tick skipped, previous run still active', { job: name }),
          // The job wrapper already logged the failure; the next tick retries.
          catch: () => {},
        },
        async () => {
          await jobs[name]();
        },
      ),
  );
  runtime.telemetry.logger.info('scheduler started', { jobs: SCHEDULER_JOBS });

  onTerminate(async () => {
    for (const cron of crons) cron.stop();
    // Let a run in progress finish before the connections go away.
    for (let i = 0; i < 100 && crons.some((c) => c.isBusy()); i++)
      await new Promise((r) => setTimeout(r, 200));
    await runtime.shutdown();
  });
}
