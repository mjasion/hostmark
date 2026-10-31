import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contextFromTraceparent,
  createTelemetry,
  currentSpanId,
  currentTraceId,
  injectTraceContext,
  linkFromMessage,
  withSpan,
} from '../src/index';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

beforeAll(() => {
  context.setGlobalContextManager(new StackContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  trace.disable();
  context.disable();
  await provider.shutdown();
});
beforeEach(() => exporter.reset());

function capture() {
  const lines: string[] = [];
  const t = createTelemetry('api', { write: (l) => lines.push(l) });
  return { t, lines, last: () => JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown> };
}

describe('trace propagation', () => {
  it('round-trips producer context into a consumer link', async () => {
    const { t } = capture();
    let header: ReturnType<typeof injectTraceContext> = {};
    let producerSpanId = '';
    let producerTraceId = '';
    await withSpan(t.tracer, 'enqueue', async (span) => {
      header = injectTraceContext();
      producerSpanId = span.spanContext().spanId;
      producerTraceId = span.spanContext().traceId;
    });
    expect(header.traceparent).toBe(`00-${producerTraceId}-${producerSpanId}-01`);

    const link = linkFromMessage(header);
    expect(link?.context.traceId).toBe(producerTraceId);
    expect(link?.context.spanId).toBe(producerSpanId);

    await withSpan(t.tracer, 'process_image', async () => {}, {
      kind: SpanKind.CONSUMER,
      links: link ? [link] : [],
    });
    const consumer = exporter.getFinishedSpans().find((s) => s.name === 'process_image');
    expect(consumer?.links).toHaveLength(1);
    expect(consumer?.links[0]?.context.spanId).toBe(producerSpanId);
    // A link, not a parent: the worker starts its own trace.
    expect(consumer?.spanContext().traceId).not.toBe(producerTraceId);
  });

  it('injects nothing without an active span', () => {
    expect(injectTraceContext()).toEqual({});
  });

  it.each([
    undefined,
    '',
    'garbage',
    '00-xyz-abc-01',
    `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
    `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`,
    `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    `00-${'a'.repeat(31)}-${'b'.repeat(16)}-01`,
    `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01-extra`,
  ])('returns undefined for invalid traceparent %s', (traceparent) => {
    expect(linkFromMessage({ traceparent })).toBeUndefined();
  });

  it('does not throw on non-string input', () => {
    expect(linkFromMessage({ traceparent: 5 as unknown as string })).toBeUndefined();
  });

  it('accepts a valid traceparent with unsampled flag', () => {
    const link = linkFromMessage({ traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00` });
    expect(link?.context.traceFlags).toBe(0);
  });

  it('exposes current ids', async () => {
    const { t } = capture();
    expect(currentTraceId()).toBeUndefined();
    await withSpan(t.tracer, 's', async (span) => {
      expect(currentTraceId()).toBe(span.spanContext().traceId);
      expect(currentSpanId()).toBe(span.spanContext().spanId);
    });
  });
});

describe('withSpan', () => {
  it('records the exception, sets error status, rethrows and ends the span', async () => {
    const { t } = capture();
    await expect(
      withSpan(t.tracer, 'boom', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('nope');
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('handles thrown non-errors', async () => {
    const { t } = capture();
    await expect(
      withSpan(t.tracer, 'boom', async () => {
        throw 'text';
      }),
    ).rejects.toBe('text');
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('returns the value and leaves status unset on success', async () => {
    const { t } = capture();
    expect(await withSpan(t.tracer, 'ok', async () => 42)).toBe(42);
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('logger', () => {
  it('writes one line of JSON with trace ids inside a span', async () => {
    const { t, lines, last } = capture();
    await withSpan(t.tracer, 's', async (span) => {
      t.logger.info('hello', { fileId: 'f1' });
      expect(last().traceId).toBe(span.spanContext().traceId);
      expect(last().spanId).toBe(span.spanContext().spanId);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(last()).toMatchObject({ level: 'info', msg: 'hello', service: 'api', fileId: 'f1' });
    expect(typeof last().time).toBe('string');
  });

  it('omits trace ids outside a span', () => {
    const { t, last } = capture();
    t.logger.warn('x');
    expect(last().traceId).toBeUndefined();
    expect(last().level).toBe('warn');
  });

  it('survives circular, BigInt and Error fields', () => {
    const { t, last } = capture();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => t.logger.error('bad', { circular, big: 10n, err: new Error('e') })).not.toThrow();
    const out = last();
    expect(out.big).toBe('10');
    expect((out.circular as Record<string, unknown>).self).toBe('[Circular]');
    expect((out.err as Record<string, unknown>).message).toBe('e');
  });

  it('does not let fields overwrite reserved keys', () => {
    const { t, last } = capture();
    t.logger.info('real', { msg: 'fake', level: 'fake', service: 'fake' });
    expect(last()).toMatchObject({ msg: 'real', level: 'info', service: 'api' });
  });

  it('never throws, even when a getter or the sink throws', () => {
    const lines: string[] = [];
    let calls = 0;
    const t = createTelemetry('worker', {
      write: (l) => {
        if (calls++ === 0) throw new Error('sink');
        lines.push(l);
      },
    });
    const evil = {
      get x(): never {
        throw new Error('getter');
      },
    };
    expect(() => t.logger.info('a', evil)).not.toThrow();
    expect(() => t.logger.info('b')).not.toThrow();
  });
});

describe('without a provider', () => {
  it('creates telemetry and records metrics as no-ops', () => {
    trace.disable();
    const t = createTelemetry('scheduler', { write: () => {} });
    expect(() => {
      t.metrics.coldStart.add(1);
      t.metrics.webVitals.record(1.5, { 'bench.metric': 'LCP' });
      t.metrics.httpRequestDuration.record(0.1);
    }).not.toThrow();
    expect(currentTraceId()).toBeUndefined();
    trace.setGlobalTracerProvider(provider);
  });
});

describe('contextFromTraceparent', () => {
  it('makes the remote span the parent of a new span', async () => {
    const { t } = capture();
    const traceId = 'a'.repeat(32);
    const ctx = contextFromTraceparent(`00-${traceId}-${'b'.repeat(16)}-01`);
    expect(ctx).toBeDefined();
    await context.with(ctx as NonNullable<typeof ctx>, () => withSpan(t.tracer, 'child', async () => {}));
    const span = exporter.getFinishedSpans().find((s) => s.name === 'child');
    expect(span?.spanContext().traceId).toBe(traceId);
  });

  it.each([
    undefined,
    null,
    '',
    'garbage',
    `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`,
    `00-${'A'.repeat(32)}-${'B'.repeat(16)}-01`,
  ])('ignores %s', (header) => {
    expect(contextFromTraceparent(header)).toBeUndefined();
  });
});
