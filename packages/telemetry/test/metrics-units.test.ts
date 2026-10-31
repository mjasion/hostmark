import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, expect, it } from 'vitest';
import { createTelemetry } from '../src/index';

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);
afterAll(async () => {
  metrics.disable();
  await provider.shutdown();
});

// Prometheus appends the unit to the metric name, so a `ms` unit would export `processing_duration_ms_milliseconds`.
it('keeps the metric names of the spec free of unit suffixes', async () => {
  const t = createTelemetry('worker', { write: () => {} });
  for (const h of [
    t.metrics.enqueueToStartMs,
    t.metrics.processingDurationMs,
    t.metrics.uploadToReadyMs,
    t.metrics.schedulerRunDurationMs,
  ]) {
    h.record(1);
  }
  await reader.forceFlush();
  const units = new Map<string, string>();
  for (const rm of exporter.getMetrics())
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics) units.set(m.descriptor.name, m.descriptor.unit);
  for (const name of [
    'queue.enqueue_to_start_ms',
    'processing_duration_ms',
    'upload_to_ready_ms',
    'scheduler_run_duration_ms',
  ]) {
    expect(units.get(name), name).toBe('');
  }
});
