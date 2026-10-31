import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { Cron } from 'croner';
import { loadEnv } from './env';
import { createRuntime, onTerminate } from './runtime';

const env = loadEnv();
const runtime = createRuntime('scheduler', env);
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
  for (let i = 0; i < 100 && crons.some((c) => c.isBusy()); i++) await new Promise((r) => setTimeout(r, 200));
  await runtime.shutdown();
});
