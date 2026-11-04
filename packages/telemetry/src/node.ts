// Node SDK bootstrap. Not importable from Workers; the main entry stays free of the SDK.

import { randomUUID } from 'node:crypto';
import { logs, SeverityNumber } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, NoopSpanProcessor } from '@opentelemetry/sdk-trace';
import { TRACER_NAME } from './index';

export interface NodeTelemetryOptions {
  service: 'api' | 'worker' | 'scheduler';
  platform: string;
  variant: string;
  imageImpl: string;
  version: string;
  environment: string;
  /** OTLP/HTTP base URL, e.g. `http://localhost:4318`. Empty: local tracer provider, nothing is exported. */
  otlpEndpoint: string;
}

export interface NodeTelemetry {
  shutdown(): Promise<void>;
  /**
   * Exports what the span and log processors hold and what the metric reader has collected so far, without stopping
   * anything. For a runtime that freezes the process between requests (Vercel functions), where a batch would
   * otherwise wait for the next request. Resolves at once when nothing is exported.
   */
  flush(): Promise<void>;
  /**
   * Sink for `createTelemetry(service, { write })`: prints the line and forwards it as an OTLP log record.
   * It must be called inside the active span for the record to carry the trace context.
   */
  write(line: string): void;
}

const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function toAttributes(entry: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'msg' || k === 'time' || k === 'level' || v === undefined || v === null) continue;
    out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
  }
  return out;
}

export function startNodeTelemetry(opts: NodeTelemetryOptions): NodeTelemetry {
  const resource = resourceFromAttributes({
    'service.name': opts.service,
    'service.version': opts.version,
    // One per process: replicas of a service must not write the same metric series.
    'service.instance.id': randomUUID(),
    'deployment.environment': opts.environment,
    'bench.platform': opts.platform,
    'bench.variant': opts.variant,
    'bench.image_impl': opts.imageImpl,
  });

  const base = opts.otlpEndpoint.replace(/\/+$/, '');
  const exporting = base !== '';
  // An empty processor list makes NodeSDK skip the tracer provider, so the no-export case needs a
  // no-op processor to still get valid trace ids. Empty readers/processors also stop NodeSDK from
  // falling back to OTEL_* environment defaults.
  const spanProcessor = exporting
    ? new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) })
    : new NoopSpanProcessor();
  const metricReader = exporting
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      })
    : undefined;
  const logProcessor = exporting
    ? new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }) })
    : undefined;
  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    spanProcessors: [spanProcessor],
    metricReaders: metricReader ? [metricReader] : [],
    logRecordProcessors: logProcessor ? [logProcessor] : [],
  });
  sdk.start();

  return {
    shutdown: () => sdk.shutdown(),
    async flush() {
      if (!exporting) return;
      await Promise.all([spanProcessor.forceFlush(), metricReader?.forceFlush(), logProcessor?.forceFlush()]);
    },
    write(line) {
      console.log(line);
      if (!exporting) return;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const level = String(entry.level ?? 'info');
        logs.getLogger(TRACER_NAME).emit({
          severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
          severityText: level,
          body: String(entry.msg ?? ''),
          attributes: toAttributes(entry),
        });
      } catch {
        // Logging must never throw.
      }
    },
  };
}
