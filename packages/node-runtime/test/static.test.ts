import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HSTS, HTML_SECURITY_HEADERS, htmlCsp } from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { beforeAll, describe, expect, it } from 'vitest';
import { staticSecurity } from '../src/runtime';
import { createStaticHandler } from '../src/static';

const STORAGE = 'http://127.0.0.1:59000';
let root: string;

let handle: (req: Request) => Promise<Response | null>;

const get = (path: string, method = 'GET') => handle(new Request(`http://x.test${path}`, { method }));

beforeAll(() => {
  const parent = mkdtempSync(join(tmpdir(), 'hm-static-'));
  root = join(parent, 'dist');
  for (const dir of ['assets', 'app', 'pricing', 'api', 'f', 'media', 'health', '.vite'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(parent, 'secret.txt'), 'outside the root');
  writeFileSync(join(root, 'index.html'), 'landing');
  writeFileSync(join(root, 'pricing/index.html'), 'pricing');
  writeFileSync(join(root, 'app/index.html'), 'shell');
  writeFileSync(join(root, 'rum.js'), 'rum');
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *\n');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  writeFileSync(join(root, 'assets/app-abc.js'), 'js');
  writeFileSync(join(root, 'assets/app-abc.css'), 'css');
  writeFileSync(join(root, 'assets/logo.svg'), '<svg/>');
  writeFileSync(join(root, 'assets/font.woff2'), 'f');
  writeFileSync(join(root, 'assets/blob.bin'), 'b');
  // Files that exist under the reserved prefixes: only the prefix rule keeps them from being served.
  for (const file of ['api/health', 'f/abc', 'media/x', 'health/deep', 'health.html'])
    writeFileSync(join(root, file), 'shadow');
  writeFileSync(join(root, '.vite/manifest.json'), '{}');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  symlinkSync(join(parent, 'secret.txt'), join(root, 'assets/link.txt'));
  handle = createStaticHandler({ root, security: { publicUrl: 'http://x.test', storageOrigin: STORAGE } });
});

describe('static handler', () => {
  it('serves prerendered pages with a short cache', async () => {
    for (const [path, body] of [
      ['/', 'landing'],
      ['/pricing', 'pricing'],
      ['/pricing/', 'pricing'],
    ] as const) {
      const res = await get(path);
      expect(res?.status).toBe(200);
      expect(await res?.text()).toBe(body);
      expect(res?.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res?.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('rewrites application routes to the shell', async () => {
    for (const path of ['/login', '/login/', '/signup', '/signup/', '/app', '/app/', '/app/files/123']) {
      const res = await get(path);
      expect(await res?.text(), path).toBe('shell');
    }
    expect(await get('/loginx')).toBeNull();
    expect(await get('/application')).toBeNull();
  });

  it('serves the shell for any path below /app/, even one that is no file path (D303)', async () => {
    for (const path of [
      '/app/files/..%2f..%2fetc',
      '/app/files/not-a-uuid',
      '/app/%ff',
      '/app/files/%2e%2e%2fx',
    ]) {
      const res = await get(path);
      expect(res?.status, path).toBe(200);
      expect(await res?.text(), path).toBe('shell');
      expect(res?.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
    }
  });

  it('serves robots.txt and the favicon from the root with the short cache (D300, D301)', async () => {
    for (const [path, type] of [
      ['/robots.txt', 'text/plain; charset=utf-8'],
      ['/favicon.svg', 'image/svg+xml'],
    ] as const) {
      const res = await get(path);
      expect(res?.status, path).toBe(200);
      expect(res?.headers.get('content-type'), path).toBe(type);
      expect(res?.headers.get('cache-control'), path).toBe('public, max-age=300');
    }
  });

  it('marks hashed assets immutable and rum.js short-lived', async () => {
    expect((await get('/assets/app-abc.js'))?.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await get('/rum.js'))?.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('sets the content type by extension', async () => {
    const types: Record<string, string> = {
      '/assets/app-abc.js': 'text/javascript; charset=utf-8',
      '/assets/app-abc.css': 'text/css; charset=utf-8',
      '/assets/logo.svg': 'image/svg+xml',
      '/assets/font.woff2': 'font/woff2',
      '/assets/blob.bin': 'application/octet-stream',
      '/rum.js': 'text/javascript; charset=utf-8',
    };
    for (const [path, type] of Object.entries(types))
      expect((await get(path))?.headers.get('content-type'), path).toBe(type);
  });

  it('answers HEAD with headers and no body, and ignores other methods', async () => {
    const res = await get('/assets/app-abc.js', 'HEAD');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-length')).toBe('2');
    expect(await res?.text()).toBe('');
    expect(await get('/', 'POST')).toBeNull();
    expect(await get('/', 'DELETE')).toBeNull();
  });

  it('never shadows application prefixes', async () => {
    for (const path of ['/api/health', '/api/files', '/f/abc', '/media/x', '/health', '/health/deep'])
      expect(await get(path), path).toBeNull();
  });

  it('passes a miss on to the app, except under /assets/, which is a no-store 404', async () => {
    expect(await get('/nope')).toBeNull();
    const miss = await get('/assets/missing.js');
    expect(miss?.status).toBe(404);
    expect(miss?.headers.get('cache-control')).toBe('no-store');
  });

  it('does not serve dotfiles or follow symlinks out of the root', async () => {
    for (const path of ['/.env', '/.vite/manifest.json']) expect(await get(path), path).toBeNull();
    const res = await get('/assets/link.txt');
    expect(res?.status).toBe(404);
    expect(await res?.text()).not.toContain('outside the root');
  });

  it('answers a no-store 404 for malformed and dotfile paths under /assets/', async () => {
    for (const path of ['/assets/%ff', '/assets/.hidden.js']) {
      const res = await get(path);
      expect(res?.status, path).toBe(404);
      expect(res?.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('refuses path traversal in every encoding', async () => {
    const attempts = [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/assets/..\\..\\secret.txt',
      '/%252e%252e/secret.txt',
      '/index.html%00.js',
      '/%',
      '/%c0%ae%c0%ae/secret.txt',
    ];
    for (const path of attempts) {
      const request = new Request(`http://x.test${path}`);
      const res = await handle(request);
      const body = res ? await res.text() : null;
      expect(body, path).not.toBe('outside the root');
      // Under /assets/ a refusal is the no-store 404; elsewhere the request goes on to the app.
      if (new URL(request.url).pathname.startsWith('/assets/')) expect(res?.status, path).toBe(404);
      else expect(res, path).toBeNull();
    }
  });
});

describe('security headers of static files (D310)', () => {
  const common = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  const HTML = ['/', '/pricing', '/pricing/', '/login', '/signup/', '/app', '/app/files/123'];
  const OTHER = [
    '/assets/app-abc.js',
    '/assets/app-abc.css',
    '/rum.js',
    '/robots.txt',
    '/favicon.svg',
    '/assets/x.js',
  ];

  it('gives every HTML document the full set, with the storage origin and the page style hashes', async () => {
    for (const path of HTML) {
      const res = await get(path);
      expect(res?.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(Object.fromEntries(res?.headers ?? []), path).toMatchObject({
        ...common,
        ...HTML_SECURITY_HEADERS,
        'content-security-policy': htmlCsp({ storageOrigin: STORAGE, styleHashes: STYLE_HASHES }),
      });
    }
  });

  it('gives assets, rum.js, robots.txt, the favicon and the assets 404 only the common set', async () => {
    for (const path of OTHER) {
      const res = await get(path);
      const headers = Object.fromEntries(res?.headers ?? []);
      expect(headers, path).toMatchObject(common);
      for (const name of ['content-security-policy', ...Object.keys(HTML_SECURITY_HEADERS)])
        expect(headers[name], `${path} ${name}`).toBeUndefined();
    }
  });

  it('sends no HSTS over plain HTTP, even when a client claims https', async () => {
    for (const path of [...HTML, ...OTHER]) {
      const res = await handle(
        new Request(`http://x.test${path}`, { headers: { 'x-forwarded-proto': 'https' } }),
      );
      expect(res?.headers.get('strict-transport-security'), path).toBeNull();
    }
  });

  it('sends HSTS on everything when the public URL is https', async () => {
    const tls = createStaticHandler({
      root,
      security: { publicUrl: 'https://hostmark.example', storageOrigin: 'https://bucket.example' },
    });
    for (const path of [...HTML, ...OTHER]) {
      const res = await tls(new Request(`http://api:8080${path}`));
      expect(res?.headers.get('strict-transport-security'), path).toBe(HSTS);
    }
    expect((await tls(new Request('http://api:8080/')))?.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://bucket.example",
    );
  });

  it('takes the storage origin from the settings the storage presigns with', () => {
    const env = {
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'hostmark',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_VIRTUAL_HOST: 'false',
      PUBLIC_URL: 'http://127.0.0.1:58080',
    } as Parameters<typeof staticSecurity>[0];
    expect(staticSecurity(env)).toEqual({
      publicUrl: 'http://127.0.0.1:58080',
      storageOrigin: 'http://minio:9000',
    });
    expect(staticSecurity({ ...env, S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:59000' }).storageOrigin).toBe(
      STORAGE,
    );
    expect(
      staticSecurity({ ...env, S3_ENDPOINT: 'https://fly.storage.tigris.dev', S3_VIRTUAL_HOST: 'true' })
        .storageOrigin,
    ).toBe('https://hostmark.fly.storage.tigris.dev');
  });
});
