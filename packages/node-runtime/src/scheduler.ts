import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { Cron } from 'croner';
import { createPostgresLeaderLock, runLeaderLoop } from './leader';
import { loadPlatformEnv, type NodePlatform } from './platform';
import { createRuntime, onTerminate } from './runtime';

/**
 * The scheduler process: the three jobs on their cron schedules, until SIGTERM. Any number of replicas may run: only
 * the one holding the Postgres advisory lock starts the crons, the others wait to take over (D204). `protect` stops
 * overlap of one job inside the leader; the database claims keep a rare double run safe (D19).
 */
export function runScheduler(platform: NodePlatform): void {
  const env = loadPlatformEnv(platform);
  const runtime = createRuntime('scheduler', env, platform);
  const jobs = createSchedulerJobs(runtime.deps);
  const logger = runtime.telemetry.logger;

  let crons: Cron[] = [];
  const startCrons = () => {
    crons = createCrons();
    logger.info('scheduler started', { jobs: SCHEDULER_JOBS });
  };
  const stopCrons = async () => {
    for (const cron of crons) cron.stop();
    // Let a run in progress finish before the connections go away or another replica takes over.
    for (let i = 0; i < 100 && crons.some((c) => c.isBusy()); i++)
      await new Promise((r) => setTimeout(r, 200));
    crons = [];
  };

  const loop = runLeaderLoop({
    lock: createPostgresLeaderLock(env.DATABASE_URL),
    start: startCrons,
    stop: stopCrons,
    log: (level, msg, attrs) => logger[level](msg, attrs ?? {}),
  });
  logger.info('scheduler waiting for leadership');

  onTerminate(async () => {
    await loop.close();
    await runtime.shutdown();
  });

  // `protect` skips a tick while the previous run of the same job is still going.
  function createCrons(): Cron[] {
    return (Object.keys(SCHEDULER_JOBS) as SchedulerJobName[]).map(
      (name) =>
        new Cron(
          SCHEDULER_JOBS[name],
          {
            name,
            timezone: 'UTC',
            protect: () => logger.warn('scheduler tick skipped, previous run still active', { job: name }),
            // The job wrapper already logged the failure; the next tick retries.
            catch: () => {},
          },
          async () => {
            await jobs[name]();
          },
        ),
    );
  }
}
