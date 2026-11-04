// The gateway's trace id on cached paths (D257), with the response a Workers Caching hit would replay.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADER_TRACE_ID } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { withOwnTraceId } from '../src/http';
import { root } from './build';

const STORED = 'ab'.repeat(16);

/** What the Media entrypoint answered once and the cache stores: the same headers on every hit. */
const cached = (cacheControl: string, status = 200) =>
  new Response('webp-bytes', {
    status,
    headers: {
      [HEADER_TRACE_ID]: STORED,
      'cache-control': cacheControl,
      'content-type': 'image/webp',
      'x-platform': 'cloudflare-portable',
    },
  });

describe('withOwnTraceId', () => {
  it('gives every response of a cacheable path its own trace id, not the one stored with the entry', async () => {
    const ids = new Set<string>();
    for (let hit = 0; hit < 3; hit++) {
      const res = withOwnTraceId(cached('public, max-age=31536000, immutable'));
      const id = res.headers.get(HEADER_TRACE_ID) ?? '';
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe(STORED);
      ids.add(id);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-platform')).toBe('cloudflare-portable');
      expect(await res.text()).toBe('webp-bytes');
    }
    expect(ids.size).toBe(3);
  });

  it('leaves a no-store response alone: it is never stored, and its problem body names that id', () => {
    for (const cc of ['no-store', 'private, no-store', 'No-Store'])
      expect(withOwnTraceId(cached(cc, 404)).headers.get(HEADER_TRACE_ID)).toBe(STORED);
  });

  it('is applied by the api gateway to /media and /f', () => {
    const api = readFileSync(join(root, 'src', 'api.ts'), 'utf8');
    expect(api).toMatch(
      /if \(isCacheable\(request\.method, url\.pathname\)\) return withOwnTraceId\(await media\.fetch\(request\)\);/,
    );
  });
});
