// Runs one scheduler job now: `node dist/run-job.js requeue-stuck`. Used by operators and the smoke test.
import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { loadPlatformEnv, type NodePlatform } from './platform';
import { createRuntime } from './runtime';

export async function runJob(platform: NodePlatform): Promise<never> {
  const name = process.argv[2] as SchedulerJobName | undefined;
  if (!name || !Object.hasOwn(SCHEDULER_JOBS, name)) {
    console.error(`usage: run-job <${Object.keys(SCHEDULER_JOBS).join('|')}>`);
    process.exit(2);
  }

  const runtime = createRuntime('scheduler', loadPlatformEnv(platform), platform);
  let code = 0;
  try {
    const result = await createSchedulerJobs(runtime.deps)[name]();
    console.log(JSON.stringify({ job: name, ...result }));
  } catch {
    code = 1;
  } finally {
    await runtime.shutdown();
  }
  process.exit(code);
}
