import { type ChildProcess, spawn } from 'node:child_process';
import { type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { Queue as BullQueue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import { createBullQueue, createDlq, redisConnection } from '../src/queue';

// Real worker processes, real BullMQ lock and stall timings (shortened to seconds). B2: a job that kills its worker
// again and again must end up in the dead letter queue, with the attempt numbers counting every start.
const redisUrl = process.env.REDIS_TEST_URL;

const message = (): JobMessage => ({
  v: 1,
  type: 'process_image',
  jobId: crypto.randomUUID(),
  fileId: crypto.randomUUID(),
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
});

describe.skipIf(!redisUrl)('a job that keeps killing its worker (B2)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function run(mode: 'die' | 'die-twice') {
    const url = redisUrl as string;
    const name = `stall-${crypto.randomUUID()}`;
    const queue = createBullQueue(url, name);
    const dlq = createDlq(url);
    const bull = new BullQueue(name, { connection: redisConnection(url) });
    const msg = message();
    const attempts: number[] = [];
    let stop = false;
    let child: ChildProcess | undefined;
    const start = () => {
      child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/stall-child.ts'], {
        // The child resolves tsx from this package, whatever directory vitest runs in (root `pnpm test`).
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, REDIS_URL: url, QUEUE: name, MODE: mode },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.startsWith('{')) attempts.push((JSON.parse(line) as { attempt: number }).attempt);
        }
      });
      child.on('exit', () => {
        if (!stop) setTimeout(start, 100);
      });
    };
    cleanups.push(async () => {
      stop = true;
      child?.kill('SIGKILL');
      await bull.obliterate({ force: true }).catch(() => {});
      await bull.close();
      await queue.close();
      await dlq.close();
    });

    await queue.send(msg);
    start();
    const deadline = Date.now() + 60_000;
    for (;;) {
      const [job] = await bull.getJobs(['failed']);
      if (job) break;
      if (Date.now() > deadline) throw new Error(`job did not fail; attempts so far ${attempts}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 1000));
    const copies = (await dlq.getJobs(['waiting', 'delayed', 'completed', 'failed'], 0, -1)).filter(
      (j) => j.data.jobId === msg.jobId,
    );
    return { attempts, dlqAdded: copies.length };
  }

  it('fails after MAX_ATTEMPTS starts and leaves one dead letter copy', async () => {
    const { attempts, dlqAdded } = await run('die');
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(attempts).toHaveLength(MAX_ATTEMPTS);
    expect(dlqAdded).toBe(1);
  }, 90_000);

  it('counts stalled starts as attempts and fails the last one for good', async () => {
    const { attempts, dlqAdded } = await run('die-twice');
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(dlqAdded).toBe(1);
  }, 90_000);
});
