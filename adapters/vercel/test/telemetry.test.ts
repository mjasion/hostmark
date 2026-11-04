// D274: each function reports as its own service, exports over OTLP when OTLP_ENDPOINT is set, and flushes after
// every invocation through `waitUntil`. The exporter and `waitUntil` are fakes here; the real export is covered by
// `packages/telemetry` (`flush` against a local OTLP receiver).
import type { NodeTelemetry, NodeTelemetryOptions } from '@hostmark/telemetry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTelemetryFlush } from '../src/flush';
import { createVercelPurger } from '../src/purge';
import { coalesce, createRuntime, type Service } from '../src/runtime';
import { QueueStandIn } from './stand-in';

const base = {
  PUBLIC_URL: 'https://hostmark.example.com',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'hostmark',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
  CRON_SECRET: 'c'.repeat(32),
};

function fakeExporter() {
  const calls = { started: [] as NodeTelemetryOptions[], lines: [] as string[], flushes: 0, shutdowns: 0 };
  let release: (() => void) | undefined;
  const start = (opts: NodeTelemetryOptions): NodeTelemetry => {
    calls.started.push(opts);
    return {
      write: (line) => void calls.lines.push(line),
      flush: () => {
        calls.flushes++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      shutdown: async () => void calls.shutdowns++,
    };
  };
  return { calls, start, release: () => release?.() };
}

const runtimeOf = (
  service: Service,
  env: Record<string, string>,
  start?: (o: NodeTelemetryOptions) => NodeTelemetry,
) =>
  createRuntime(env, {
    service,
    images: {} as never,
    queueSdk: new QueueStandIn(),
    purger: createVercelPurger(async () => {}),
    ...(start ? { startTelemetry: start } : {}),
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('telemetry per function (D274)', () => {
  it('starts no exporter without OTLP_ENDPOINT and logs as the given service', async () => {
    const fake = fakeExporter();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runtime = runtimeOf('worker', base, fake.start);
    runtime.deps.telemetry.logger.info('hello');
    expect(fake.calls.started).toEqual([]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ msg: 'hello', service: 'worker' });
    await expect(runtime.flush()).resolves.toBeUndefined();
    await runtime.close();
  });

  it('exports as the given service when OTLP_ENDPOINT is set, and shuts the exporter down on close', async () => {
    const fake = fakeExporter();
    const runtime = runtimeOf(
      'scheduler',
      { ...base, OTLP_ENDPOINT: 'https://otlp.example', APP_VERSION: 'abc1234', ENVIRONMENT: 'bench' },
      fake.start,
    );
    expect(fake.calls.started).toEqual([
      {
        service: 'scheduler',
        platform: 'vercel-portable',
        variant: 'portable',
        imageImpl: 'wasm',
        version: 'abc1234',
        environment: 'bench',
        otlpEndpoint: 'https://otlp.example',
      },
    ]);
    runtime.deps.telemetry.logger.warn('ran');
    expect(JSON.parse(fake.calls.lines[0] ?? '{}')).toMatchObject({ msg: 'ran', service: 'scheduler' });
    await runtime.close();
    expect(fake.calls.shutdowns).toBe(1);
  });

  it('refuses an OTLP_ENDPOINT that is no http or https URL', () => {
    expect(() => runtimeOf('api', { ...base, OTLP_ENDPOINT: 'ftp://otlp.example' })).toThrow(/OTLP_ENDPOINT/);
  });

  it('runs one flush at a time: calls during a run share one more run', async () => {
    const fake = fakeExporter();
    const runtime = runtimeOf('api', { ...base, OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, fake.start);
    const first = runtime.flush();
    const second = runtime.flush();
    const third = runtime.flush();
    expect(second).toBe(third);
    expect(fake.calls.flushes).toBe(1);
    fake.release();
    await first;
    await vi.waitFor(() => expect(fake.calls.flushes).toBe(2));
    fake.release();
    await Promise.all([second, third]);
    expect(fake.calls.flushes).toBe(2);
    await runtime.close();
  });

  it('coalesce runs again after a failed run', async () => {
    let n = 0;
    const run = coalesce(async () => {
      n++;
      if (n === 1) throw new Error('collector down');
    });
    const a = run();
    const b = run();
    await expect(a).rejects.toThrow('collector down');
    await expect(b).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
});

describe('flush after each invocation (D274)', () => {
  it('hands the flush to waitUntil once the response exists, also when the handler fails', async () => {
    const order: string[] = [];
    const handed: Promise<unknown>[] = [];
    const flush = async () => void order.push('flush');
    const waitUntil = (p: Promise<unknown>) => void handed.push(p);
    const ok = withTelemetryFlush(
      async (r: Request) => {
        order.push(`handle ${new URL(r.url).pathname}`);
        return new Response('ok');
      },
      flush,
      waitUntil,
    );
    expect((await ok(new Request('https://x/a'))).status).toBe(200);
    const failing = withTelemetryFlush(
      async () => {
        throw new Error('boom');
      },
      flush,
      waitUntil,
    );
    await expect(failing()).rejects.toThrow('boom');
    await Promise.all(handed);
    expect(handed).toHaveLength(2);
    expect(order).toEqual(['handle /a', 'flush', 'flush']);
  });

  it('never fails a request because the export failed', async () => {
    const handed: Promise<unknown>[] = [];
    const handler = withTelemetryFlush(
      async () => new Response('ok'),
      async () => {
        throw new Error('collector down');
      },
      (p) => void handed.push(p),
    );
    expect((await handler()).status).toBe(200);
    await expect(handed[0]).resolves.toBeUndefined();
  });
});

describe('each function entry is its own service (D274)', () => {
  const entry = async (service: Service, call: () => Promise<Response>) => {
    const state = await import('../src/state');
    const res = await call();
    // The entry built the instance's runtime; asking for it again returns that one, whatever name is passed.
    return { status: res.status, service: state.getRuntime(service === 'api' ? 'worker' : 'api').service };
  };

  it('api, worker and scheduler', async () => {
    for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);

    const api = await import('../src/functions/api');
    expect(
      await entry('api', async () =>
        api.default.fetch(new Request('https://hostmark.example.com/api/health')),
      ),
    ).toEqual({ status: 200, service: 'api' });

    vi.resetModules();
    const cron = await import('../src/functions/cron');
    expect(await entry('scheduler', () => cron.GET(new Request('https://x/api/cron/daily-stats')))).toEqual({
      status: 401,
      service: 'scheduler',
    });

    vi.resetModules();
    const queue = await import('../src/functions/queue');
    const forOtherTopic = new Request('https://x/api/queue', {
      method: 'POST',
      headers: { 'ce-vqsqueuename': 'other-topic' },
      body: '{}',
    });
    expect(await entry('worker', () => queue.POST(forOtherTopic))).toEqual({
      status: 403,
      service: 'worker',
    });
  });
});
