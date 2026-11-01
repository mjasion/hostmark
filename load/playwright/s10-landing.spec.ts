// S10: the landing page in a browser. Each visit uses a new context, so cache, cookies and storage are empty.
// TTFB comes from Navigation Timing, LCP from the largest-contentful-paint observer, transfer size from the
// navigation and resource entries (encoded bytes over the wire, headers included).
import { expect, test } from '@playwright/test';
import { assertAllowed, type Gate, param, summarise, upper, writeResult } from './result';

const VISITS = param('VISITS', 20, 3);
const TTFB_P95_MS = param('TTFB_P95_MS', 1000, 1000);
const LCP_P95_MS = param('LCP_P95_MS', 2500, 2500);

type Visit = {
  ttfbMs: number;
  lcpMs: number | null;
  transferBytes: number;
  resources: number;
  status: number;
};

test('S10 landing page', async ({ browser, baseURL }) => {
  assertAllowed('S10');
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const visits: Visit[] = [];
  const headers: Record<string, string>[] = [];
  let platform: string | null = null;
  let version: string | null = null;

  for (let i = 0; i < VISITS.value; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number | null };
      w.__lcp = null;
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) w.__lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const res = await page.goto(`${baseURL}/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    // The page must finish its own requests before the numbers are read.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const seen = res?.headers() ?? {};
    // The page itself carries no identity headers on every platform; a health request does.
    if (platform === null) {
      const health = await page.request.get(`${baseURL}/api/health`);
      platform = health.headers()['x-platform'] ?? seen['x-platform'] ?? null;
      version = health.headers()['x-version'] ?? seen['x-version'] ?? null;
    }
    const cache: Record<string, string> = {};
    for (const h of ['cf-cache-status', 'x-vercel-cache', 'x-cache', 'cache-control', 'age']) {
      if (seen[h] !== undefined) cache[h] = seen[h];
    }
    headers.push(cache);
    const measured = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return {
        ttfb: nav.responseStart,
        lcp: (window as unknown as { __lcp: number | null }).__lcp,
        transfer: nav.transferSize + res.reduce((a, r) => a + r.transferSize, 0),
        resources: res.length + 1,
      };
    });
    visits.push({
      ttfbMs: measured.ttfb,
      lcpMs: measured.lcp,
      transferBytes: measured.transfer,
      resources: measured.resources,
      status: res?.status() ?? 0,
    });
    await context.close();
  }

  const ttfb = summarise(visits.map((v) => v.ttfbMs));
  const lcp = summarise(visits.flatMap((v) => (v.lcpMs === null ? [] : [v.lcpMs])));
  const transfer = summarise(visits.map((v) => v.transferBytes));
  const gates: Gate[] = [
    upper('ttfb_ms p(95)', ttfb.p95, TTFB_P95_MS.value),
    upper('lcp_ms p(95)', lcp.p95, LCP_P95_MS.value),
    {
      name: 'visits without an LCP',
      ok: lcp.count === visits.length,
      detail: `${visits.length - lcp.count} visits had none`,
    },
  ];
  writeResult({
    id: 'S10',
    title: 'Landing page in a browser',
    startedAt,
    durationS: (Date.now() - started) / 1000,
    platform,
    version,
    params: { VISITS, TTFB_P95_MS, LCP_P95_MS },
    meaning:
      'Chromium on this machine against 127.0.0.1: no network latency, no CDN, no compression. TTFB is the api rendering a prerendered file from disk, LCP is bounded by it plus paint. Compare variants, not these absolute numbers.',
    gates,
    metrics: {
      ttfb_ms: ttfb,
      lcp_ms: lcp,
      transfer_bytes: transfer,
      resources: summarise(visits.map((v) => v.resources)),
    },
    extra: { visits, cacheHeaders: headers },
  });
  expect(gates.filter((g) => !g.ok).map((g) => g.name)).toEqual([]);
});
