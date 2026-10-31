import { trace } from '@opentelemetry/api';
import { afterAll, expect, it } from 'vitest';
import { createTelemetry, currentTraceId, withSpan } from '../src/index';
import { startNodeTelemetry } from '../src/node';

const sdk = startNodeTelemetry({
  service: 'api',
  platform: 'local',
  variant: 'portable',
  imageImpl: 'wasm',
  version: 'test',
  environment: 'test',
  otlpEndpoint: '',
});
afterAll(async () => {
  await sdk.shutdown();
  trace.disable();
});

it('gives valid trace ids and a working async context without an exporter', async () => {
  const lines: string[] = [];
  const t = createTelemetry('api', { write: (l) => lines.push(l) });
  await withSpan(t.tracer, 'outer', async () => {
    const id = currentTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await new Promise((r) => setTimeout(r, 5));
    expect(currentTraceId()).toBe(id);
    t.logger.info('inside');
  });
  expect(JSON.parse(lines[0] as string).traceId).toMatch(/^[0-9a-f]{32}$/);
});

it('write sink tolerates lines that are not JSON', () => {
  expect(() => sdk.write('not json')).not.toThrow();
});
