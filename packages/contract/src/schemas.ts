import { z } from '@hono/zod-openapi';
import {
  ALLOWED_CONTENT_TYPES,
  DEBUG_CPU_MAX_MS,
  DEFAULT_PAGE_LIMIT,
  FILE_STATUSES,
  MAX_PAGE_LIMIT,
  RUM_METRIC_NAMES,
  RUM_PLATFORMS,
  RUM_RATINGS,
  RUM_REGIONS,
  RUM_TOPOLOGIES,
  RUM_VARIANTS,
  VARIANT_SIZES,
} from './constants';
import { Chaos } from './messages';

const isoDateTime = z.iso.datetime();

/** RFC 9457 problem details. `traceId` is an extension member. */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    traceId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');
export type Problem = z.infer<typeof Problem>;

export const FileStatus = z.enum(FILE_STATUSES).openapi('FileStatus');
export type FileStatus = z.infer<typeof FileStatus>;

export const ContentType = z.enum(ALLOWED_CONTENT_TYPES);

export const FileIdParam = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

// Health

export const Health = z.object({ status: z.literal('ok') }).openapi('Health');
export type Health = z.infer<typeof Health>;

export const DependencyCheck = z.object({
  status: z.enum(['ok', 'down', 'unknown']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheck>;

export const DeepHealth = z
  .object({
    status: z.enum(['ok', 'down']),
    checks: z.object({ database: DependencyCheck, storage: DependencyCheck, queue: DependencyCheck }),
  })
  .openapi('DeepHealth');
export type DeepHealth = z.infer<typeof DeepHealth>;

// Uploads (D10). `bytes` has no upper bound here: above 10 MiB the answer is 413, not 400.

export const CreateUploadRequest = z
  .object({
    contentType: ContentType,
    // Not `.int()`: zod limits that to safe integers, and a huge size must still answer 413, not 400. The
    // document still says integer, which is what clients should send.
    bytes: z.number().positive().multipleOf(1).openapi({ type: 'integer' }),
  })
  .openapi('CreateUploadRequest');
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const CreateUploadResponse = z
  .object({
    fileId: z.uuid(),
    uploadUrl: z.string(),
    uploadHeaders: z.record(z.string(), z.string()),
    expiresAt: isoDateTime,
  })
  .openapi('CreateUploadResponse');
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const CompleteUploadHeaders = z.object({
  'x-chaos': Chaos.optional(),
});

// Files

export const FileVariant = z
  .object({
    size: z
      .number()
      .int()
      .refine((n) => (VARIANT_SIZES as readonly number[]).includes(n), 'unknown size'),
    url: z.string(), // presigned GET
    bytes: z.number().int().nonnegative(),
  })
  .openapi('FileVariant');
export type FileVariant = z.infer<typeof FileVariant>;

export const FileResponse = z
  .object({
    id: z.uuid(),
    status: FileStatus,
    contentType: z.string(),
    bytes: z.number().int().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    sha256: z.string().nullable(),
    isPublic: z.boolean(),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: isoDateTime,
    queuedAt: isoDateTime.nullable(),
    readyAt: isoDateTime.nullable(),
    expiresAt: isoDateTime,
    variants: z.array(FileVariant),
  })
  .openapi('File');
export type FileResponse = z.infer<typeof FileResponse>;

/** `cursor` is opaque to clients: pass back `nextCursor`. */
export const ListFilesQuery = z.object({
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type ListFilesQuery = { cursor?: string; limit?: number };

export const ListFilesResponse = z
  .object({
    items: z.array(FileResponse),
    nextCursor: z.string().nullable(),
  })
  .openapi('ListFilesResponse');
export type ListFilesResponse = z.infer<typeof ListFilesResponse>;

export const UpdateFileRequest = z.object({ isPublic: z.boolean() }).openapi('UpdateFileRequest');
export type UpdateFileRequest = z.infer<typeof UpdateFileRequest>;

/** Payload of the `status` SSE event (D20). */
export const FileStatusEvent = z
  .object({
    id: z.uuid(),
    status: FileStatus,
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    lastError: z.string().nullable(),
  })
  .openapi('FileStatusEvent');
export type FileStatusEvent = z.infer<typeof FileStatusEvent>;

// Stats (D12)

export const DailyStat = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    platform: z.string(),
    uploads: z.number().int(),
    ready: z.number().int(),
    failed: z.number().int(),
    bytesIn: z.number().int(),
    p50ProcessingMs: z.number().int().nullable(),
    p95ProcessingMs: z.number().int().nullable(),
  })
  .openapi('DailyStat');
export type DailyStat = z.infer<typeof DailyStat>;

export const StatsResponse = z.object({ items: z.array(DailyStat) }).openapi('StatsResponse');
export type StatsResponse = z.infer<typeof StatsResponse>;

// Debug (D11)

export const DebugCpuQuery = z.object({
  ms: z.coerce.number().int().min(1).max(DEBUG_CPU_MAX_MS),
});
export type DebugCpuQuery = { ms: number };

export const DebugCpuResponse = z
  .object({
    requestedMs: z.number().int(),
    elapsedMs: z.number(),
    iterations: z.number().int(),
    hash: z.string(),
  })
  .openapi('DebugCpuResponse');
export type DebugCpuResponse = z.infer<typeof DebugCpuResponse>;

// Web Vitals (D18)

export const RumRequest = z
  .object({
    name: z.enum(RUM_METRIC_NAMES),
    value: z.number().finite().min(0).max(10_000_000),
    rating: z.enum(RUM_RATINGS).optional(),
    platform: z.enum(RUM_PLATFORMS),
    variant: z.enum(RUM_VARIANTS),
    topology: z.enum(RUM_TOPOLOGIES),
    region: z.enum(RUM_REGIONS).default('unknown'),
  })
  .strict()
  .openapi('RumRequest');
export type RumRequest = z.input<typeof RumRequest>;
