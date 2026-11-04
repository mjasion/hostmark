// Acceptance criterion 3 on Lambda: the environment is frozen when the handler's promise settles, so the telemetry
// has to be exported before that. These tests use fakes only: a local HTTP server stands in for the OTLP backend.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createTelemetry } from '@hostmark/telemetry';
import type { Context, LambdaFunctionURLEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundedFlush, type Runtime, withFlush } from '../src/runtime';
import { flushAfterStream } from '../src/stream';

/** What the Lambda Node.js runtime provides as `awslambda` (enough for Hono's `streamHandle`). */
function stubAwsLambda(meta: unknown[]) {
  (globalThis as Record<string, unknown>).awslambda = {
    streamifyResponse: (fn: unknown) => fn,
    HttpResponseStream: {
      from: (stream: Writable, m: unknown) => {
        meta.push(m);
        return stream;
      },
    },
  };
}

function responseStream(events: string[]) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  stream.on('finish', () => events.push('response ended'));
  return { stream, body: () => Buffer.concat(chunks).toString('utf8') };
}

function urlEvent(path: string, headers: Record<string, string> = {}): LambdaFunctionURLEvent {
  const host = 'abc.lambda-url.eu-central-1.on.aws';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host, ...headers },
    isBase64Encoded: false,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc',
      domainName: host,
      domainPrefix: 'abc',
      http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.9', userAgent: 'test' },
      requestId: 'r1',
      routeKey: '$default',
      stage: '$default',
      time: '04/Nov/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
  };
}

const lambdaContext = {} as Context;

describe('bounded flush', () => {
  const lines: string[] = [];
  const logger = createTelemetry('worker', { write: (l) => lines.push(l) }).logger;

  it('waits for the export', async () => {
    const order: string[] = [];
    await boundedFlush(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('exported');
    }, logger);
    order.push('returned');
    expect(order).toEqual(['exported', 'returned']);
  });

  it('gives up after the timeout and logs it, so an unreachable backend cannot hold the function', async () => {
    lines.length = 0;
    const started = Date.now();
    await boundedFlush(() => new Promise(() => {}), logger, 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lines.join('\n')).toContain('telemetry flush timed out');
  });

  it('logs a failed export instead of failing the invocation', async () => {
    lines.length = 0;
    await expect(
      boundedFlush(() => Promise.reject(new Error('ECONNREFUSED')), logger),
    ).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('ECONNREFUSED');
  });
});

describe('worker and scheduler invocations', () => {
  const fakeRuntime = (order: string[]) =>
    ({
      flush: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('flushed');
      },
    }) as Runtime;

  it('flush before the invocation returns', async () => {
    const order: string[] = [];
    const rt = fakeRuntime(order);
    const result = await withFlush(
      () => rt,
      async () => {
        order.push('job');
        return { batchItemFailures: [] };
      },
    );
    order.push('returned');
    expect(result).toEqual({ batchItemFailures: [] });
    expect(order).toEqual(['job', 'flushed', 'returned']);
  });

  it('flush also when the job throws (crash chaos, a failed scheduler run), then rethrow', async () => {
    const order: string[] = [];
    const rt = fakeRuntime(order);
    await expect(
      withFlush(
        () => rt,
        async () => {
          throw new Error('crash');
        },
      ),
    ).rejects.toThrow('crash');
    expect(order).toEqual(['flushed']);
  });

  it('skip the flush when the runtime could not be built', async () => {
    await expect(
      withFlush(
        () => undefined,
        async () => {
          throw new Error('Invalid environment');
        },
      ),
    ).rejects.toThrow('Invalid environment');
  });
});

describe('api streaming invocation', () => {
  it('ends the response before the flush and returns after it, also when the handler throws', async () => {
    const events: string[] = [];
    const flush = async () => {
      events.push('flush started');
      await new Promise((r) => setTimeout(r, 10));
      events.push('flush done');
    };
    const { stream } = responseStream(events);
    await flushAfterStream(async (_e, s) => {
      s.end('data: x\n\n');
      await new Promise((r) => setImmediate(r));
    }, flush)({}, stream as never, lambdaContext);
    events.push('returned');
    expect(events).toEqual(['response ended', 'flush started', 'flush done', 'returned']);

    events.length = 0;
    await expect(
      flushAfterStream(async () => {
        throw new Error('boom');
      }, flush)({}, responseStream(events).stream as never, lambdaContext),
    ).rejects.toThrow('boom');
    expect(events).toEqual(['flush started', 'flush done']);
  });

  describe('the real handler of src/api.ts with OTLP_ENDPOINT set', () => {
    const seen: Array<{ path: string; body: string; at: number }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), at: Date.now() });
        res.setHeader('content-type', 'application/json');
        res.end();
      });
    });
    const saved = { ...process.env };
    const secret = 'o'.repeat(40);

    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      Object.assign(process.env, {
        PUBLIC_URL: 'https://d111.cloudfront.net',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
        BETTER_AUTH_SECRET: 'x'.repeat(40),
        AWS_REGION: 'eu-central-1',
        AWS_ACCESS_KEY_ID: 'a',
        AWS_SECRET_ACCESS_KEY: 'b',
        S3_BUCKET: 'bucket',
        SQS_QUEUE_URL: 'https://sqs.eu-central-1.amazonaws.com/1/q',
        CLOUDFRONT_DISTRIBUTION_ID: 'E1',
        ORIGIN_SECRET: secret,
        OTLP_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
    });
    afterAll(async () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      delete (globalThis as Record<string, unknown>).awslambda;
      server.close();
    });

    it('exports the request span with service.name api before the invocation returns', async () => {
      const meta: unknown[] = [];
      stubAwsLambda(meta);
      const { handler } = await import('../src/api');
      const events: string[] = [];
      const { stream, body } = responseStream(events);
      // The batch delay is 5 s and the metric interval 15 s: only the flush can export this soon.
      await (handler as unknown as (e: unknown, s: Writable, c: Context) => Promise<void>)(
        urlEvent('/api/health', { 'x-hostmark-origin-secret': secret }),
        stream,
        lambdaContext,
      );
      const returned = Date.now();
      expect(events).toEqual(['response ended']);
      expect(meta).toEqual([expect.objectContaining({ statusCode: 200 })]);
      expect(body()).toContain('ok');
      const traces = seen.filter((s) => s.path === '/v1/traces');
      expect(traces.length).toBeGreaterThan(0);
      for (const t of seen) expect(t.at).toBeLessThanOrEqual(returned);
      // OTLP/HTTP JSON: the resource attributes of every exported batch.
      const services = traces.flatMap((t) =>
        (
          JSON.parse(t.body) as {
            resourceSpans: Array<{
              resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
            }>;
          }
        ).resourceSpans.map(
          (r) => r.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue,
        ),
      );
      expect(new Set(services)).toEqual(new Set(['api']));
    });
  });
});
