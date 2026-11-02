// Runs one scheduler job: `node dist/run-job.js requeue-stuck`. Cloud Scheduler starts it through a Cloud Run Job (D181).
import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import { createRuntime } from './runtime';

const name = process.argv[2] as SchedulerJobName | undefined;
if (!name || !Object.hasOwn(SCHEDULER_JOBS, name)) {
  console.error(`usage: run-job <${Object.keys(SCHEDULER_JOBS).join('|')}>`);
  process.exit(2);
}

const runtime = createRuntime('scheduler');
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
