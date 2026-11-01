import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStaticHandler } from '../src/static';

let handle: (req: Request) => Promise<Response | null>;

const get = (path: string, method = 'GET') => handle(new Request(`http://x.test${path}`, { method }));

beforeAll(() => {
  const parent = mkdtempSync(join(tmpdir(), 'hm-static-'));
  const root = join(parent, 'dist');
  for (const dir of ['assets', 'app', 'pricing', 'api', 'f', 'media', 'health', '.vite'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(parent, 'secret.txt'), 'outside the root');
  writeFileSync(join(root, 'index.html'), 'landing');
  writeFileSync(join(root, 'pricing/index.html'), 'pricing');
  writeFileSync(join(root, 'app/index.html'), 'shell');
  writeFileSync(join(root, 'rum.js'), 'rum');
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
  handle = createStaticHandler({ root });
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
