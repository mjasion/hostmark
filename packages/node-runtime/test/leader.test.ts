// The scheduler's leader lock against a real Postgres (D204). Set DATABASE_URL to run it.
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresLeaderLock, type LeaderLock, runLeaderLoop } from '../src/leader';

const databaseUrl = process.env.DATABASE_URL;

/** A key per test, so parallel runs and other suites never share a lock. */
const freshKey = () => BigInt(Math.floor(Math.random() * 2 ** 40)) + 1n;

async function until(what: string, fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!databaseUrl)('Postgres leader lock', () => {
  const open: LeaderLock[] = [];
  const lock = (key: bigint) => {
    const l = createPostgresLeaderLock(databaseUrl as string, key);
    open.push(l);
    return l;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((l) => l.close()));
  });

  it('lets one session hold the lock, and the next take it once the first releases it', async () => {
    const key = freshKey();
    const a = lock(key);
    const b = lock(key);
    expect(await a.tryAcquire()).toBe(true);
    expect(await a.held()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await b.held()).toBe(false);
    await a.close();
    expect(await b.tryAcquire()).toBe(true);
  });

  it('keys with the high 32 bits set are matched in pg_locks', async () => {
    const a = lock((1n << 40n) + 7n);
    expect(await a.tryAcquire()).toBe(true);
    expect(await a.held()).toBe(true);
  });

  it('notices a lost connection: held() fails or answers false, and another session gets the lock', async () => {
    const key = freshKey();
    const a = lock(key);
    expect(await a.tryAcquire()).toBe(true);
    const admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
    try {
      const k = key.toString();
      await admin`
        select pg_terminate_backend(pid) from pg_locks
        where locktype = 'advisory' and objsubid = 1 and ((classid::bigint << 32) | objid::bigint) = ${k}::bigint`;
    } finally {
      await admin.end();
    }
    // postgres.js reconnects on the next query, as a new session without the lock.
    const stillHeld = await a.held().catch(() => false);
    expect(stillHeld).toBe(false);
    expect(await lock(key).tryAcquire()).toBe(true);
  });

  it('runs the jobs on exactly one of two replicas and fails over when the leader stops', async () => {
    const key = freshKey();
    const running = new Set<string>();
    const replica = (name: string) =>
      runLeaderLoop({
        lock: lock(key),
        intervalMs: 50,
        start: () => running.add(name),
        stop: async () => {
          running.delete(name);
        },
      });
    const first = replica('first');
    await until('a leader', () => running.size === 1);
    const second = replica('second');
    await new Promise((r) => setTimeout(r, 300));
    expect([...running]).toEqual(['first']);
    expect(first.isLeader()).toBe(true);
    expect(second.isLeader()).toBe(false);

    await first.close();
    await until('fail-over', () => running.has('second'));
    expect([...running]).toEqual(['second']);
    await second.close();
    expect(running.size).toBe(0);
  });
});

describe('leader loop', () => {
  it('steps down when the lock is lost and takes it again when it becomes free', async () => {
    let free = true;
    let mine = false;
    const fake: LeaderLock = {
      tryAcquire: async () => {
        if (!free) return false;
        free = false;
        mine = true;
        return true;
      },
      held: async () => mine,
      close: async () => {},
    };
    const events: string[] = [];
    const loop = runLeaderLoop({
      lock: fake,
      intervalMs: 10,
      start: () => events.push('start'),
      stop: async () => {
        events.push('stop');
      },
    });
    await until('start', () => events.length === 1);
    mine = false; // the connection dropped; someone else holds it now
    await until('stop', () => events.length === 2);
    free = true;
    await until('restart', () => events.length === 3);
    await loop.close();
    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('steps down when the check itself fails', async () => {
    let fail = false;
    const fake: LeaderLock = {
      tryAcquire: async () => !fail,
      held: async () => {
        if (fail) throw new Error('connection refused');
        return true;
      },
      close: async () => {},
    };
    let leading = false;
    const loop = runLeaderLoop({
      lock: fake,
      intervalMs: 10,
      start: () => {
        leading = true;
      },
      stop: async () => {
        leading = false;
      },
    });
    await until('leading', () => leading);
    fail = true;
    await until('stepped down', () => !leading);
    await loop.close();
  });
});
