import {
  JOB_MESSAGE_VERSION,
  type JobMessage,
  MAX_ATTEMPTS,
  PENDING_UPLOAD_MAX_AGE_SECONDS,
  SCHEDULER_BATCH_LIMIT,
  type SchedulerJobName,
  STUCK_AFTER_SECONDS,
} from '@hostmark/contract';
import { files } from '@hostmark/db';
import { injectTraceContext, withSpan } from '@hostmark/telemetry';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { v4 } from 'uuid';
import type { CoreDeps } from '../deps';

type JobResult = { processed: number } & Record<string, number>;
type SchedulerJob = (deps: CoreDeps) => Promise<JobResult>;

const DAY_MS = 86_400_000;

function message(type: JobMessage['type'], fileId: string, now: Date): JobMessage {
  return {
    v: JOB_MESSAGE_VERSION,
    type,
    jobId: v4(),
    fileId,
    enqueuedAt: now.toISOString(),
    ...injectTraceContext(),
    chaos: 'none',
  };
}

/** D19: mark expired and abandoned files deleted, then ask the worker to purge what is not purged yet. */
const cleanupExpired: SchedulerJob = async ({ db, queue, clock }) => {
  const now = clock.now();
  const abandonedBefore = new Date(now.getTime() - PENDING_UPLOAD_MAX_AGE_SECONDS * 1000);
  const expiredCondition = and(
    isNull(files.deletedAt),
    or(
      lt(files.expiresAt, now),
      and(eq(files.status, 'pending_upload'), lt(files.createdAt, abandonedBefore)),
    ),
  );
  const marked = await db
    .update(files)
    .set({ status: 'deleted', deletedAt: now, lastActivityAt: now })
    .where(
      and(
        inArray(
          files.id,
          db.select({ id: files.id }).from(files).where(expiredCondition).limit(SCHEDULER_BATCH_LIMIT),
        ),
        expiredCondition,
      ),
    )
    .returning({ id: files.id });

  const unpurged = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.status, 'deleted'), isNull(files.purgedAt)))
    .orderBy(asc(files.id))
    .limit(SCHEDULER_BATCH_LIMIT);
  if (unpurged.length > 0) await queue.sendBatch(unpurged.map((f) => message('delete_file', f.id, now)));
  return { processed: unpurged.length, marked: marked.length };
};

/** D19: claim stuck rows with a conditional update so a double run claims each once. */
const requeueStuck: SchedulerJob = async ({ db, queue, clock, telemetry: { metrics } }) => {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - STUCK_AFTER_SECONDS * 1000);
  const stuck = and(
    inArray(files.status, ['queued', 'processing']),
    lt(files.lastActivityAt, cutoff),
    isNull(files.deletedAt),
  );

  // Out of attempts: a job that kills its worker would otherwise loop forever.
  const exhaustedCondition = and(stuck, sql`${files.attempts} >= ${MAX_ATTEMPTS}`);
  const failed = await db
    .update(files)
    .set({
      status: 'failed',
      lastError: sql`coalesce(${files.lastError}, 'gave up after ${sql.raw(String(MAX_ATTEMPTS))} attempts')`,
      lastActivityAt: now,
    })
    .where(
      and(
        inArray(
          files.id,
          db.select({ id: files.id }).from(files).where(exhaustedCondition).limit(SCHEDULER_BATCH_LIMIT),
        ),
        exhaustedCondition,
      ),
    )
    .returning({ id: files.id });

  // Counted right after the update, so a later failure cannot lose it.
  if (failed.length > 0) metrics.jobsDeadLettered.add(failed.length, { 'job.type': 'process_image' });

  // The outer condition repeats the staleness test: a concurrent run that claimed a row first changed its
  // last_activity_at, so this run skips it after the row lock is released.
  const retryCondition = and(stuck, sql`${files.attempts} < ${MAX_ATTEMPTS}`);
  const claimed = await db
    .update(files)
    .set({ lastActivityAt: now })
    .where(
      and(
        inArray(
          files.id,
          db.select({ id: files.id }).from(files).where(retryCondition).limit(SCHEDULER_BATCH_LIMIT),
        ),
        retryCondition,
      ),
    )
    .returning({ id: files.id });
  if (claimed.length > 0) await queue.sendBatch(claimed.map((f) => message('process_image', f.id, now)));
  return { processed: claimed.length + failed.length, requeued: claimed.length, failed: failed.length };
};

/** Days recomputed per run: a file that becomes ready after the previous run still lands in its day (D57). */
const STATS_RECOMPUTE_DAYS = 2;

/** Statistics of one UTC day, by creation day; upserted so a rerun overwrites. Returns the uploads counted. */
async function computeDay({ db, config }: CoreDeps, start: Date, end: Date): Promise<number> {
  const day = start.toISOString().slice(0, 10);
  const processingMs = sql`extract(epoch from (ready_at - queued_at)) * 1000`;
  const result = await db.execute(sql`
    insert into daily_stats (day, platform, uploads, ready, failed, bytes_in, p50_processing_ms, p95_processing_ms)
    select
      ${day}::date,
      ${config.platform},
      (count(*) filter (where queued_at is not null))::int,
      (count(*) filter (where ready_at is not null))::int,
      (count(*) filter (where status = 'failed' and queued_at is not null))::int,
      coalesce(sum(bytes) filter (where queued_at is not null), 0),
      round(percentile_cont(0.5) within group (order by ${processingMs}) filter (where ready_at is not null and queued_at is not null))::int,
      round(percentile_cont(0.95) within group (order by ${processingMs}) filter (where ready_at is not null and queued_at is not null))::int
    from files
    where created_at >= ${start.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz
    on conflict (day, platform) do update set
      uploads = excluded.uploads,
      ready = excluded.ready,
      failed = excluded.failed,
      bytes_in = excluded.bytes_in,
      p50_processing_ms = excluded.p50_processing_ms,
      p95_processing_ms = excluded.p95_processing_ms
    returning uploads
  `);
  // postgres-js returns the rows as an array, other drivers wrap them in `rows`.
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) as {
    uploads: number;
  }[];
  return rows?.[0]?.uploads ?? 0;
}

const dailyStatsJob: SchedulerJob = async (deps) => {
  const now = deps.clock.now();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let processed = 0;
  for (let back = STATS_RECOMPUTE_DAYS; back >= 1; back--) {
    processed += await computeDay(
      deps,
      new Date(today - back * DAY_MS),
      new Date(today - (back - 1) * DAY_MS),
    );
  }
  return { processed };
};

const JOBS: Record<SchedulerJobName, SchedulerJob> = {
  'cleanup-expired': cleanupExpired,
  'requeue-stuck': requeueStuck,
  'daily-stats': dailyStatsJob,
};

/** One span per run, a duration metric and a log line with `job`, duration and count (spec). */
export function createSchedulerJobs(
  deps: CoreDeps,
): Record<SchedulerJobName, () => Promise<{ processed: number }>> {
  const { tracer, logger, metrics } = deps.telemetry;
  const wrap = (name: SchedulerJobName) => async (): Promise<{ processed: number }> => {
    const started = deps.clock.now();
    return withSpan(tracer, `scheduler.${name}`, async (span) => {
      span.setAttribute('scheduler.job', name);
      try {
        const result = await JOBS[name](deps);
        const durationMs = deps.clock.now().getTime() - started.getTime();
        metrics.schedulerRunDurationMs.record(durationMs, { 'scheduler.job': name });
        logger.info('scheduler job finished', { ...result, job: name, durationMs });
        return { processed: result.processed };
      } catch (err) {
        const durationMs = deps.clock.now().getTime() - started.getTime();
        metrics.schedulerRunDurationMs.record(durationMs, { 'scheduler.job': name });
        logger.error('scheduler job failed', { job: name, durationMs, error: err });
        throw err;
      }
    });
  };
  return {
    'cleanup-expired': wrap('cleanup-expired'),
    'requeue-stuck': wrap('requeue-stuck'),
    'daily-stats': wrap('daily-stats'),
  };
}
