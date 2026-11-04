import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vite copies public/ to the root of dist/, which every platform serves as static files (D21, D300, D301).
const web = join(__dirname, '..');
const read = (path: string) => readFileSync(join(web, path), 'utf8');

describe('files at the root of the build', () => {
  it('robots.txt keeps crawlers out of the panel and the API only (D300)', () => {
    expect(read('public/robots.txt')).toBe('User-agent: *\nDisallow: /app\nDisallow: /api\n');
  });

  it('favicon.svg is a self-contained SVG: no script, no link, no external reference (D301)', () => {
    const svg = read('public/favicon.svg').trim();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">.*<\/svg>$/s);
    expect(svg).not.toMatch(/<script|<a\b|href|<image|<foreignObject|url\(|on\w+=/i);
    expect(Buffer.byteLength(svg)).toBeLessThan(1024);
  });

  it('the panel shell links the favicon', () => {
    expect(read('app/index.html')).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  });
});
