// Shared constants (D17, D10, spec). Everything here is platform independent.

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** 10 MiB, exact (D10). */
export const MAX_UPLOAD_BYTES = 10_485_760;

/** Labels of the three variants every `ready` file has (D16). A label is the maximum longer side in px. */
export const VARIANT_SIZES = [128, 512, 1600] as const;
export type VariantSize = (typeof VARIANT_SIZES)[number];

export const FILE_STATUSES = [
  'pending_upload',
  'queued',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;
export type FileStatusValue = (typeof FILE_STATUSES)[number];
/** Statuses after which a file never changes again, except for `ready -> deleted`. */
export const TERMINAL_STATUSES = ['ready', 'failed', 'deleted'] as const satisfies readonly FileStatusValue[];

export const CHAOS_MODES = ['none', 'fail', 'crash', 'slow'] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];
/** `chaos=slow` waits this long. */
export const CHAOS_SLOW_MS = 45_000;

// Queue
export const QUEUE_NAME = 'image-jobs';
export const DLQ_NAME = 'image-jobs-dlq';
export const MAX_ATTEMPTS = 5;
/** Delay before attempt 2..5, in seconds. */
export const BACKOFF_SECONDS = [10, 30, 90, 270] as const;
export const VISIBILITY_TIMEOUT_SECONDS = 60;
export const CONSUMER_BATCH_SIZE = 10;
export const JOB_MESSAGE_VERSION = 1;
export const JOB_TYPES = ['process_image', 'delete_file'] as const;

// Lifetimes
export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 3600;
export const FILE_RETENTION_DAYS = 7;
/** `pending_upload` rows older than this are abandoned (D19). */
export const PENDING_UPLOAD_MAX_AGE_SECONDS = 3600;
/** `queued` / `processing` rows without activity for this long are requeued (D19). */
export const STUCK_AFTER_SECONDS = 600;
/** Upper bound of rows touched by one scheduler query (D19). */
export const SCHEDULER_BATCH_LIMIT = 1000;

// Scheduler (UTC)
export const SCHEDULER_JOBS = {
  'cleanup-expired': '*/15 * * * *',
  'requeue-stuck': '*/5 * * * *',
  'daily-stats': '5 0 * * *',
} as const;
export type SchedulerJobName = keyof typeof SCHEDULER_JOBS;

// API
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const DEBUG_CPU_MAX_MS = 30_000;
export const STATS_DAYS = 30;
export const RUM_MAX_BODY_BYTES = 2048;

// SSE (D20)
export const SSE_POLL_INTERVAL_MS = 1000;
export const SSE_MAX_DURATION_MS = 60_000;
/** A comment line after this long without an event, so proxies and CDNs do not treat a quiet stream as idle (D236). */
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_FALLBACK_POLL_MS = 2000;

// Headers (D9)
export const HEADER_TRACE_ID = 'x-trace-id';
export const HEADER_PLATFORM = 'x-platform';
export const HEADER_VERSION = 'x-version';
export const HEADER_CHAOS = 'x-chaos';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

// RUM (D18): every attribute comes from a closed list
export const RUM_METRIC_NAMES = ['LCP', 'INP', 'CLS', 'TTFB'] as const;
export const RUM_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export const RUM_PLATFORMS = [
  'local',
  'cloudflare',
  'vercel',
  'aws',
  'gcp',
  'railway',
  'fly',
  'vps',
] as const;
export const RUM_VARIANTS = ['portable', 'idiomatic'] as const;
export const RUM_TOPOLOGIES = ['single', 'multi'] as const;
export const RUM_REGIONS = ['local', 'frankfurt', 'warsaw', 'us-east', 'singapore', 'unknown'] as const;
