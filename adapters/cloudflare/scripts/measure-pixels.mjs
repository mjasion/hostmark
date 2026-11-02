// Measures what the image processor costs in memory inside workerd, to set WORKERS_MAX_PIXELS (src/limits.ts, D103).
// Runs on Linux, because it reads /proc: the macOS sandbox does not allow `ps`. Steps (see the README):
//   node --import tsx scripts/measure-pixels-fixtures.ts .build/measure/jpegs     (host, writes the test images)
//   mkdir -p .build/measure/bundle && cp .build/test/image-service/* .build/measure/bundle/  (after `pnpm test`)
//   cp scripts/measure-pixels.mjs .build/measure/driver.mjs
//   (cd .build/measure && npm i miniflare@4.20260730.0)      (once, installs into the gitignored directory)
//   cd .build/measure && docker run --rm -v "$PWD":/m -w /m node:22.23.4-slim sh -c 'node driver.mjs'
// The driver is copied into the mounted directory because a single file cannot be mounted inside another mount.
//
// workerd outside Cloudflare does not enforce the 128 MB isolate limit of production, so this cannot say "this image
// crashes". It measures the peak resident memory of the workerd process while one image goes through a fresh Worker
// (after the codecs were loaded by a tiny image), and the result is used to compute the largest image that fits.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';

const LIMIT_MB = 128;
const bundle = join(process.cwd(), 'bundle');
const jpegs = join(process.cwd(), 'jpegs');

const workerdPids = () =>
  readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        return ppid === process.pid && /workerd/.test(readFileSync(`/proc/${p}/cmdline`, 'utf8'));
      } catch {
        return false;
      }
    });
const rssMb = () => {
  let kb = 0;
  for (const pid of workerdPids()) {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    if (m) kb += Number(m[1]);
  }
  return kb / 1024;
};

const modules = readdirSync(bundle)
  .filter((f) => /\.(js|wasm)$/.test(f))
  .sort((a, b) => (a === 'image-service.js' ? -1 : b === 'image-service.js' ? 1 : a.localeCompare(b)))
  .map((f) => ({ type: f.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule', path: join(bundle, f) }));

const sizes = readdirSync(jpegs)
  .map((f) => Number(f.replace(/\.jpg$/, '')))
  .sort((a, b) => a - b);
const warm = readFileSync(join(jpegs, `${sizes[0]}.jpg`));

const post = async (mf, body) => {
  const res = await mf.dispatchFetch('http://image/process?sizes=128,512,1600&maxPixels=500000000', {
    method: 'POST',
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 200));
  return json;
};

const rows = [];
const mb = (bytes) => bytes / 1024 / 1024;
for (const mp of sizes.slice(1)) {
  const mf = new Miniflare({
    modules,
    modulesRoot: bundle,
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
  });
  await mf.ready;
  await post(mf, warm);
  await new Promise((r) => setTimeout(r, 500));
  const base = rssMb();
  let peak = base;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rssMb());
  }, 10);
  const started = Date.now();
  let ok = true;
  let note = '';
  let wasm = [];
  try {
    const out = await post(mf, readFileSync(join(jpegs, `${mp}.jpg`)));
    wasm = out.wasmMemoryBytes.map(mb);
    note = `${out.width}x${out.height}`;
  } catch (e) {
    ok = false;
    note = String(e).slice(0, 160);
  }
  const ms = Date.now() - started;
  clearInterval(sampler);
  await new Promise((r) => setTimeout(r, 300));
  const after = rssMb();
  rows.push({ mp, ok, base, peak, after, wasm, wasmTotal: wasm.reduce((a, b) => a + b, 0) });
  console.log(
    `${mp} MP: ${ok ? 'ok' : 'FAILED'} ${ms} ms, rss warm ${base.toFixed(0)} MB, peak ${peak.toFixed(0)} MB (+${(peak - base).toFixed(0)}), after ${after.toFixed(0)} MB; wasm memories ${wasm.map((m) => m.toFixed(0)).join('+')} = ${wasm.reduce((a, b) => a + b, 0).toFixed(0)} MB ${note}`,
  );
  await mf.dispose();
}

// Wasm memory is exact and is kept for the life of the isolate; the JavaScript buffers are counted from the code.
// Least squares line through (megapixels, added MB), on the peak resident memory (an upper bound: it includes garbage
// the collector has not freed) and on the wasm memory alone.
const good = rows.filter((r) => r.ok);
const n = good.length;
if (n >= 2) {
  const sx = good.reduce((s, r) => s + r.mp, 0);
  const sy = good.reduce((s, r) => s + (r.peak - r.base), 0);
  const sxy = good.reduce((s, r) => s + r.mp * (r.peak - r.base), 0);
  const sxx = good.reduce((s, r) => s + r.mp * r.mp, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const warmMb = Math.max(...good.map((r) => r.base));
  console.log(
    `\nadded memory = ${intercept.toFixed(1)} MB + ${slope.toFixed(2)} MB per megapixel (${((slope * 1024 * 1024) / 1e6).toFixed(1)} bytes per pixel)`,
  );
  console.log(`warm isolate (codecs loaded, no image): rss ${warmMb.toFixed(0)} MB`);
  console.log(
    `megapixels that fit in ${LIMIT_MB} MB if the whole workerd process were the isolate: ${((LIMIT_MB - warmMb - intercept) / slope).toFixed(1)}`,
  );
  console.log(
    `megapixels that fit in ${LIMIT_MB} MB counting only the added memory: ${((LIMIT_MB - intercept) / slope).toFixed(1)}`,
  );
}

const wasmGood = good.filter((r) => r.wasmTotal > 0);
if (wasmGood.length >= 2) {
  const k = wasmGood.length;
  const sx = wasmGood.reduce((s, r) => s + r.mp, 0);
  const sy = wasmGood.reduce((s, r) => s + r.wasmTotal, 0);
  const sxy = wasmGood.reduce((s, r) => s + r.mp * r.wasmTotal, 0);
  const sxx = wasmGood.reduce((s, r) => s + r.mp * r.mp, 0);
  const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
  const intercept = (sy - slope * sx) / k;
  console.log(
    `\nwasm memory = ${intercept.toFixed(1)} MB + ${slope.toFixed(2)} MB per megapixel (${((slope * 1024 * 1024) / 1e6).toFixed(1)} bytes per pixel)`,
  );
}
