// Test support: a real Node SDK whose finished spans stay in memory. Not for production code.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

export interface RecordingTelemetry {
  spans(): ReadableSpan[];
  shutdown(): Promise<void>;
}

export function startRecordingTelemetry(): RecordingTelemetry {
  const exporter = new InMemorySpanExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
    metricReaders: [],
    logRecordProcessors: [],
  });
  sdk.start();
  return { spans: () => exporter.getFinishedSpans(), shutdown: () => sdk.shutdown() };
}
