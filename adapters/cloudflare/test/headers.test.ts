// The generated `_headers` file served by the Workers static assets of workerd (Miniflare): each file gets exactly one
// Cache-Control value (D251). Without the detach, `/assets/*` and `/*` both match a hashed file and the two values are
// joined with a comma.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HSTS, HTML_SECURITY_HEADERS, htmlCsp } from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headersFile, IMMUTABLE, PAGE_PATHS, SHORT, storageOriginForBuild } from '../scripts/headers.mjs';
import { root } from './build';
import { COMPATIBILITY_DATE } from './miniflare';

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><title>home</title>',
  'pricing/index.html': '<!doctype html><title>pricing</title>',
  'app/index.html': '<!doctype html><title>app</title>',
  'rum.js': 'export {};',
  'robots.txt': 'User-agent: *',
  'favicon.svg': '<svg/>',
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
  const fetchHeaders = async (path: string) => {
    const res = await mf.dispatchFetch(`http://localhost${path}`, { redirect: 'manual' });
    await res.arrayBuffer();
    expect(res.status, path).toBe(200);
    return res.headers;
  };
  const cacheControl = async (path: string) => (await fetchHeaders(path)).get('cache-control');
  return {
    cacheControl,
    fetchHeaders,
    async close() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const STORAGE = 'https://0123abcd.r2.cloudflarestorage.com';
const COMMON = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': HSTS,
};

describe('_headers of the static assets (D251)', () => {
  let site: Awaited<ReturnType<typeof served>>;
  beforeAll(async () => {
    site = await served(headersFile({ storageOrigin: STORAGE }));
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
    expect(build).toMatch(/writeFileSync\(join\(assets, '_headers'\), headersFile\(\{ storageOrigin \}\)\)/);
    expect(build).toMatch(/const storageOrigin = storageOriginForBuild\(\);/);
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

describe('security headers of the static assets (D310)', () => {
  let site: Awaited<ReturnType<typeof served>>;
  beforeAll(async () => {
    site = await served(headersFile({ storageOrigin: STORAGE }));
  });
  afterAll(async () => site?.close());

  it('gives every file the common set once, HSTS included', async () => {
    for (const path of [
      '/',
      '/pricing/',
      '/app/',
      '/rum.js',
      '/robots.txt',
      '/favicon.svg',
      '/assets/app-BxJ8igUc.js',
    ]) {
      const headers = Object.fromEntries(await site.fetchHeaders(path));
      // A header set by two rules would be joined with a comma (D251), so equality proves a single value.
      expect(headers, path).toMatchObject(COMMON);
    }
  });

  it('gives the prerendered pages the HTML set with the R2 origin, and nothing else gets it', async () => {
    const html = {
      'content-security-policy': htmlCsp({ storageOrigin: STORAGE, styleHashes: STYLE_HASHES }),
      ...HTML_SECURITY_HEADERS,
    };
    for (const path of ['/', '/pricing/'])
      expect(Object.fromEntries(await site.fetchHeaders(path)), path).toMatchObject(html);
    // The shell's set comes from the Worker (src/api.ts), the rest gets none.
    for (const path of ['/app/', '/rum.js', '/robots.txt', '/favicon.svg', '/assets/app-VDs-mQO7.css']) {
      const headers = await site.fetchHeaders(path);
      for (const name of Object.keys(html)) expect(headers.get(name), `${path} ${name}`).toBeNull();
    }
    expect(PAGE_PATHS).toEqual(['/', '/index.html', '/pricing', '/pricing/', '/pricing/index.html']);
  });

  it('takes the storage origin from the environment, else from the vars of wrangler.api.jsonc', () => {
    const config = '{ "vars": { "R2_ACCOUNT_ID": "acc", "R2_BUCKET_NAME": "hostmark-files" } }';
    expect(storageOriginForBuild({}, config)).toBe('https://acc.r2.cloudflarestorage.com');
    expect(storageOriginForBuild({ R2_ACCOUNT_ID: 'other' }, config)).toBe(
      'https://other.r2.cloudflarestorage.com',
    );
    expect(storageOriginForBuild({ R2_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000/x' }, config)).toBe(
      'http://127.0.0.1:9000',
    );
    // The committed file: the placeholder stands in until the owner's account id is there (D255).
    expect(storageOriginForBuild({})).toBe('https://replace_with_account_id.r2.cloudflarestorage.com');
  });
});
