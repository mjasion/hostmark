import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import type { Runtime } from './runtime';
import { sameSecret } from './secret';

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

/**
 * Vercel Cron calls a path with `GET` and `Authorization: Bearer <CRON_SECRET>` (UTC, no retry on failure, and the
 * same run can be delivered twice, which the jobs tolerate through database claims, D19). The job is the `job` query
 * parameter (vercel.json); no other caller may run a job.
 */
export function createCronHandler(getRuntime: () => Pick<Runtime, 'deps' | 'vars'>) {
  return async function cron(request: Request): Promise<Response> {
    const { deps, vars } = getRuntime();
    if (!sameSecret(request.headers.get('authorization') ?? '', `Bearer ${vars.CRON_SECRET}`))
      return text(401, 'Unauthorized');
    const job = new URL(request.url).searchParams.get('job') ?? '';
    if (!Object.hasOwn(SCHEDULER_JOBS, job)) return text(400, `Unknown job: ${job}`);
    await createSchedulerJobs(deps)[job as SchedulerJobName]();
    return text(200, 'ok');
  };
}
