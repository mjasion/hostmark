import { startRecordingTelemetry } from '@hostmark/telemetry/testing';
import { SpanKind } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, databaseUrl, KEYS, type TestDb } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness } from './helpers/harness';

// A real SDK is registered, so ids and parents are real. The other suites run on the no-op tracer.
const recording = startRecordingTelemetry();
let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
  await recording.shutdown();
});

describe.skipIf(!databaseUrl)('tracing over http', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
  });

  const TRACE = '0af7651916cd43dd8448eb211c80319c';
  const PARENT = 'b7ad6b7169203331';

  it('continues the trace of an inbound traceparent', async () => {
    const res = await h.request('/api/health', { headers: { traceparent: `00-${TRACE}-${PARENT}-01` } });
    expect(res.headers.get('x-trace-id')).toBe(TRACE);
    const span = recording.spans().find((s) => s.spanContext().traceId === TRACE);
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT);
  });

  it.each([
    'garbage',
    `00-${TRACE.toUpperCase()}-${PARENT}-01`,
    `00-${'0'.repeat(32)}-${PARENT}-01`,
    `ff-${TRACE}-${PARENT}-01`,
    '',
  ])('ignores the invalid traceparent %j and starts its own trace', async (traceparent) => {
    const res = await h.request('/api/health', { headers: { traceparent } });
    expect(res.status).toBe(200);
    const id = res.headers.get('x-trace-id');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(TRACE);
  });

  it('marks producer and server spans and carries the file id on them', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const spans = recording.spans();
    const send = spans.find((s) => s.name === 'queue.send');
    expect(send?.kind).toBe(SpanKind.PRODUCER);
    expect(send?.attributes['file.id']).toBe(id);
    const server = spans.find((s) => s.name.endsWith('/complete'));
    expect(server?.kind).toBe(SpanKind.SERVER);
    expect(server?.attributes['file.id']).toBe(id);
  });

  it('marks the worker span as a consumer', async () => {
    await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.deliver(h.queue.messages()[0] as never);
    expect(recording.spans().find((s) => s.name === 'process_image')?.kind).toBe(SpanKind.CONSUMER);
  });
});
