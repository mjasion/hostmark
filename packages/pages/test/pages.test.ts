import { createHash } from 'node:crypto';
import { RUM_PLATFORMS } from '@hostmark/contract/constants';
import { describe, expect, it } from 'vitest';
import {
  CSS,
  CSS_HASH,
  CSS_VARIABLES,
  type PublicFile,
  renderError,
  renderLanding,
  renderNotFound,
  renderPricing,
  renderPublicFile,
  STYLE_HASHES,
} from '../src';

const cspHash = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

const rum = { platform: 'aws', variant: 'portable', topology: 'single', region: 'frankfurt' };
const RUM_TAG =
  '<script type="module" src="/rum.js" data-rum="" data-platform="aws" data-variant="portable" data-topology="single" data-region="frankfurt"></script>';

const file: PublicFile = {
  id: '0192f1c2-7b3a-7c1e-8a4d-3f2b1c0d9e8f',
  title: 'Image 2000 x 1000',
  width: 2000,
  height: 1000,
  contentType: 'image/png',
  bytes: 123_456,
  createdAt: new Date('2026-10-31T12:00:00Z'),
};
const urls = {
  page: 'https://hm.test/f/x',
  ogImage: 'https://hm.test/media/x/1600.webp',
  variants: [
    [128, '/media/x/128.webp'],
    [1600, '/media/x/1600.webp'],
  ] as [number, string][],
};

const pages = {
  landing: () => renderLanding(rum),
  pricing: () => renderPricing(rum),
  file: () => renderPublicFile(file, urls, rum),
  notFound: () => renderNotFound(rum),
  error: () => renderError(rum),
};

describe.each(Object.entries(pages))('%s page', (_name, render) => {
  const html = render();

  it('is a complete document with the RUM tag exactly once', () => {
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html.split(RUM_TAG)).toHaveLength(2);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('makes no external request and needs no stylesheet file', () => {
    const urlsInAttributes = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1] as string);
    for (const u of urlsInAttributes) {
      // The og:url, canonical and image URLs are content, not requests; anything loaded is same-origin.
      expect(u).toMatch(/^(\/(?!\/)|#|https:\/\/hm\.test\/)/);
    }
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).not.toMatch(/@import|url\(\s*https?:/);
    expect(html).toContain('<style>');
  });

  it('has only inline styles whose hash the CSP allows, and no style attribute (D310)', () => {
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => cspHash(m[1] as string));
    expect(styles).toEqual([CSS_HASH]);
    for (const hash of styles) expect(STYLE_HASHES).toContain(hash);
    // A `style="..."` attribute needs 'unsafe-inline' (or 'unsafe-hashes'), which no policy grants.
    expect(html).not.toMatch(/<[^>]+\sstyle=/);
  });

  it('links the favicon of the web build, once (D301)', () => {
    expect(html.match(/<link[^>]+rel="icon"[^>]*>/g)).toEqual([
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>',
    ]);
  });
});

describe('static pages', () => {
  it('renders the LCP text without JavaScript', () => {
    expect(renderLanding(rum)).toMatch(/<h1>[^<]+<\/h1>/);
  });

  it('labels the pricing tiers as examples', () => {
    expect(renderPricing(rum)).toContain('example tiers for a benchmark app');
  });

  it('claims nothing it cannot back', () => {
    const text = (renderLanding(rum) + renderPricing(rum)).replace(/<style>[\s\S]*?<\/style>/g, '');
    expect(text).not.toMatch(
      /\d+\s?(\+|k|million)?\s?(customers|users|teams)|trusted by|\buptime\b|\bSLA\b|%/i,
    );
  });
});

describe('style', () => {
  it('has no gradients and uses every exported variable', () => {
    expect(CSS).not.toMatch(/gradient/);
    for (const v of CSS_VARIABLES) expect(CSS).toContain(`${v}:`);
  });

  it('exports the CSP hash of the CSS as it is now (update CSS_HASH in src/styles.ts when this fails)', () => {
    expect(CSS_HASH).toBe(cspHash(CSS));
  });
});

describe('RUM attributes', () => {
  it('escapes attribute values', () => {
    const html = renderLanding({ ...rum, platform: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('data-platform="&quot;&gt;&lt;script&gt;');
  });

  it('knows every platform the contract allows', () => {
    for (const platform of RUM_PLATFORMS)
      expect(renderLanding({ ...rum, platform })).toContain(`data-platform="${platform}"`);
  });
});

describe('public file page', () => {
  const html = renderPublicFile(file, urls, rum);

  it('carries the Open Graph and Twitter tags', () => {
    expect(html).toContain('<meta property="og:title" content="Image 2000 x 1000"/>');
    expect(html).toContain('<meta property="og:type" content="website"/>');
    expect(html).toContain('<meta property="og:image" content="https://hm.test/media/x/1600.webp"/>');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
    expect(html).toContain('<img src="/media/x/1600.webp"');
  });

  it('drops absolute URLs when the origin is not trusted', () => {
    const bare = renderPublicFile(file, { variants: urls.variants }, rum);
    expect(bare).not.toContain('og:image');
    expect(bare).not.toContain('og:url');
    expect(bare).toContain('<meta name="twitter:card" content="summary"/>');
  });

  it.each([
    ['tag break-out', '"><script>alert(1)</script>'],
    ['attribute injection', '" onerror="alert(1)'],
    ['html in text', '<img src=x onerror=alert(1)>'],
    ['entity', '&lt;b&gt;'],
  ])('escapes hostile text: %s', (_name, hostile) => {
    const out = renderPublicFile(
      { ...file, title: hostile, contentType: hostile },
      { ...urls, page: hostile, ogImage: hostile },
      rum,
    );
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('<img src=x');
    expect(out).not.toMatch(/"\s+onerror=/);
    // The only script tag is the RUM one.
    expect(out.match(/<script/g)).toHaveLength(1);
    if (hostile === '&lt;b&gt;') expect(out).toContain('&amp;lt;b&amp;gt;');
  });
});
