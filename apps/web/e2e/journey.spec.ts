import { deflateSync } from 'node:zlib';
import { expect, type Page, type Request, test } from '@playwright/test';

const PASSWORD = 'e2e-password-1234';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A real, decodable RGB PNG: a gradient, so the worker has something to resize. */
function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      rows[row + 1 + x * 3] = (x * 255) / width;
      rows[row + 2 + x * 3] = (y * 255) / height;
      rows[row + 3 + x * 3] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = { name: 'gradient.png', mimeType: 'image/png', buffer: makePng(900, 600) };
const email = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@users.test`;

/** Collects what must not happen in a clean run. Requests that a test provokes on purpose are listed in `allow`. */
function watch(page: Page, allow: RegExp[] = []) {
  const problems: string[] = [];
  const allowed = (text: string) => allow.some((re) => re.test(text));
  page.on('console', (m) => {
    if (m.type() === 'error' && !allowed(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const text = `${r.method()} ${r.url()} ${r.failure()?.errorText}`;
    // Leaving a page closes its open event stream; the browser reports that as an aborted request.
    if (/\/events net::ERR_ABORTED$/.test(text)) return;
    if (!allowed(text)) problems.push(`requestfailed: ${text}`);
  });
  page.on('response', (r) => {
    const text = `${r.request().method()} ${r.url()} ${r.status()}`;
    if (r.status() >= 400 && !allowed(text)) problems.push(`response: ${text}`);
  });
  return problems;
}

/**
 * The worker needs about a second and the page loads faster than that only sometimes. Answering the first read of
 * the file as `processing` makes the page open the event stream every time; everything after that is the real server.
 */
async function firstReadIsProcessing(page: Page) {
  let first = true;
  await page.route(/\/api\/files\/[0-9a-f-]{36}$/, async (route) => {
    if (!first || route.request().method() !== 'GET') return route.continue();
    first = false;
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, status: 'processing', variants: [] } });
  });
}

/**
 * Playwright cannot read the body of a `sendBeacon` Blob, so the page records the metric name of every beacon in
 * `localStorage` (the original call still goes out unchanged).
 */
const RECORD_BEACONS = () => {
  const parts = new WeakMap<object, unknown>();
  const NativeBlob = window.Blob;
  window.Blob = class extends NativeBlob {
    constructor(p?: BlobPart[], o?: BlobPropertyBag) {
      super(p, o);
      parts.set(this, p?.[0]);
    }
  };
  const send = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    try {
      if (String(url).endsWith('/api/rum')) {
        const names = JSON.parse(localStorage.getItem('rum-names') ?? '[]') as string[];
        names.push((JSON.parse(String(parts.get(data as object))) as { name: string }).name);
        localStorage.setItem('rum-names', JSON.stringify(names));
      }
    } catch {
      // recording is best effort; the beacon below is what the test is about
    }
    return send(url, data);
  };
};

/**
 * Opens `url`, interacts with it, then leaves for real: INP, LCP and CLS are only final when the page is hidden, and
 * a synthetic `visibilitychange` leaves `visibilityState` at `visible`. Checks that the page sent `LCP` and `CLS` and
 * that every beacon Playwright could see got a 2xx; returns the metric names.
 */
async function vitalsAfterLeaving(page: Page, url: string): Promise<string[]> {
  await page.addInitScript(RECORD_BEACONS);
  // /rum.js is a same-origin document that sends nothing; it is where localStorage is read and cleared.
  const readNames = async () => {
    await page.goto('/rum.js');
    return page.evaluate(() => {
      const names = JSON.parse(localStorage.getItem('rum-names') ?? '[]') as string[];
      localStorage.removeItem('rum-names');
      return names;
    });
  };
  await readNames();

  const answers: Promise<number | undefined>[] = [];
  const onRequest = (r: Request) => {
    if (r.url().endsWith('/api/rum') && r.method() === 'POST')
      answers.push(r.response().then((res) => res?.status()));
  };
  page.context().on('request', onRequest);
  await page.goto(url);
  await page.locator('h1, img').first().click();
  await page.goto('about:blank');
  await expect.poll(() => answers.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const names = await readNames();
  expect(names).toEqual(expect.arrayContaining(['LCP', 'CLS']));
  // Playwright reports only some of the beacons that leave with the unloading document (one of three here), so
  // the answers are checked for those it saw; what the page decided to send is the recorded list above.
  page.context().off('request', onRequest);
  for (const status of await Promise.all(answers)) {
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  }
  return names;
}

async function signUp(page: Page, address: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('sign up, upload, watch it become ready, publish, view signed out, unpublish', async ({
  page,
  browser,
  baseURL,
}) => {
  const problems = watch(page);

  await signUp(page, email());
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Hold the PUT back so the progress bar is on screen long enough to be seen.
  await page.route(/127\.0\.0\.1:59000/, async (route) => {
    if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByLabel('Choose files').setInputFiles(image);
  await expect(page.getByLabel(`Upload progress of ${image.name}`)).toBeVisible();
  await expect(page.getByText('Uploaded, processing.')).toBeVisible();

  await firstReadIsProcessing(page);
  const stream = page.waitForResponse(/\/api\/files\/[0-9a-f-]{36}\/events$/);
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/app\/files\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop() as string;
  const events = await stream;
  expect(events.status()).toBe(200);
  expect(events.headers()['content-type']).toContain('text/event-stream');
  await expect(page.getByTestId('status')).toHaveText('Ready');
  const preview = page.getByRole('img', { name: /Preview of file/ });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Back to files' }).first().click();
  const thumb = page.getByRole('img', { name: /Thumbnail of file/ });
  await expect(thumb).toBeVisible();
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('link', { name: /Thumbnail of file/ }).click();
  // A controlled checkbox: it flips when the PATCH answers, so `check()` (which verifies at once) would fail.
  await page.getByLabel('Public').click();
  await expect(page.getByLabel('Public')).toBeChecked();
  await expect(page.getByRole('link', { name: `${baseURL}/f/${id}` })).toBeVisible();

  // A second browser context has no cookie.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto(`/f/${id}`);
  expect(res?.status()).toBe(200);
  await expect(anonPage.getByRole('img').first()).toBeVisible();
  const meta = (p: string) => anonPage.locator(`meta[property="${p}"]`).getAttribute('content');
  expect(await meta('og:title')).toBeTruthy();
  expect(await meta('og:url')).toBe(`${baseURL}/f/${id}`);
  expect(await meta('og:image')).toMatch(new RegExp(`^${baseURL}/media/`));
  expect(
    await anonPage
      .locator('img')
      .first()
      .evaluate((i: HTMLImageElement) => i.naturalWidth),
  ).toBeGreaterThan(0);

  // The public page has the only CSP: its beacons must get through it.
  await vitalsAfterLeaving(anonPage, `/f/${id}`);

  await page.getByLabel('Public').click();
  await expect(page.getByLabel('Public')).not.toBeChecked();
  // The page cache is bounded, but the app marks only 200s cacheable; a fresh request must see the 404.
  await expect.poll(async () => (await anonPage.request.get(`/f/${id}`)).status()).toBe(404);
  await anon.close();

  // A prerendered page, with /rum.js loaded from the same origin.
  await vitalsAfterLeaving(page, '/pricing');

  expect(problems).toEqual([]);
});

test('signed-out /app redirects to /login', async ({ page }) => {
  const problems = watch(page, [/\/api\/auth\/get-session|\/api\/files|\/api\/stats|401/]);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('the reserved seed email cannot sign up and the error is readable', async ({ page }) => {
  const problems = watch(page, [/\/api\/auth\/sign-up\/email/, /status of 4\d\d/]);
  await page.goto('/signup');
  await page.getByLabel('Email').fill('seed@hostmark.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).not.toHaveText(/\[object|undefined|^\s*$/);
  await expect(alert).toHaveText(/already exists|cannot be registered/i);
  await expect(page).toHaveURL(/\/signup$/);
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('falls back to polling when the event stream is blocked', async ({ page }) => {
  const problems = watch(page, [/\/events/, /ERR_FAILED|ERR_BLOCKED/]);
  await signUp(page, email());
  await page.route('**/api/files/*/events', (route) => route.abort());
  await page.getByLabel('Choose files').setInputFiles(image);
  await expect(page.getByText('Uploaded, processing.')).toBeVisible();
  await firstReadIsProcessing(page);
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByText('Checking every 2 seconds')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('status')).toHaveText('Ready');
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});
