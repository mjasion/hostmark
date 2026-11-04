import type { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { MAX_ATTEMPTS } from '@hostmark/contract';
import { publicPaths } from '@hostmark/core';
import { createTelemetry } from '@hostmark/telemetry';
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createApiApp, sameSecret } from '../src/app';
import { ConfigError, parseVars } from '../src/env';
import { createCloudFrontPurger, invalidationPaths } from '../src/purge';
import { backoffSeconds, CrashSignal, createSqsQueue, handleSqsEvent } from '../src/queue';
import { isSchedulerEvent } from '../src/scheduler';

const base = {
  PUBLIC_URL: 'https://d111.cloudfront.net',
  DATABASE_URL: 'postgres://u:p@h/db',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'a',
  AWS_SECRET_ACCESS_KEY: 'b',
  S3_BUCKET: 'bucket',
  SQS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/1/q',
  CLOUDFRONT_DISTRIBUTION_ID: 'E1',
  ORIGIN_SECRET: 'o'.repeat(40),
};

describe('env', () => {
  it('accepts a complete production configuration', () => {
    expect(parseVars(base).ENVIRONMENT).toBe('production');
  });
  it('requires the purge target and the origin secret outside local', () => {
    const { CLOUDFRONT_DISTRIBUTION_ID, ORIGIN_SECRET, ...rest } = base;
    expect(() => parseVars(rest, 'api')).toThrow(/CLOUDFRONT_DISTRIBUTION_ID[\s\S]*ORIGIN_SECRET/);
    expect(() => parseVars({ ...rest, CLOUDFRONT_DISTRIBUTION_ID }, 'api')).toThrow(/ORIGIN_SECRET/);
    expect(() => parseVars({ ...rest, CLOUDFRONT_DISTRIBUTION_ID }, 'worker')).not.toThrow();
    expect(() => parseVars({ ...rest, ENVIRONMENT: 'local' }, 'api')).not.toThrow();
  });
  it('reports every invalid field', () => {
    const err = (() => {
      try {
        parseVars({ ...base, S3_BUCKET: 'a', BETTER_AUTH_SECRET: 'short' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toMatch(/BETTER_AUTH_SECRET[\s\S]*S3_BUCKET|S3_BUCKET[\s\S]*BETTER_AUTH_SECRET/);
  });
});

describe('secret comparison', () => {
  it('compares values of any length', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', 'abc')).toBe(false);
  });
});

describe('origin secret', () => {
  const secret = 'o'.repeat(40);
  const app = createApiApp(() => ({
    vars: { ORIGIN_SECRET: secret } as never,
    deps: { telemetry: createTelemetry('api'), config: { platform: 'aws-portable', version: 't' } } as never,
  }));
  it('refuses a request that did not come through CloudFront', async () => {
    expect((await app.request('/media/x/orig.jpg')).status).toBe(403);
    expect(
      (await app.request('/media/x/orig.jpg', { headers: { 'x-hostmark-origin-secret': 'no' } })).status,
    ).toBe(403);
  });
  it('lets a request with the secret reach the core app', async () => {
    const res = await app.request('/nothing-here', { headers: { 'x-hostmark-origin-secret': secret } });
    expect(res.status).toBe(404);
  });
  it('answers 500 without detail when the configuration is invalid', async () => {
    const broken = createApiApp(() => {
      throw new ConfigError('Invalid environment');
    });
    const res = await broken.request('/api/health');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('Invalid environment');
  });
});

/**
 * Models the in-progress quotas of one distribution (documentation, not measured): 15 wildcard paths and 3000 exact
 * paths may be in progress at once, independently. Nothing completes during the test, as in a burst that is faster
 * than propagation.
 */
function cloudFrontInProgress() {
  let wildcards = 0;
  let exact = 0;
  const calls: CreateInvalidationCommand[] = [];
  const client = {
    async send(command: CreateInvalidationCommand) {
      const items = command.input.InvalidationBatch?.Paths?.Items ?? [];
      const w = items.filter((p) => p.includes('*')).length;
      if (wildcards + w > 15 || exact + items.length - w > 3000)
        throw Object.assign(new Error('Too many invalidations in progress'), {
          name: 'TooManyInvalidationsInProgress',
        });
      wildcards += w;
      exact += items.length - w;
      calls.push(command);
      return {};
    },
  };
  return { client: client as never, calls };
}

describe('purge', () => {
  it('sends the exact public paths of a file, deduplicated, in one invalidation', async () => {
    const calls: CreateInvalidationCommand[] = [];
    const purger = createCloudFrontPurger(
      { send: async (c: never) => void calls.push(c) } as never,
      'E1',
      () => 'ref',
    );
    const id = '0190a8f0-0000-7000-8000-000000000001';
    await purger.purge([...publicPaths(id), `/f/${id}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      DistributionId: 'E1',
      InvalidationBatch: {
        CallerReference: 'ref',
        Paths: { Quantity: publicPaths(id).length, Items: publicPaths(id) },
      },
    });
  });
  it('refuses a wildcard path instead of spending one of the 15', () => {
    expect(invalidationPaths(['/f/a', '/f/a'])).toEqual(['/f/a']);
    expect(() => invalidationPaths(['/media/a/*'])).toThrow('wildcard');
  });
  it('takes a burst of 700 unpublishes without hitting the in-progress limit', async () => {
    const cf = cloudFrontInProgress();
    const purger = createCloudFrontPurger(cf.client, 'E1');
    const ids = Array.from({ length: 700 }, () => crypto.randomUUID());
    await Promise.all(ids.map((id) => purger.purge(publicPaths(id))));
    expect(cf.calls).toHaveLength(700);
    expect(cf.calls.flatMap((c) => c.input.InvalidationBatch?.Paths?.Items ?? []).join()).not.toContain('*');
  });
  it('lets a CloudFront error through so core answers 503 and delete_file retries (D100)', async () => {
    const cf = cloudFrontInProgress();
    const purger = createCloudFrontPurger(cf.client, 'E1');
    for (let i = 0; i < 750; i++) await purger.purge(publicPaths(crypto.randomUUID()));
    await expect(purger.purge(publicPaths(crypto.randomUUID()))).rejects.toThrow('in progress');
  });
});

describe('queue', () => {
  it('refuses a delay SQS cannot honour', async () => {
    const q = createSqsQueue({ send: async () => ({}) } as never, 'u');
    await expect(
      q.send(
        { v: 1, type: 'process_image', jobId: 'j', fileId: 'f', enqueuedAt: '', chaos: 'none' } as never,
        {
          delaySeconds: 901,
        },
      ),
    ).rejects.toThrow(RangeError);
  });
  it('fails the whole call when SQS refuses single entries of a batch', async () => {
    const q = createSqsQueue(
      { send: async () => ({ Failed: [{ Id: '0', Code: 'X', Message: 'no' }] }) } as never,
      'u',
    );
    await expect(q.sendBatch([{ jobId: 'j' } as never])).rejects.toThrow(/refused 1 of 1/);
  });
  it('follows D17 for the retry delays', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffSeconds(a))).toEqual([10, 30, 90, 270, 270]);
    expect(backoffSeconds(1, 0.1)).toBe(1);
  });

  const record = (body: unknown, count: number) =>
    ({
      messageId: 'm1',
      receiptHandle: 'h1',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      attributes: { ApproximateReceiveCount: String(count) },
    }) as never;
  const job = {
    v: 1,
    type: 'process_image',
    jobId: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    chaos: 'none',
  };

  async function run(count: number, handler: () => Promise<void>, body: unknown = job) {
    const sent: ChangeMessageVisibilityCommand[] = [];
    const res = await handleSqsEvent({ Records: [record(body, count)] } as SQSEvent, {
      handler,
      sqs: { send: async (c: never) => void sent.push(c) } as never,
      queueUrl: 'u',
    });
    return { res, sent };
  }

  it('acknowledges a message whose handler returned', async () => {
    const { res, sent } = await run(1, async () => {});
    expect(res.batchItemFailures).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('reports a failure and sets the backoff of the attempt', async () => {
    const { res, sent } = await run(2, async () => Promise.reject(new Error('x')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(sent[0]?.input).toMatchObject({ ReceiptHandle: 'h1', VisibilityTimeout: 30 });
  });
  it('makes the last failure visible at once so the redrive moves it to the dead letter queue', async () => {
    const { sent } = await run(MAX_ATTEMPTS, async () => Promise.reject(new Error('x')));
    expect(sent[0]?.input.VisibilityTimeout).toBe(0);
  });
  it('treats a body that is not a job as a failure', async () => {
    const { res } = await run(1, async () => {}, '{not json');
    expect(res.batchItemFailures).toHaveLength(1);
  });
  it('lets the crash chaos escape the handler so the invocation fails', async () => {
    await expect(
      handleSqsEvent({ Records: [record(job, 1)] } as SQSEvent, {
        handler: async (_m, ctx) => ctx.crash(),
        sqs: { send: async () => ({}) } as never,
        queueUrl: 'u',
      }),
    ).rejects.toBeInstanceOf(CrashSignal);
  });
});

describe('scheduler', () => {
  it('accepts the three jobs only', () => {
    expect(isSchedulerEvent({ job: 'requeue-stuck' })).toBe(true);
    expect(isSchedulerEvent({ job: 'drop-database' })).toBe(false);
    expect(isSchedulerEvent(null)).toBe(false);
  });
});
