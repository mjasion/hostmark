// One active scheduler per database, whatever the replica count (D204). The replica that holds a session-level
// Postgres advisory lock runs the cron jobs; the others wait and take over when its connection ends.
import postgres from 'postgres';

/** The advisory lock key of the scheduler: the bytes of "hmsched" as a bigint. Shared by every replica. */
export const SCHEDULER_LOCK_KEY = 0x686d7363686564n;

export interface LeaderLock {
  /** Takes the lock if no other session holds it. True while this session holds it. */
  tryAcquire(): Promise<boolean>;
  /** True if this session still holds the lock; false if its connection was lost and the lock with it. */
  held(): Promise<boolean>;
  /** Releases the lock and closes the connection. */
  close(): Promise<void>;
}

/**
 * A session-level advisory lock on a dedicated connection. The lock lives exactly as long as the session, so the
 * connection must never be recycled behind our back: one connection, no idle timeout and no maximum lifetime. A
 * dropped connection releases the lock on the server; `held()` notices and the scheduler steps down.
 */
export function createPostgresLeaderLock(databaseUrl: string, key = SCHEDULER_LOCK_KEY): LeaderLock {
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const k = key.toString();
  return {
    async tryAcquire() {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${k}::bigint) as ok`;
      return row?.ok === true;
    },
    async held() {
      // pg_locks splits a bigint key into classid (high 32 bits) and objid (low 32 bits), with objsubid 1.
      const [row] = await sql<{ held: boolean }[]>`
        select exists (
          select 1 from pg_locks
          where locktype = 'advisory' and objsubid = 1 and granted and pid = pg_backend_pid()
            and ((classid::bigint << 32) | objid::bigint) = ${k}::bigint
        ) as held`;
      return row?.held === true;
    },
    async close() {
      try {
        await sql`select pg_advisory_unlock(${k}::bigint)`;
      } catch {
        // The connection is gone, and the lock with it.
      }
      await sql.end({ timeout: 5 });
    },
  };
}

export interface LeaderLoopOptions {
  lock: LeaderLock;
  /** Called when this replica becomes the leader. */
  start(): void;
  /** Called when it stops being the leader; resolves when the jobs in flight have finished. */
  stop(): Promise<void>;
  /** Milliseconds between attempts to take the lock, and between checks that it is still held. */
  intervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, attrs?: Record<string, unknown>) => void;
}

export interface LeaderLoop {
  isLeader(): boolean;
  /** Ends the loop, stops the jobs if this replica leads, and releases the lock. */
  close(): Promise<void>;
}

/** Polls the lock: a follower tries to take it, a leader checks that it still holds it. */
export function runLeaderLoop(opts: LeaderLoopOptions): LeaderLoop {
  const intervalMs = opts.intervalMs ?? 5_000;
  const log = opts.log ?? (() => {});
  let leader = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: Promise<void> = Promise.resolve();

  async function once(): Promise<void> {
    try {
      if (!leader) {
        if (await opts.lock.tryAcquire()) {
          leader = true;
          log('info', 'scheduler leadership acquired');
          opts.start();
        }
      } else if (!(await opts.lock.held())) {
        leader = false;
        log('error', 'scheduler leadership lost, stopping the jobs');
        await opts.stop();
      }
    } catch (err) {
      // A database error: a leader can no longer prove it holds the lock, so it steps down.
      log('warn', 'scheduler leadership check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (leader) {
        leader = false;
        await opts.stop();
      }
    }
  }

  function schedule(delay: number): void {
    if (closed) return;
    timer = setTimeout(() => {
      tick = once().finally(() => schedule(intervalMs));
    }, delay);
  }
  schedule(0);

  return {
    isLeader: () => leader,
    async close() {
      closed = true;
      clearTimeout(timer);
      await tick;
      if (leader) {
        leader = false;
        await opts.stop();
      }
      await opts.lock.close();
    },
  };
}
