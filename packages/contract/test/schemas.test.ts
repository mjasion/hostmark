import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SECONDS,
  CreateUploadRequest,
  DebugCpuQuery,
  JobMessage,
  ListFilesQuery,
  MAX_ATTEMPTS,
  MAX_UPLOAD_BYTES,
  originalKey,
  Problem,
  RumRequest,
  UpdateFileRequest,
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
