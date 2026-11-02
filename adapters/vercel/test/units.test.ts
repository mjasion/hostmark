import { BACKOFF_SECONDS, type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { checkConfig } from '../scripts/check-config';
import { createCronHandler } from '../src/cron';
import { CLIENT_IP_HEADER, ConfigError, parseVars } from '../src/env';
import { cacheTag, createVercelPurger, tagOf } from '../src/purge';
import { backoffSeconds, createMessageProcessor, createVercelQueue, retryAfter } from '../src/queue';
import { sameSecret } from '../src/secret';
import { QueueStandIn } from './stand-in';

const base = {
  PUBLIC_URL: 'https://hostmark.example.com',
  DATABASE_URL: 'postgres://u:p@h/db',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'hostmark',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
  CRON_SECRET: 'c'.repeat(32),
};

const job: JobMessage = {
  v: 1,
  type: 'process_image',
  jobId: crypto.randomUUID(),
  fileId: crypto.randomUUID(),
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
};

describe('env', () => {
  it('accepts a complete configuration with defaults', () => {
    const vars = parseVars(base);
    expect(vars.S3_REGION).toBe('auto');
    expect(vars.QUEUE_TOPIC).toBe('image-jobs');
  });
  it('lists every invalid field', () => {
    const { CRON_SECRET, S3_BUCKET, ...rest } = base;
    expect(() => parseVars({ ...rest, BETTER_AUTH_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => parseVars(rest)).toThrow(/CRON_SECRET[\s\S]*S3_BUCKET|S3_BUCKET[\s\S]*CRON_SECRET/);
  });
  it('reads the client address from the header the platform sets', () => {
    expect(CLIENT_IP_HEADER).toBe('x-vercel-forwarded-for');
  });
});

describe('queue producer', () => {
  it('uses the job id as idempotency key and sends batches in chunks of 100', async () => {
    const sdk = new QueueStandIn();
    const queue = createVercelQueue(sdk, 'image-jobs');
    await queue.send(job);
    await queue.send(job);
    expect(sdk.pending('image-jobs')).toHaveLength(1);
    const batch = Array.from({ length: 250 }, () => ({ ...job, jobId: crypto.randomUUID() }));
    await queue.sendBatch(batch);
    expect(sdk.pending('image-jobs')).toHaveLength(251);
  });
  it('fails a batch in which the platform refused an entry', async () => {
    const queue = createVercelQueue(
      {
        send: async () => ({}),
        sendBatch: async () => [{ status: 'success' }, { status: 'failed', error: 'x' }],
      },
      'image-jobs',
    );
    await expect(queue.sendBatch([job, job])).rejects.toThrow(/refused 1 of 2/);
  });
});

describe('queue consumer (D17)', () => {
  it('backs off by the contract table and holds the last value', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([
      ...BACKOFF_SECONDS,
      BACKOFF_SECONDS.at(-1),
      BACKOFF_SECONDS.at(-1),
    ]);
    expect(retryAfter(new Error('x'), { messageId: 'm', deliveryCount: 2 })).toEqual({
      afterSeconds: BACKOFF_SECONDS[1],
    });
  });
  it('passes the delivery count as attempt and acknowledges on success', async () => {
    const seen: number[] = [];
    const process = createMessageProcessor({
      handler: async (_m, ctx) => void seen.push(ctx.attempt),
      deadLetter: async () => {
        throw new Error('not expected');
      },
    });
    await process(job, { messageId: 'm', deliveryCount: 3 });
    expect(seen).toEqual([3]);
  });
  it('rethrows a failure until the last attempt, then dead-letters and acknowledges', async () => {
    const dead: unknown[] = [];
    const process = createMessageProcessor({
      handler: async () => {
        throw new Error('boom');
      },
      deadLetter: async (p) => void dead.push(p),
    });
    for (let n = 1; n < MAX_ATTEMPTS; n++)
      await expect(process(job, { messageId: 'm', deliveryCount: n })).rejects.toThrow('boom');
    expect(dead).toEqual([]);
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_ATTEMPTS })).resolves.toBeUndefined();
    expect(dead).toEqual([job]);
  });
  it('retries when the dead letter send fails', async () => {
    const process = createMessageProcessor({
      handler: async () => {
        throw new Error('boom');
      },
      deadLetter: async () => {
        throw new Error('dlq down');
      },
    });
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_ATTEMPTS })).rejects.toThrow('dlq down');
  });
  it('dead-letters a body that is no job message without running the handler', async () => {
    const dead: unknown[] = [];
    const process = createMessageProcessor({
      handler: async () => {
        throw new Error('not expected');
      },
      deadLetter: async (p) => void dead.push(p),
    });
    await process({ hello: 'world' }, { messageId: 'm', deliveryCount: 1 });
    expect(dead).toEqual([{ hello: 'world' }]);
  });
  it('lets chaos=crash fail the delivery even on the last attempt', async () => {
    const process = createMessageProcessor({
      handler: async (_m, ctx) => ctx.crash(),
      deadLetter: async () => {
        throw new Error('not expected');
      },
    });
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_ATTEMPTS })).rejects.toThrow(
      /chaos=crash/,
    );
  });
});

describe('cache purge (D100)', () => {
  const id = crypto.randomUUID().toUpperCase();
  it('maps /media and /f paths of one file to one tag', () => {
    expect(tagOf(`/media/${id}/thumb.webp`)).toBe(cacheTag(id));
    expect(tagOf(`/f/${id}`)).toBe(`file-${id.toLowerCase()}`);
    expect(tagOf('/api/files')).toBeUndefined();
    expect(tagOf('/media/not-a-uuid/x')).toBeUndefined();
  });
  it('deletes each tag once and nothing for unrelated paths', async () => {
    const calls: string[][] = [];
    const purger = createVercelPurger(async (tags) => void calls.push(tags));
    await purger.purge([`/media/${id}/a.webp`, `/media/${id}/b.webp`, `/f/${id}`]);
    await purger.purge(['/other']);
    expect(calls).toEqual([[cacheTag(id)]]);
  });
});

describe('cron route', () => {
  const runtime = () => ({ deps: {} as never, vars: parseVars(base) });
  const handler = createCronHandler(runtime);
  const call = (url: string, authorization?: string) =>
    handler(new Request(url, { headers: authorization ? { authorization } : {} }));
  it('refuses a caller without the cron secret', async () => {
    expect((await call('https://x/api/cron?job=daily-stats')).status).toBe(401);
    expect((await call('https://x/api/cron?job=daily-stats', 'Bearer wrong')).status).toBe(401);
  });
  it('refuses an unknown job', async () => {
    expect((await call('https://x/api/cron?job=drop-tables', `Bearer ${base.CRON_SECRET}`)).status).toBe(400);
    expect((await call('https://x/api/cron?job=constructor', `Bearer ${base.CRON_SECRET}`)).status).toBe(400);
  });
  it('compares secrets in full', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});

describe('vercel.json', () => {
  it('is valid against the published schema subset and the contract', () => {
    expect(checkConfig()).toEqual([]);
  });
  it('rejects an unknown property, a missing job and a consumer on the dead letter topic', () => {
    const config = {
      surprise: true,
      crons: [{ path: '/api/cron?job=daily-stats', schedule: '5 0 * * *' }],
      functions: {
        'api/queue.ts': { experimentalTriggers: [{ type: 'queue/v2beta', topic: 'image-jobs-dlq' }] },
      },
    };
    const problems = checkConfig(config).join('\n');
    expect(problems).toMatch(/unknown property "surprise"/);
    expect(problems).toMatch(/no entry for requeue-stuck/);
    expect(problems).toMatch(/no queue trigger for the topic image-jobs/);
    expect(problems).toMatch(/dead letter topic must have no consumer/);
  });
});
