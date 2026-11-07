import { readFileSync } from 'node:fs';
import { BACKOFF_SECONDS, type JobMessage, MAX_ATTEMPTS, RUM_REGIONS } from '@hostmark/contract';
import { dangerouslyDeleteByTag, type PurgeApi } from '@vercel/functions';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, checkPackage } from '../scripts/check-config';
import { cdnCacheControl } from '../src/app';
import { buildVersion, rumRegionOf, VERCEL_REGIONS, withBuildDefaults } from '../src/build-info';
import { createCronHandler, jobOf } from '../src/cron';
import { CLIENT_IP_HEADER, ConfigError, parseVars } from '../src/env';
import {
  cacheTag,
  contextPurgeApi,
  createVercelPurger,
  deleteByTagInContext,
  PurgeUnavailableError,
  tagOf,
} from '../src/purge';
import {
  backoffSeconds,
  createMessageProcessor,
  createVercelQueue,
  deadLetterTopic,
  MAX_DELIVERIES,
  retryAfter,
} from '../src/queue';
import { createRuntime } from '../src/runtime';
import { sameSecret } from '../src/secret';
import { QueueStandIn } from './stand-in';

const vercelJson = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

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
    // D7, D335: signup stays off unless the deployment turns it on.
    expect(vars.AUTH_SIGNUP_ENABLED).toBe('false');
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
  it('never runs the job after the last attempt, only dead-letters it under the message id', async () => {
    const dead: [unknown, string, string][] = [];
    const process = createMessageProcessor({
      handler: async () => {
        throw new Error('not expected');
      },
      deadLetter: async (p, reason, messageId) => void dead.push([p, reason, messageId]),
    });
    await process(job, { messageId: 'm-6', deliveryCount: MAX_ATTEMPTS + 1 });
    expect(dead).toEqual([[job, expect.stringMatching(/not run again/), 'm-6']]);
  });
  it('keeps the dead letter copy when the send of the last attempt failed (D198)', async () => {
    // Like core: the last attempt marks the file failed and throws; a later run finds nothing to claim and returns.
    let runs = 0;
    const handler = async (_m: JobMessage, ctx: { attempt: number }) => {
      runs++;
      if (ctx.attempt <= MAX_ATTEMPTS) throw new Error('boom');
    };
    const dead: unknown[] = [];
    let sendFails = 1;
    const process = createMessageProcessor({
      handler,
      deadLetter: async (p) => {
        if (sendFails-- > 0) throw new Error('dlq down');
        dead.push(p);
      },
    });
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_ATTEMPTS })).rejects.toThrow('dlq down');
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_ATTEMPTS + 1 })).resolves.toBeUndefined();
    expect(dead).toEqual([job]);
    expect(runs).toBe(1);
  });
  it('logs the payload when the last delivery cannot dead-letter either', async () => {
    const logs: [string, Record<string, unknown>][] = [];
    const process = createMessageProcessor({
      handler: async () => {},
      deadLetter: async () => {
        throw new Error('dlq down');
      },
      log: (msg, fields) => void logs.push([msg, fields]),
    });
    await expect(process(job, { messageId: 'm', deliveryCount: MAX_DELIVERIES })).rejects.toThrow('dlq down');
    expect(logs).toEqual([
      [expect.stringMatching(/copy is lost/), expect.objectContaining({ payload: job })],
    ]);
  });
});

describe('killer job on the model of Vercel Queues (maxDeliveries)', () => {
  const TOPIC = 'image-jobs';
  /** The platform ends a delivery that never returns (out of memory, `maxDuration`): the processor cannot catch it. */
  const killedAfter = (ms: number) =>
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('killed by the platform')), ms));

  async function drain(platform: QueueStandIn, run: (p: unknown, n: number, id: string) => Promise<void>) {
    let deliveries = 0;
    while (await platform.deliver(TOPIC, run)) deliveries++;
    return deliveries;
  }

  it('starts a job that kills every delivery MAX_ATTEMPTS times, then dead-letters it', async () => {
    const platform = new QueueStandIn(0, MAX_DELIVERIES);
    await createVercelQueue(platform, TOPIC).send(job);
    let starts = 0;
    const process = createMessageProcessor({
      handler: async () => {
        starts++;
        await new Promise(() => {});
      },
      deadLetter: async (p, _r, id) =>
        void (await platform.send(deadLetterTopic(TOPIC), p, { idempotencyKey: id })),
    });
    const deliveries = await drain(platform, (p, n, id) =>
      Promise.race([process(p, { messageId: id, deliveryCount: n }), killedAfter(5)]),
    );
    expect({ starts, deliveries }).toEqual({ starts: MAX_ATTEMPTS, deliveries: MAX_ATTEMPTS + 1 });
    expect(platform.pending(deadLetterTopic(TOPIC))).toEqual([job]);
    expect(platform.pending(TOPIC)).toEqual([]);
  });

  it('stops after maxDeliveries when the dead letter send keeps failing', async () => {
    const platform = new QueueStandIn(0, MAX_DELIVERIES);
    await createVercelQueue(platform, TOPIC).send(job);
    let starts = 0;
    const process = createMessageProcessor({
      handler: async () => {
        starts++;
        throw new Error('boom');
      },
      deadLetter: async () => {
        throw new Error('dlq down');
      },
    });
    const deliveries = await drain(platform, (p, n, id) => process(p, { messageId: id, deliveryCount: n }));
    expect({ starts, deliveries }).toEqual({ starts: MAX_ATTEMPTS, deliveries: MAX_DELIVERIES });
    expect(platform.dropped).toEqual([job]);
  });

  it('is bounded in vercel.json', () => {
    const trigger = vercelJson.functions['api/queue.js'].experimentalTriggers[0];
    expect(trigger).toMatchObject({ topic: 'image-jobs', maxDeliveries: MAX_DELIVERIES });
    expect(MAX_DELIVERIES).toBeGreaterThan(MAX_ATTEMPTS);
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

  const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
  const holder = globalThis as unknown as Record<symbol, unknown>;
  afterEach(() => {
    delete holder[REQUEST_CONTEXT];
  });
  const fakePurge = (deleted: string[][]): PurgeApi => ({
    invalidateByTag: async () => {},
    dangerouslyDeleteByTag: async (tag) => void deleted.push([tag].flat()),
    invalidateBySrcImage: async () => {},
    dangerouslyDeleteBySrcImage: async () => {},
  });

  it('fails a purge without a request context, where the SDK does nothing (D100)', async () => {
    await expect(dangerouslyDeleteByTag(['file-x'])).resolves.toBeUndefined();
    await expect(deleteByTagInContext(['file-x'])).rejects.toThrow(PurgeUnavailableError);
    await expect(createVercelPurger().purge([`/f/${id}`])).rejects.toThrow(PurgeUnavailableError);
  });

  it('reads the request context where @vercel/functions reads it', async () => {
    const viaSdk: string[][] = [];
    const viaAdapter: string[][] = [];
    holder[REQUEST_CONTEXT] = { get: () => ({ purge: fakePurge(viaSdk) }) };
    await dangerouslyDeleteByTag(['file-a']);
    holder[REQUEST_CONTEXT] = { get: () => ({ purge: fakePurge(viaAdapter) }) };
    expect(contextPurgeApi()).toBeDefined();
    await createVercelPurger().purge([`/media/${id}/128.webp`, `/f/${id}`]);
    expect(viaSdk).toEqual([['file-a']]);
    expect(viaAdapter).toEqual([[cacheTag(id)]]);
  });
});

describe('CDN headers (D199)', () => {
  it('keeps /media for a year and the /f page as core asks, both only when shared caching is allowed', () => {
    expect(cdnCacheControl(`/media/x/128.webp`, 'public, max-age=31536000, immutable')).toBe(
      'public, max-age=31536000, immutable',
    );
    // PUBLIC_PAGE_CACHE of packages/core/src/http/public.ts: no `public`, which hid /f from the CDN headers.
    expect(cdnCacheControl('/f/x', 's-maxage=60, stale-while-revalidate=600')).toBe(
      'max-age=60, stale-while-revalidate=600',
    );
    for (const cc of ['private, no-store', 'no-store', null, 'max-age=60'])
      expect(cdnCacheControl('/f/x', cc), String(cc)).toBeUndefined();
    expect(cdnCacheControl('/media/x/128.webp', 'private, max-age=60')).toBeUndefined();
  });
});

describe('region and version', () => {
  it('runs the functions in one region of vercel.json, named in the RUM list', () => {
    expect(vercelJson.regions).toEqual(['fra1']);
    expect(rumRegionOf(vercelJson)).toBe('frankfurt');
    for (const name of Object.values(VERCEL_REGIONS)) expect(RUM_REGIONS).toContain(name);
    expect(() => rumRegionOf({})).toThrow(/exactly one/);
    expect(() => rumRegionOf({ regions: ['fra1', 'iad1'] })).toThrow(/exactly one/);
    expect(() => rumRegionOf({ regions: ['arn1'] })).toThrow(/no RUM region/);
  });
  it('takes the version from APP_VERSION, the commit Vercel builds, the checkout, or dev', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(buildVersion({ APP_VERSION: 'v1' }, () => 'abc1234')).toBe('v1');
    expect(buildVersion({ VERCEL_GIT_COMMIT_SHA: sha }, () => 'abc1234')).toBe('0123456');
    expect(buildVersion({}, () => 'abc1234')).toBe('abc1234');
    expect(buildVersion({}, () => undefined)).toBe('dev');
  });
  it('reports the build region and version unless the project sets them', () => {
    const build = { region: 'frankfurt', version: 'abc1234' };
    const vars = parseVars(withBuildDefaults(base, build));
    expect([vars.HOSTMARK_REGION, vars.APP_VERSION]).toEqual(['frankfurt', 'abc1234']);
    const own = parseVars(withBuildDefaults({ ...base, HOSTMARK_REGION: 'us-east', APP_VERSION: '' }, build));
    expect([own.HOSTMARK_REGION, own.APP_VERSION]).toEqual(['us-east', 'abc1234']);
    expect(parseVars(withBuildDefaults(base, {})).APP_VERSION).toBe('dev');
  });
  it('passes region and version to core', async () => {
    const runtime = createRuntime(withBuildDefaults(base, { region: 'frankfurt', version: 'abc1234' }), {
      service: 'api',
      images: {} as never,
      queueSdk: new QueueStandIn(),
      purger: createVercelPurger(async () => {}),
    });
    expect(runtime.deps.config).toMatchObject({
      platform: 'vercel-portable',
      version: 'abc1234',
      rum: { region: 'frankfurt' },
    });
    await runtime.close();
  });
});

describe('cron route', () => {
  const runtime = () => ({ deps: { config: { publicUrl: 'https://x' } } as never, vars: parseVars(base) });
  const handler = createCronHandler(runtime);
  const call = (url: string, authorization?: string) =>
    handler(new Request(url, { headers: authorization ? { authorization } : {} }));
  it('refuses a caller without the cron secret', async () => {
    const refused = await call('https://x/api/cron/daily-stats');
    expect(refused.status).toBe(401);
    // D310: the API's headers, as on every other /api answer.
    expect(Object.fromEntries(refused.headers)).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'strict-transport-security': 'max-age=31536000',
    });
    expect((await call('https://x/api/cron/daily-stats', 'Bearer wrong')).status).toBe(401);
    expect((await call('https://x/api/cron?job=daily-stats', 'Bearer wrong')).status).toBe(401);
  });
  it('refuses an unknown job', async () => {
    for (const path of [
      '/api/cron/drop-tables',
      '/api/cron/constructor',
      '/api/cron?job=constructor',
      '/api/cron',
    ])
      expect((await call(`https://x${path}`, `Bearer ${base.CRON_SECRET}`)).status, path).toBe(400);
  });
  it('reads the job from the path as sent, or from the query the rewrite adds (D272)', () => {
    expect(jobOf(new URL('https://x/api/cron/requeue-stuck'))).toBe('requeue-stuck');
    expect(jobOf(new URL('https://x/api/cron?job=requeue-stuck'))).toBe('requeue-stuck');
    // The original path wins over a query the caller added.
    expect(jobOf(new URL('https://x/api/cron/daily-stats?job=cleanup-expired'))).toBe('daily-stats');
    expect(jobOf(new URL('https://x/api/cron?job=daily-stats&job=cleanup-expired'))).toBe('');
    expect(jobOf(new URL('https://x/api/cron/daily%2Dstats'))).toBe('daily%2Dstats');
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
    expect(checkPackage()).toEqual([]);
    // D279: the Node major of the functions and the build is pinned in package.json.
    expect(checkPackage({ engines: { node: '>=22' } })).toEqual([
      'package.json: engines.node must be "22.x"',
    ]);
    expect(checkPackage({})).toHaveLength(1);
  });
  it('rejects an unknown property, a missing job and a consumer on the dead letter topic', () => {
    const config = {
      surprise: true,
      crons: [
        { path: '/api/cron/daily-stats', schedule: '5 0 * * *' },
        { path: '/api/cron?job=requeue-stuck', schedule: '*/5 * * * *' },
      ],
      functions: {
        'api/queue.ts': { experimentalTriggers: [{ type: 'queue/v2beta', topic: 'image-jobs-dlq' }] },
      },
    };
    const problems = checkConfig(config).join('\n');
    expect(problems).toMatch(/unknown property "surprise"/);
    expect(problems).toMatch(/no entry for requeue-stuck/);
    expect(problems).toMatch(/no queue trigger for the topic image-jobs/);
    expect(problems).toMatch(/dead letter topic must have no consumer/);
    expect(problems).toMatch(/\/api\/cron\?job=requeue-stuck names no scheduler job/);
  });
  it('rejects unbundled functions, a missing region and an unbounded trigger', () => {
    const config = structuredClone(vercelJson);
    config.buildCommand = 'pnpm --filter @hostmark/web build';
    delete config.regions;
    config.functions['api/index.ts'] = config.functions['api/index.js'];
    delete config.functions['api/index.js'];
    delete config.functions['api/queue.js'].includeFiles;
    delete config.functions['api/queue.js'].experimentalTriggers[0].maxDeliveries;
    const problems = checkConfig(config).join('\n');
    expect(problems).toMatch(/buildCommand: must be/);
    expect(problems).toMatch(/regions: .*exactly one/);
    expect(problems).toMatch(/"api\/index.ts" is not a bundled function/);
    expect(problems).toMatch(/no entry for api\/index.js/);
    expect(problems).toMatch(/api\/queue.js must ship the codecs/);
    expect(problems).toMatch(new RegExp(`maxDeliveries ${MAX_DELIVERIES}`));
  });
  it('rejects a short api maxDuration, a concurrent consumer, an unpinned install and missing cache headers', () => {
    const config = structuredClone(vercelJson);
    config.functions['api/index.js'].maxDuration = 60;
    delete config.functions['api/queue.js'].maxConcurrency;
    config.installCommand = 'cd ../.. && pnpm install --frozen-lockfile';
    config.headers = config.headers.slice(0, 1);
    config.rewrites = config.rewrites.slice(1);
    const problems = checkConfig(config).join('\n');
    expect(problems).toMatch(/api\/index.js needs a maxDuration of at least 90 s/);
    expect(problems).toMatch(/api\/queue.js must set maxConcurrency 1/);
    expect(problems).toMatch(/installCommand: must install with pnpm 12.18.0/);
    expect(problems).toMatch(/headers: \/rum.js must get Cache-Control public, max-age=300/);
    expect(problems).toMatch(/headers: \/ must get/);
    expect(problems).toMatch(/rewrites: the first must send \/api\/cron\/:job/);
  });
});
