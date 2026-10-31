// Platform independent telemetry helpers (D22). Only `@opentelemetry/api` may be imported here, so this
// module runs on Workers, Node and Bun. Providers are installed elsewhere; without one everything is a no-op.

import {
  type Context,
  type Counter,
  context,
  type Histogram,
  type Link,
  metrics,
  type Span,
  type SpanContext,
  type SpanOptions,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from '@opentelemetry/api';

export const TRACER_NAME = 'hostmark';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  httpRequestDuration: Histogram;
  coldStart: Counter;
  enqueueToStartMs: Histogram;
  processingDurationMs: Histogram;
  uploadToReadyMs: Histogram;
  jobsRetried: Counter;
  jobsDeadLettered: Counter;
  schedulerRunDurationMs: Histogram;
  webVitals: Histogram;
}

export interface Telemetry {
  tracer: Tracer;
  logger: Logger;
  metrics: Metrics;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

function createLogger(service: string, write: (line: string) => void): Logger {
  const log = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
    try {
      const sc = trace.getActiveSpan()?.spanContext();
      const valid = sc !== undefined && trace.isSpanContextValid(sc);
      // Reserved keys come last so a caller field cannot overwrite them.
      const entry = {
        ...fields,
        level,
        msg,
        traceId: valid ? sc.traceId : undefined,
        spanId: valid ? sc.spanId : undefined,
        time: new Date().toISOString(),
        service,
      };
      write(safeStringify(entry));
    } catch {
      try {
        write(JSON.stringify({ level, msg: String(msg), time: new Date().toISOString(), service }));
      } catch {
        // A logger must never break the request.
      }
    }
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

// Latency buckets differ per unit, so the defaults of the SDK (tuned for ms) are overridden for seconds.
const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

function createMetrics(): Metrics {
  const meter = metrics.getMeter(TRACER_NAME);
  const ms = (name: string, description: string) =>
    meter.createHistogram(name, {
      description,
      // No unit: Prometheus would append `_milliseconds` to the names fixed by the spec.
      advice: { explicitBucketBoundaries: MS_BUCKETS },
    });
  return {
    httpRequestDuration: meter.createHistogram('http.server.request.duration', {
      description: 'api latency by route and status code',
      unit: 's',
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    }),
    coldStart: meter.createCounter('bench.cold_start', {
      description: 'first request in a new instance',
    }),
    enqueueToStartMs: ms('queue.enqueue_to_start_ms', 'enqueuedAt to handler start'),
    processingDurationMs: ms('processing_duration_ms', 'worker processing time'),
    uploadToReadyMs: ms('upload_to_ready_ms', 'ready_at - queued_at'),
    jobsRetried: meter.createCounter('jobs_retried', { description: 'jobs that will be retried' }),
    jobsDeadLettered: meter.createCounter('jobs_dead_lettered', {
      description: 'jobs moved to the dead letter queue',
    }),
    schedulerRunDurationMs: ms('scheduler_run_duration_ms', 'scheduler job run time'),
    webVitals: meter.createHistogram('bench.web_vitals', {
      description: 'browser web vitals reported through /api/rum',
    }),
  };
}

export function createTelemetry(
  service: 'api' | 'worker' | 'scheduler',
  opts?: { write?: (line: string) => void },
): Telemetry {
  return {
    tracer: trace.getTracer(TRACER_NAME),
    logger: createLogger(service, opts?.write ?? ((line) => console.log(line))),
    metrics: createMetrics(),
  };
}

/** Runs `fn` in a new active span. Records the exception, sets error status and always ends the span. */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  opts?: SpanOptions,
): Promise<T> {
  return tracer.startActiveSpan(name, opts ?? {}, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Parsed by hand: a registered global propagator is not guaranteed (tests, Workers).
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

function parseTraceparent(value: string): SpanContext | undefined {
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return undefined;
  const [, version, traceId, spanId, flags, rest] = m;
  if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return {
    traceId: traceId as string,
    spanId: spanId as string,
    traceFlags: Number.parseInt(flags as string, 16) & TraceFlags.SAMPLED,
    isRemote: true,
  };
}

/** Trace headers of the active span, for the producer side of a message. Empty without an active span. */
export function injectTraceContext(): { traceparent?: string; tracestate?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  if (!trace.isSpanContextValid(sc)) return {};
  const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, '0');
  const out: { traceparent?: string; tracestate?: string } = {
    traceparent: `00-${sc.traceId}-${sc.spanId}-${flags}`,
  };
  const state = sc.traceState?.serialize();
  if (state) out.tracestate = state;
  return out;
}

/** Link to the producer's span, for the consumer span. `undefined` when the message carries no valid context. */
export function linkFromMessage(msg: { traceparent?: string; tracestate?: string }): Link | undefined {
  try {
    if (!msg.traceparent) return undefined;
    const sc = parseTraceparent(msg.traceparent);
    if (!sc) return undefined;
    // tracestate is only relayed, never interpreted; a malformed value must not drop the link.
    return { context: sc, attributes: msg.tracestate ? { 'tracestate.raw': msg.tracestate } : undefined };
  } catch {
    return undefined;
  }
}

/** Context carrying the remote span of a `traceparent` header, or `undefined` when it is absent or invalid. */
export function contextFromTraceparent(traceparent: string | undefined | null): Context | undefined {
  if (!traceparent) return undefined;
  const sc = parseTraceparent(traceparent);
  return sc ? trace.setSpanContext(context.active(), sc) : undefined;
}

export function currentTraceId(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined;
}

export function currentSpanId(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? sc.spanId : undefined;
}
