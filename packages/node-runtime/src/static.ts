// Serves the built web app (apps/web/dist) from a Node process with the headers a CDN would apply (D21, D88) and the
// security headers of D310. Platform-neutral on purpose: local, VPS, Fly, Railway and GCP serve the files with it.
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { securityHeaders } from '@hostmark/contract';
import { htmlSecurityHeaders, isHttps } from '@hostmark/core';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';

/** Prefixes owned by the application: a static miss there goes to the app, never to a rewrite. */
const RESERVED = ['/api', '/f', '/media', '/health'];

/** Single page app routes that all serve the same shell. */
const SHELL = 'app/index.html';
const isShellRoute = (path: string) => {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return p === '/login' || p === '/signup' || p === '/app' || p.startsWith('/app/');
};

const isReserved = (path: string) => RESERVED.some((p) => path === p || path.startsWith(`${p}/`));

export interface StaticOptions {
  /** Directory with the Vite build and the prerendered pages. */
  root: string;
  /**
   * D310. `publicUrl` decides HSTS as it does for the app (`isHttps` of core); `storageOrigin` is the origin of the
   * presigned URLs, which the HTML policy allows for thumbnails and uploads (`storageSecurity` of ./runtime).
   */
  security: { publicUrl?: string; storageOrigin: string };
}

/**
 * Returns a handler that answers GET and HEAD for files under `root`, or `null` when the request is not for a
 * file (so the caller can pass it on). Files are read once: the directory is immutable for the life of a deploy.
 */
export function createStaticHandler(options: StaticOptions): (req: Request) => Promise<Response | null> {
  const root = resolve(options.root);
  const { publicUrl } = options.security;
  // Resolved on first use: the directory may not exist yet when the handler is created.
  let realRoot: string | undefined;
  const cache = new Map<string, Buffer | null>();

  async function read(file: string): Promise<Buffer | null> {
    if (cache.has(file)) return cache.get(file) ?? null;
    let body: Buffer | null;
    try {
      realRoot ??= await realpath(root);
      // A symlink inside the root must not lead out of it.
      const real = await realpath(file);
      body = real.startsWith(realRoot + sep) ? await readFile(real) : null;
    } catch {
      body = null;
    }
    // Misses are not remembered: an unbounded set of probed paths must not grow the cache.
    if (body) cache.set(file, body);
    return body;
  }

  /** Maps a URL path to a file under root, or null if the path escapes it or is malformed. */
  function candidates(path: string): string[] | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    // `..` and dotfiles (`/.vite/manifest.json`, `/.env`) are never served.
    if (decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
    const rel = isShellRoute(decoded) ? SHELL : decoded === '/' ? 'index.html' : decoded.slice(1);
    const base = resolve(join(root, rel));
    if (base !== root && !base.startsWith(root + sep)) return null;
    // A path with an extension is a file; `/pricing` is the prerendered `pricing/index.html`.
    return extname(rel) ? [base] : [`${base}.html`, join(base, 'index.html')];
  }

  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const path = new URL(req.url).pathname;
    if (isReserved(path)) return null;
    // A shell route always serves the one shell file, whatever follows `/app/`: the path is never mapped to the file
    // system, so `/app/files/..%2f..%2fetc` gets the app and its "File not found" view, not the API's 404 (D303).
    const files = isShellRoute(path) ? [join(root, SHELL)] : candidates(path);
    // Malformed and dotfile paths under /assets/ are a plain miss, with the same no-store answer as any other.
    if (!files) return path.startsWith('/assets/') ? notFound(req) : null;
    for (const file of files) {
      const body = await read(file);
      if (!body) continue;
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const headers = {
        // D310: HTML documents get their policy; scripts, styles, images and text only the common set.
        ...(type.startsWith('text/html')
          ? htmlSecurityHeaders({
              https: isHttps(req, publicUrl),
              storageOrigin: options.security.storageOrigin,
            })
          : securityHeaders('other', { https: isHttps(req, publicUrl) })),
        'content-type': type,
        'content-length': String(body.length),
        'cache-control': path.startsWith('/assets/') ? IMMUTABLE : SHORT,
      };
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), { headers });
    }
    // A CDN must not keep the miss of an asset that the next deploy adds (the app's own 404 is no-store too, D303).
    return path.startsWith('/assets/') ? notFound(req) : null;
  };

  function notFound(req: Request): Response {
    return new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }), {
      status: 404,
      headers: {
        ...securityHeaders('other', { https: isHttps(req, publicUrl) }),
        'content-type': 'application/problem+json',
        'cache-control': 'no-store',
      },
    });
  }
}
