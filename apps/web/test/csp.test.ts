// @vitest-environment node
// D310: every HTML document of the build is served with `htmlCsp` (no 'unsafe-inline'), so the build itself must not
// contain anything that policy blocks. Builds into a temporary directory exactly as `pnpm build` does (Vite, then the
// prerender of packages/pages) and reads what came out.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlCsp } from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const web = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pages = resolve(web, '../../packages/pages');
let dist: string;

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

const files = (dir: string, ext: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f));

const cspHash = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/** The source list of one directive, e.g. `style-src`. */
const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? [];

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'hm-web-dist-'));
  run(
    [
      join(web, 'node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      dist,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    web,
  );
  run(['--import', 'tsx', 'scripts/prerender.ts'], pages, { HOSTMARK_DIST: dist });
}, 120_000);
afterAll(() => {
  if (dist) rmSync(dist, { recursive: true, force: true });
});

describe('the built web app under its Content-Security-Policy (D310)', () => {
  const csp = htmlCsp({ storageOrigin: 'https://bucket.example', styleHashes: STYLE_HASHES });

  it('has the three HTML documents every platform serves', () => {
    const html = files(dist, '.html').map((f) => f.slice(dist.length + 1).replaceAll('\\', '/'));
    expect(html.sort()).toEqual(['app/index.html', 'index.html', 'pricing/index.html']);
  });

  it('has only inline styles whose hash the policy allows', () => {
    const allowed = directive(csp, 'style-src');
    expect(allowed).not.toContain("'unsafe-inline'");
    let count = 0;
    for (const file of files(dist, '.html')) {
      const html = readFileSync(file, 'utf8');
      for (const [, body] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
        count++;
        expect(allowed, file).toContain(`'${cspHash(body as string)}'`);
      }
    }
    // The landing and pricing pages carry one each; the panel shell has none.
    expect(count).toBe(2);
  });

  it('has no inline script, style attribute or event handler attribute', () => {
    for (const file of files(dist, '.html')) {
      const html = readFileSync(file, 'utf8');
      for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) expect(tag, file).toMatch(/\ssrc="\/[^/]/);
      expect(html, file).not.toMatch(/<[^>]+\sstyle=/);
      expect(html, file).not.toMatch(/<[^>]+\son[a-z]+=/i);
    }
  });

  it('loads scripts and styles from its own origin only, and evaluates no strings', () => {
    for (const file of files(dist, '.html')) {
      const html = readFileSync(file, 'utf8');
      for (const [, url] of html.matchAll(/\s(?:src|href)="([^"]*)"/g))
        expect(url, file).toMatch(/^\/(?!\/)/);
    }
    for (const file of files(dist, '.js')) {
      const js = readFileSync(file, 'utf8');
      // script-src 'self' without 'unsafe-eval'.
      expect(js, file).not.toMatch(/\bnew Function\(|\beval\(/);
    }
  });
});
