import { readFileSync } from 'node:fs';
import { type Key, pathToRegexp } from 'path-to-regexp';
import { describe, expect, it } from 'vitest';
import { CACHE_HEADERS, cacheControlFor } from '../scripts/check-config';

// Routing of vercel.json as the Vercel CLI 65.11.0 builds it (`@vercel/routing-utils` `getTransformedRoutes`): the
// filesystem (static files of `public/` and the functions of `api/`) answers first, then `rewrites` in order, each
// source compiled with path-to-regexp 6 `{ strict: true, sensitive: true, delimiter: '/' }`, each destination checked
// against the filesystem again (`check: true`). A path neither serves is Vercel's 404. A model, not the platform.
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const rewrites = config.rewrites.map((r) => {
  const keys: Key[] = [];
  const src = pathToRegexp(r.source, keys, { strict: true, sensitive: true, delimiter: '/' });
  return { src, keys, dest: r.destination };
});

// What `scripts/build.ts` leaves in public/ (apps/web/dist, D21) and the zero-config function paths.
const FILES = ['/index.html', '/pricing/index.html', '/app/index.html', '/rum.js', '/assets/app-1a2b3c.js'];
const FUNCTIONS = ['/api/index', '/api/queue', '/api/cron'];

function filesystem(path: string): string | undefined {
  if (FUNCTIONS.includes(path)) return `function ${path}`;
  const file = path.endsWith('/') ? `${path}index.html` : path;
  return FILES.includes(file) ? `file ${file}` : undefined;
}

/** The destination with its named parameters filled in, as routing-utils does (`:job` becomes `$1`). */
function destination(rewrite: (typeof rewrites)[number], path: string): string {
  const match = rewrite.src.exec(path) ?? [];
  return rewrite.keys.reduce((d, key, i) => d.replace(`:${key.name}`, match[i + 1] ?? ''), rewrite.dest);
}

function route(path: string): string {
  const hit = filesystem(path);
  if (hit) return hit;
  const rewrite = rewrites.find((r) => r.src.test(path));
  if (!rewrite) return '404';
  const [dest, query] = destination(rewrite, path).split('?');
  const target = filesystem(dest ?? '');
  return target ? `${target}${query ? `?${query}` : ''}` : '404';
}

const id = '0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42';

describe('vercel.json routes', () => {
  it('serves the app shell for the panel routes, with one trailing slash (D88)', () => {
    for (const path of ['/login', '/login/', '/signup', '/signup/', '/app', '/app/', `/app/files/${id}`])
      expect(route(path), path).toBe('file /app/index.html');
  });

  it('serves the prerendered pages, the landing page only at /', () => {
    expect(route('/')).toBe('file /index.html');
    expect(route('/pricing')).toBe('file /pricing/index.html');
    expect(route('/pricing/')).toBe('file /pricing/index.html');
  });

  it('sends the api, /media and /f to the api function, and cron and queue to their own', () => {
    for (const path of ['/api/health', '/api/files', `/api/files/${id}`, '/api/auth/sign-in/email'])
      expect(route(path), path).toBe('function /api/index');
    expect(route(`/media/${id}/128.webp`)).toBe('function /api/index');
    expect(route(`/f/${id}`)).toBe('function /api/index');
    expect(route('/api/cron')).toBe('function /api/cron');
    expect(route('/api/queue')).toBe('function /api/queue');
  });

  it('sends each cron path to the cron function with the job, and nothing deeper (D272)', () => {
    expect(route('/api/cron/requeue-stuck')).toBe('function /api/cron?job=requeue-stuck');
    expect(route('/api/cron/drop-tables')).toBe('function /api/cron?job=drop-tables');
    for (const path of ['/api/cron/', '/api/cron/a/b']) expect(route(path), path).toBe('404');
    expect(route('/api/cronx')).toBe('function /api/index');
  });

  it('serves static files and answers 404 for anything else, never the landing page', () => {
    expect(route('/rum.js')).toBe('file /rum.js');
    expect(route('/assets/app-1a2b3c.js')).toBe('file /assets/app-1a2b3c.js');
    for (const path of ['/assets/app-gone.js', '/nope', '/loginx', '/application', '/Login'])
      expect(route(path), path).toBe('404');
  });
});

// Headers routes come before the filesystem with `continue: true`, so they match the path as requested (D276).
describe('vercel.json Cache-Control', () => {
  it('matches the static handler of D88: a year for /assets, 300 s for HTML and /rum.js, nothing elsewhere', () => {
    for (const [path, expected] of Object.entries(CACHE_HEADERS))
      expect(cacheControlFor(config, path), path).toBe(expected);
  });

  it('gives every path that serves HTML or /rum.js the short header', () => {
    const served = [
      '/',
      '/pricing',
      '/pricing/',
      '/login',
      '/login/',
      '/signup',
      '/app',
      '/app/',
      `/app/files/${id}`,
    ];
    for (const path of served) {
      expect(route(path), path).toMatch(/^file .*\.html$/);
      expect(cacheControlFor(config, path), path).toBe('public, max-age=300');
    }
    for (const file of FILES.filter((f) => !f.startsWith('/assets/')))
      expect(cacheControlFor(config, file), file).toBe('public, max-age=300');
  });

  it('leaves function answers and Vercel 404s alone', () => {
    for (const path of [
      '/api/health',
      '/api/cron/daily-stats',
      `/media/${id}/128.webp`,
      `/f/${id}`,
      '/loginx',
      '/application',
    ])
      expect(cacheControlFor(config, path), path).toBeUndefined();
  });
});
