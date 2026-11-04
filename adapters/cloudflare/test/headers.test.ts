// The generated `_headers` file served by the Workers static assets of workerd (Miniflare): each file gets exactly one
// Cache-Control value (D251). Without the detach, `/assets/*` and `/*` both match a hashed file and the two values are
// joined with a comma.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headersFile, IMMUTABLE, SHORT } from '../scripts/headers.mjs';
import { root } from './build';
import { COMPATIBILITY_DATE } from './miniflare';

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><title>home</title>',
  'pricing/index.html': '<!doctype html><title>pricing</title>',
  'app/index.html': '<!doctype html><title>app</title>',
  'rum.js': 'export {};',
  'assets/app-BxJ8igUc.js': 'export {};',
  'assets/app-VDs-mQO7.css': 'body{}',
};

async function served(headers: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hm-cf-assets-'));
  for (const [path, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  writeFileSync(join(dir, '_headers'), headers);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };',
    compatibilityDate: COMPATIBILITY_DATE,
    // The same asset settings as wrangler.api.jsonc.
    assets: {
      directory: dir,
      binding: 'ASSETS',
      assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
    },
  });
  await mf.ready;
  const cacheControl = async (path: string) => {
    const res = await mf.dispatchFetch(`http://localhost${path}`, { redirect: 'manual' });
    await res.arrayBuffer();
    expect(res.status, path).toBe(200);
    return res.headers.get('cache-control');
  };
  return {
    cacheControl,
    async close() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('_headers of the static assets (D251)', () => {
  let site: Awaited<ReturnType<typeof served>>;
  beforeAll(async () => {
    site = await served(headersFile());
  });
  afterAll(async () => site?.close());

  it('gives a hashed asset the immutable policy and nothing else', async () => {
    expect(await site.cacheControl('/assets/app-BxJ8igUc.js')).toBe(IMMUTABLE);
    expect(await site.cacheControl('/assets/app-VDs-mQO7.css')).toBe(IMMUTABLE);
  });

  it('gives the pages and rum.js five minutes', async () => {
    for (const path of ['/', '/pricing/', '/app/', '/rum.js'])
      expect(await site.cacheControl(path)).toBe(SHORT);
  });

  it('is what scripts/build.mjs writes', () => {
    const build = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
    expect(build).toMatch(/writeFileSync\(join\(assets, '_headers'\), headersFile\(\)\)/);
  });

  it('would join two values without the detach, which is the defect it prevents', async () => {
    const old = await served(`/assets/*\n  Cache-Control: ${IMMUTABLE}\n/*\n  Cache-Control: ${SHORT}\n`);
    try {
      expect(await old.cacheControl('/assets/app-BxJ8igUc.js')).toBe(`${IMMUTABLE}, ${SHORT}`);
    } finally {
      await old.close();
    }
  });
});
