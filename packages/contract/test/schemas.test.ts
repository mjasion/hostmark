import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SECONDS,
  CreateUploadRequest,
  CreateUploadResponse,
  DailyStat,
  DebugCpuQuery,
  DeepHealth,
  FILE_STATUSES,
  FileIdParam,
  FileResponse,
  FileStatusEvent,
  Health,
  JobMessage,
  ListFilesQuery,
  ListFilesResponse,
  MAX_ATTEMPTS,
  MAX_UPLOAD_BYTES,
  originalKey,
  Problem,
  RUM_METRIC_NAMES,
  RUM_PLATFORMS,
  RUM_RATINGS,
  RUM_REGIONS,
  RUM_TOPOLOGIES,
  RUM_VARIANTS,
  RumRequest,
  StatsResponse,
  TERMINAL_STATUSES,
  UpdateFileRequest,
  VARIANT_SIZES,
  variantKey,
} from '../src';

const uuid = '0192f1c2-7b3a-7c1e-8a4d-3f2b1c0d9e8f';

describe('constants', () => {
  it('has one backoff entry per retry', () => {
    expect(BACKOFF_SECONDS).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('builds deterministic storage keys', () => {
    expect(originalKey('u1', uuid)).toBe(`originals/u1/${uuid}`);
    expect(variantKey('u1', uuid, 512)).toBe(`variants/u1/${uuid}/512.webp`);
  });
});

describe('CreateUploadRequest', () => {
  it('accepts allowed types', () => {
    expect(CreateUploadRequest.safeParse({ contentType: 'image/webp', bytes: 1 }).success).toBe(true);
  });

  it('rejects other content types', () => {
    expect(CreateUploadRequest.safeParse({ contentType: 'image/gif', bytes: 10 }).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, '10'])('rejects bytes=%s', (bytes) => {
    expect(CreateUploadRequest.safeParse({ contentType: 'image/png', bytes }).success).toBe(false);
  });

  it('lets an oversized value through so that the use case can answer 413', () => {
    const r = CreateUploadRequest.safeParse({ contentType: 'image/png', bytes: MAX_UPLOAD_BYTES + 1 });
    expect(r.success).toBe(true);
  });
});

describe('JobMessage', () => {
  const base = {
    v: 1,
    type: 'process_image',
    jobId: uuid,
    fileId: uuid,
    enqueuedAt: '2026-10-31T12:00:00.000Z',
  };

  it('defaults chaos to none', () => {
    expect(JobMessage.parse(base).chaos).toBe('none');
  });

  it('keeps trace context', () => {
    const m = JobMessage.parse({ ...base, traceparent: '00-a-b-01', tracestate: 'k=v', chaos: 'slow' });
    expect(m).toMatchObject({ traceparent: '00-a-b-01', tracestate: 'k=v', chaos: 'slow' });
  });

  it.each([
    ['version', { v: 2 }],
    ['type', { type: 'resize' }],
    ['jobId', { jobId: 'nope' }],
    ['date', { enqueuedAt: 'yesterday' }],
    ['chaos', { chaos: 'explode' }],
  ])('rejects a bad %s', (_name, patch) => {
    expect(JobMessage.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('ListFilesQuery', () => {
  it('defaults the limit to 50 and coerces strings', () => {
    expect(ListFilesQuery.parse({}).limit).toBe(50);
    expect(ListFilesQuery.parse({ limit: '25' }).limit).toBe(25);
  });

  it.each(['0', '101', '1.5', 'abc'])('rejects limit=%s', (limit) => {
    expect(ListFilesQuery.safeParse({ limit }).success).toBe(false);
  });
});

describe('DebugCpuQuery', () => {
  it('accepts the boundaries', () => {
    expect(DebugCpuQuery.parse({ ms: '1' }).ms).toBe(1);
    expect(DebugCpuQuery.parse({ ms: '30000' }).ms).toBe(30000);
  });

  it.each(['0', '30001', '-5', '', 'x'])('rejects ms=%j', (ms) => {
    expect(DebugCpuQuery.safeParse({ ms }).success).toBe(false);
  });
});

describe('RumRequest', () => {
  const ok = { name: 'LCP', value: 1234.5, platform: 'aws', variant: 'portable', topology: 'single' };

  it('defaults the region', () => {
    expect(RumRequest.parse(ok).region).toBe('unknown');
  });

  it.each([
    ['unknown metric', { name: 'FID' }],
    ['negative value', { value: -1 }],
    ['infinite value', { value: Number.POSITIVE_INFINITY }],
    ['free-form platform', { platform: 'my-own' }],
    ['free-form region', { region: 'mars' }],
    ['extra attribute', { userAgent: 'x' }],
  ])('rejects %s', (_name, patch) => {
    expect(RumRequest.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe('UpdateFileRequest', () => {
  it('requires a boolean', () => {
    expect(UpdateFileRequest.safeParse({ isPublic: 'true' }).success).toBe(false);
    expect(UpdateFileRequest.safeParse({ isPublic: true }).success).toBe(true);
  });
});

describe('Problem', () => {
  it('accepts the RFC 9457 members with traceId', () => {
    const p = { type: 'about:blank', title: 'Not Found', status: 404, detail: 'x', traceId: 'abc' };
    expect(Problem.parse(p)).toEqual(p);
  });

  it('rejects non-error statuses', () => {
    expect(Problem.safeParse({ type: 't', title: 't', status: 200 }).success).toBe(false);
  });
});

const iso = '2026-10-31T12:00:00.000Z';
const file = {
  id: uuid,
  status: 'ready',
  contentType: 'image/png',
  bytes: 10,
  width: 2,
  height: 1,
  sha256: 'abc',
  isPublic: false,
  attempts: 1,
  lastError: null,
  createdAt: iso,
  queuedAt: iso,
  readyAt: iso,
  expiresAt: iso,
  variants: [{ size: 128, url: 'https://s/x', bytes: 5 }],
};

describe('FileResponse', () => {
  it('parses a ready file and a pending one with nulls', () => {
    expect(FileResponse.parse(file)).toEqual(file);
    const pending = {
      ...file,
      status: 'pending_upload',
      bytes: null,
      width: null,
      height: null,
      sha256: null,
      queuedAt: null,
      readyAt: null,
      variants: [],
    };
    expect(FileResponse.parse(pending)).toEqual(pending);
  });

  it.each([
    ['unknown status', { status: 'done' }],
    ['non-uuid id', { id: '123' }],
    ['local time without offset', { createdAt: '2026-10-31T12:00:00' }],
    ['fractional attempts', { attempts: 1.5 }],
    ['unknown variant size', { variants: [{ size: 256, url: 'u', bytes: 1 }] }],
    ['negative variant bytes', { variants: [{ size: 128, url: 'u', bytes: -1 }] }],
    ['missing nullable field', { lastError: undefined }],
    ['missing expiresAt', { expiresAt: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(FileResponse.safeParse({ ...file, ...patch }).success).toBe(false);
  });

  it('accepts every variant size the contract defines', () => {
    const variants = VARIANT_SIZES.map((size) => ({ size, url: 'u', bytes: 1 }));
    expect(FileResponse.safeParse({ ...file, variants }).success).toBe(true);
  });
});

describe('list, status event, stats and health bodies', () => {
  it('requires nextCursor to be present, null or a string', () => {
    expect(ListFilesResponse.safeParse({ items: [file], nextCursor: null }).success).toBe(true);
    expect(ListFilesResponse.safeParse({ items: [file], nextCursor: uuid }).success).toBe(true);
    expect(ListFilesResponse.safeParse({ items: [file] }).success).toBe(false);
    expect(ListFilesResponse.safeParse({ items: [{ ...file, id: 'x' }], nextCursor: null }).success).toBe(
      false,
    );
  });

  it('parses the SSE status event and rejects an unknown status', () => {
    const ev = { id: uuid, status: 'processing', width: null, height: null, lastError: null };
    expect(FileStatusEvent.parse(ev)).toEqual(ev);
    expect(FileStatusEvent.safeParse({ ...ev, status: 'weird' }).success).toBe(false);
  });

  it('validates the day format of a daily stat', () => {
    const stat = {
      day: '2026-10-31',
      platform: 'local',
      uploads: 1,
      ready: 1,
      failed: 0,
      bytesIn: 10,
      p50ProcessingMs: null,
      p95ProcessingMs: 5,
    };
    expect(StatsResponse.parse({ items: [stat] }).items).toHaveLength(1);
    for (const day of ['2026-10-31T00:00:00Z', '31-10-2026', '2026-1-1', '']) {
      expect(DailyStat.safeParse({ ...stat, day }).success).toBe(false);
    }
  });

  it('knows the shape of health and deep health', () => {
    expect(Health.safeParse({ status: 'ok' }).success).toBe(true);
    expect(Health.safeParse({ status: 'down' }).success).toBe(false);
    const checks = {
      database: { status: 'ok', latencyMs: 2 },
      storage: { status: 'unknown' },
      queue: { status: 'down', error: 'x' },
    };
    expect(DeepHealth.safeParse({ status: 'down', checks }).success).toBe(true);
    expect(DeepHealth.safeParse({ status: 'unknown', checks }).success).toBe(false);
    expect(
      DeepHealth.safeParse({ status: 'ok', checks: { ...checks, queue: { status: 'ok', latencyMs: -1 } } })
        .success,
    ).toBe(false);
    expect(DeepHealth.safeParse({ status: 'ok', checks: { database: checks.database } }).success).toBe(false);
  });

  it('parses an upload response and a path id', () => {
    const res = {
      fileId: uuid,
      uploadUrl: 'https://s/x',
      uploadHeaders: { 'content-type': 'image/png' },
      expiresAt: iso,
    };
    expect(CreateUploadResponse.parse(res)).toEqual(res);
    expect(CreateUploadResponse.safeParse({ ...res, uploadHeaders: { a: 1 } }).success).toBe(false);
    expect(FileIdParam.safeParse({ id: uuid }).success).toBe(true);
    expect(FileIdParam.safeParse({ id: '../etc/passwd' }).success).toBe(false);
  });
});

describe('query bounds', () => {
  it('limits the cursor length', () => {
    expect(ListFilesQuery.safeParse({ cursor: 'a'.repeat(128) }).success).toBe(true);
    expect(ListFilesQuery.safeParse({ cursor: 'a'.repeat(129) }).success).toBe(false);
    expect(ListFilesQuery.safeParse({ cursor: '' }).success).toBe(false);
  });

  it.each(['1', '100'])('accepts limit=%s at the edge', (limit) => {
    expect(ListFilesQuery.parse({ limit }).limit).toBe(Number(limit));
  });

  it('accepts a very large declared size (answered with 413) but never a non-number', () => {
    expect(CreateUploadRequest.safeParse({ contentType: 'image/png', bytes: 2 ** 60 }).success).toBe(true);
    expect(
      CreateUploadRequest.safeParse({ contentType: 'image/png', bytes: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(CreateUploadRequest.safeParse({ contentType: 'image/png', bytes: null }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ contentType: 'image/png' }).success).toBe(false);
  });
});

describe('RUM closed lists', () => {
  const ok = {
    name: 'LCP',
    value: 1,
    platform: 'aws',
    variant: 'portable',
    topology: 'single',
    region: 'local',
  };

  it.each([
    ['name', RUM_METRIC_NAMES],
    ['platform', RUM_PLATFORMS],
    ['variant', RUM_VARIANTS],
    ['topology', RUM_TOPOLOGIES],
    ['region', RUM_REGIONS],
  ] as const)('accepts every %s of the list and nothing outside it', (key, list) => {
    for (const value of list) expect(RumRequest.safeParse({ ...ok, [key]: value }).success).toBe(true);
    expect(RumRequest.safeParse({ ...ok, [key]: `${list[0]}-x` }).success).toBe(false);
    const flipped = list[0].toLowerCase() === list[0] ? list[0].toUpperCase() : list[0].toLowerCase();
    expect(RumRequest.safeParse({ ...ok, [key]: flipped }).success).toBe(false);
  });

  it('accepts every rating and rejects others, and rejects missing required fields', () => {
    for (const rating of RUM_RATINGS) expect(RumRequest.safeParse({ ...ok, rating }).success).toBe(true);
    expect(RumRequest.safeParse({ ...ok, rating: 'great' }).success).toBe(false);
    for (const key of ['name', 'value', 'platform', 'variant', 'topology'] as const) {
      const { [key]: _omitted, ...rest } = ok;
      expect(RumRequest.safeParse(rest).success).toBe(false);
    }
  });

  it('bounds the value', () => {
    expect(RumRequest.safeParse({ ...ok, value: 10_000_000 }).success).toBe(true);
    expect(RumRequest.safeParse({ ...ok, value: 10_000_001 }).success).toBe(false);
    expect(RumRequest.safeParse({ ...ok, value: Number.NaN }).success).toBe(false);
  });
});

describe('constants', () => {
  it('keeps the variant sizes ascending and the terminal statuses a subset of the statuses', () => {
    expect([...VARIANT_SIZES]).toEqual([...VARIANT_SIZES].sort((a, b) => a - b));
    for (const s of TERMINAL_STATUSES) expect(FILE_STATUSES).toContain(s);
    expect(new Set(FILE_STATUSES).size).toBe(FILE_STATUSES.length);
  });
});

describe('Problem members', () => {
  it('accepts validation errors and rejects malformed ones', () => {
    const p = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      errors: [{ path: 'json.bytes', message: 'Invalid' }],
    };
    expect(Problem.parse(p)).toEqual(p);
    expect(Problem.safeParse({ ...p, errors: [{ path: 'x' }] }).success).toBe(false);
    expect(Problem.safeParse({ ...p, status: 600 }).success).toBe(false);
    expect(Problem.safeParse({ ...p, status: 399 }).success).toBe(false);
  });
});
