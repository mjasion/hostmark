import { SCHEDULER_JOBS, type SchedulerJobName } from '@hostmark/contract';
import { createSchedulerJobs } from '@hostmark/core';
import type { Runtime } from './runtime';
import { sameSecret } from './secret';

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

/**
 * The job of a cron call. Each cron of vercel.json calls `/api/cron/<job>`, which a rewrite sends to this function as
 * `/api/cron?job=<job>`: the job is the last path segment when the function sees the original path, else the one
 * `job` query parameter (two values name no job). The name is not decoded; only a name of the closed list runs.
 */
export function jobOf(url: URL): string {
  const path = /^\/api\/cron\/([^/]+)$/.exec(url.pathname)?.[1];
  if (path !== undefined) return path;
  const query = url.searchParams.getAll('job');
  return query.length === 1 ? (query[0] ?? '') : '';
}

/**
 * Vercel Cron calls a path with `GET` and `Authorization: Bearer <CRON_SECRET>` (UTC, no retry on failure, and the
 * same run can be delivered twice, which the jobs tolerate through database claims, D19). No other caller may run a
 * job, and only a job of `SCHEDULER_JOBS` runs.
 */
export function createCronHandler(getRuntime: () => Pick<Runtime, 'deps' | 'vars'>) {
  return async function cron(request: Request): Promise<Response> {
    const { deps, vars } = getRuntime();
    if (!sameSecret(request.headers.get('authorization') ?? '', `Bearer ${vars.CRON_SECRET}`))
      return text(401, 'Unauthorized');
    const job = jobOf(new URL(request.url));
    if (!Object.hasOwn(SCHEDULER_JOBS, job)) return text(400, `Unknown job: ${job}`);
    await createSchedulerJobs(deps)[job as SchedulerJobName]();
    return text(200, 'ok');
  };
}
