// S13: the user flow in the panel: log in, upload, wait for `ready`, open the gallery. Sign-in is driven through the
// form (it is a browser path, not a load path: D80 limits it per address) and each run signs up a new user first,
// outside the timed part. INP is approximated from Event Timing: the worst interaction on the page the flow stays
// on (the panel is a single page app, so one page load covers every click of the flow).
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { assertAllowed, type Gate, param, summarise, upper, writeResult } from './result';

const RUNS = param('RUNS', 10, 2);
const FLOW_P95_MS = param('FLOW_P95_MS', 15000, 15000);
const INP_MAX_MS = param('INP_MAX_MS', 500, 500);
const PASSWORD = 'load-password-1234';
const FIXTURE = join(process.env.LOAD_DIR ?? '/repo/load', 'fixtures', 'jpeg-1mb.jpg');

type Run = {
  ok: boolean;
  error?: string;
  loginMs?: number;
  uploadMs?: number;
  readyMs?: number;
  galleryMs?: number;
  flowMs?: number;
  inpMs?: number | null;
  sse?: { opened: boolean; status?: number; contentType?: string };
  fileReads?: number;
};

async function oneRun(page: Page, n: number): Promise<Run> {
  const email = `load-${Date.now()}-${n}-${Math.floor(Math.random() * 1e6)}@users.test`;
  // Untimed: create the account, then leave, so the timed part starts signed out.
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login|\/$/);

  await page.addInitScript(() => {
    const w = window as unknown as { __inp: number[] };
    w.__inp = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[])
        if (e.interactionId) w.__inp.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
  const sse: NonNullable<Run['sse']> = { opened: false };
  let fileReads = 0;
  page.on('response', (r) => {
    const url = r.url();
    if (/\/api\/files\/[0-9a-f-]{36}\/events$/.test(url)) {
      sse.opened = true;
      sse.status = r.status();
      sse.contentType = r.headers()['content-type'];
    } else if (/\/api\/files\/[0-9a-f-]{36}$/.test(url) && r.request().method() === 'GET') {
      fileReads++;
    }
  });

  const t0 = Date.now();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const t1 = Date.now();

  await page.getByLabel('Choose files').setInputFiles(FIXTURE);
  await expect(page.getByText('Uploaded, processing.')).toBeVisible();
  const t2 = Date.now();

  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/app\/files\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('status')).toHaveText('Ready');
  const t3 = Date.now();

  await page.getByRole('link', { name: 'Back to files' }).first().click();
  const thumb = page.getByRole('img', { name: /Thumbnail of file/ });
  await expect(thumb).toBeVisible();
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const t4 = Date.now();

  const inp = await page.evaluate(() => {
    const list = (window as unknown as { __inp: number[] }).__inp;
    return list.length === 0 ? null : Math.max(...list);
  });
  return {
    ok: true,
    loginMs: t1 - t0,
    uploadMs: t2 - t1,
    readyMs: t3 - t2,
    galleryMs: t4 - t3,
    flowMs: t4 - t0,
    inpMs: inp,
    sse,
    fileReads,
  };
}

test('S13 user flow', async ({ browser }) => {
  assertAllowed('S13');
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runs: Run[] = [];
  let platform: string | null = null;
  let version: string | null = null;

  for (let i = 0; i < RUNS.value; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('response', (r) => {
      if (r.url().includes('/api/') && platform === null) {
        platform = r.headers()['x-platform'] ?? null;
        version = r.headers()['x-version'] ?? null;
      }
    });
    try {
      runs.push(await oneRun(page, i));
    } catch (err) {
      runs.push({ ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
    await context.close();
  }

  const okRuns = runs.filter((r) => r.ok);
  const col = (k: 'loginMs' | 'uploadMs' | 'readyMs' | 'galleryMs' | 'flowMs') =>
    summarise(okRuns.flatMap((r) => (r[k] === undefined ? [] : [r[k] as number])));
  const flow = col('flowMs');
  const inp = summarise(okRuns.flatMap((r) => (typeof r.inpMs === 'number' ? [r.inpMs] : [])));
  const sseRuns = okRuns.filter((r) => r.sse?.opened).length;
  const gates: Gate[] = [
    {
      name: 'failed runs',
      ok: runs.length === okRuns.length,
      detail: `${runs.length - okRuns.length} of ${runs.length}`,
    },
    upper('flow_ms p(95)', flow.p95, FLOW_P95_MS.value),
    upper('inp_ms max', inp.max ?? 0, INP_MAX_MS.value),
  ];
  writeResult({
    id: 'S13',
    title: 'User flow in the panel',
    startedAt,
    durationS: (Date.now() - started) / 1000,
    platform,
    version,
    params: { RUNS, FLOW_P95_MS, INP_MAX_MS },
    meaning:
      'Chromium on this machine against 127.0.0.1 and the local MinIO: no network latency, no CDN. The ready step is dominated by the local worker (one 12 MP JPEG, three WebP variants). INP is the worst Event Timing interaction on the page, not the p98 of a real session.',
    gates,
    metrics: {
      login_ms: col('loginMs'),
      upload_ms: col('uploadMs'),
      ready_ms: col('readyMs'),
      gallery_ms: col('galleryMs'),
      flow_ms: flow,
      inp_ms: inp,
      runs_with_event_stream: sseRuns,
      runs_with_polling_only: okRuns.length - sseRuns,
    },
    extra: { runs },
  });
  expect(gates.filter((g) => !g.ok).map((g) => g.name)).toEqual([]);
});
