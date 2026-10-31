import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, metrics, trace } from '@opentelemetry/api';
import { expect, it } from 'vitest';
import { createTelemetry, withSpan } from '../src/index';
import { startNodeTelemetry } from '../src/node';

it('exports traces, metrics and logs over OTLP HTTP', async () => {
  const paths = new Set<string>();
  const server = createServer((req, res) => {
    paths.add(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/x-protobuf');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const sdk = startNodeTelemetry({
    service: 'worker',
    platform: 'local',
    variant: 'portable',
    imageImpl: 'wasm',
    version: 'abc',
    environment: 'test',
    otlpEndpoint: `http://127.0.0.1:${port}/`,
  });
  const t = createTelemetry('worker', { write: (l) => sdk.write(l) });
  await withSpan(t.tracer, 'job', async () => {
    t.metrics.jobsRetried.add(1);
    t.logger.info('hello', { fileId: 'f1' });
  });
  await sdk.shutdown();
  server.close();

  expect([...paths].sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Starts a node SDK against a local collector, emits one span and returns the OTLP traces body. */
async function exportedTraces(): Promise<string> {
  // The previous test registered global providers; release them so this SDK can install its own.
  trace.disable();
  context.disable();
  metrics.disable();
  const bodies: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/traces') bodies.push(Buffer.concat(chunks));
      res.setHeader('content-type', 'application/x-protobuf');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sdk = startNodeTelemetry({
    service: 'api',
    platform: 'local',
    variant: 'portable',
    imageImpl: 'wasm',
    version: 'abc',
    environment: 'test',
    otlpEndpoint: `http://127.0.0.1:${port}`,
  });
  const t = createTelemetry('api', { write: () => {} });
  await withSpan(t.tracer, 'job', async () => {});
  await sdk.shutdown();
  server.close();
  return Buffer.concat(bodies).toString('latin1');
}

it('puts a service.instance.id on the resource so replicas do not overwrite each other', async () => {
  const body = await exportedTraces();
  expect(body).toContain('service.instance.id');
  expect(body).toMatch(UUID);
});

it('uses a different service.instance.id for every process start', async () => {
  const a = (await exportedTraces()).match(UUID)?.[0];
  const b = (await exportedTraces()).match(UUID)?.[0];
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(a).not.toBe(b);
});
