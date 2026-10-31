// End to end check of the running compose stack, through the public API only (plus docker, Postgres, Redis and
// Grafana for the things the API cannot show). Run: `pnpm smoke` from adapters/local after `docker compose up`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ApiError,
  type Chaos,
  createClient,
  DLQ_NAME,
  type FileResponse,
  originalKey,
  type SCHEDULER_JOBS,
  VARIANT_SIZES,
  variantKey,
} from '@hostmark/contract';
import { nodeLoader } from '@hostmark/image/node';
import { createS3Storage } from '@hostmark/storage-s3';
import webpDecode, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { makeJpeg } from '../test/fixtures';

const stackDir = fileURLToPath(new URL('..', import.meta.url));

function readDotEnv(): Record<string, string> {
  try {
    const lines = readFileSync(`${stackDir}.env`, 'utf8').split('\n');
    return Object.fromEntries(
      lines
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}
const dotenv = readDotEnv();
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? dotenv[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return value;
};

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:58080';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://127.0.0.1:53000';
const SMOKE_BACKOFF_SCALE = '0.02';
// The real retry schedule takes 400 s plus processing time; the step that runs it needs SMOKE_LONG=1.
const RUN_LONG = process.env.SMOKE_LONG === '1';
const BACKOFF_SECONDS = [10, 30, 90, 270];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compose(args: string[], extraEnv: Record<string, string> = {}): string {
  const res = spawnSync('docker', ['compose', ...args], {
    cwd: stackDir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0)
    throw new Error(`docker compose ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout + res.stderr;
}

// Ctrl-C in the middle of the chaos steps must not leave the worker with the test's short backoff.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    try {
      compose(['up', '-d', '--no-deps', 'worker']);
    } finally {
      process.exit(130);
    }
  });
}

// The client hides response headers, so keep the trace id of every answer by request path.
const traceIds = new Map<string, string>();
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const trace = res.headers.get('x-trace-id');
  if (trace) traceIds.set(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`, trace);
  return res;
};
const user = createClient({ baseUrl: API_URL, apiKey: env('SEED_API_KEY'), fetch: recordingFetch });
const admin = createClient({ baseUrl: API_URL, apiKey: env('SEED_ADMIN_API_KEY'), fetch: recordingFetch });
type Client = typeof user;

const sql = postgres(
  `postgres://${env('POSTGRES_USER')}:${env('POSTGRES_PASSWORD')}@127.0.0.1:55432/${env('POSTGRES_DB')}`,
  { max: 2, onnotice: () => {} },
);
const dlq = new Queue(DLQ_NAME, { connection: { host: '127.0.0.1', port: 56379 } });
const storage = createS3Storage({
  endpoint: 'http://127.0.0.1:59000',
  bucket: env('S3_BUCKET'),
  region: 'us-east-1',
  accessKeyId: env('MINIO_ROOT_USER'),
  secretAccessKey: env('MINIO_ROOT_PASSWORD'),
});

async function put(url: string, headers: Record<string, string>, body: Uint8Array): Promise<number> {
  const res = await fetch(url, { method: 'PUT', headers, body: body as BodyInit });
  return res.status;
}

/** Creates an upload and sends the bytes. Stops before `complete`. */
async function upload(client: Client, bytes: Uint8Array, contentType = 'image/jpeg') {
  const created = await client.createUpload({
    contentType: contentType as 'image/jpeg',
    bytes: bytes.length,
  });
  const status = await put(created.uploadUrl, created.uploadHeaders, bytes);
  if (status !== 200) throw new Error(`PUT to presigned URL answered ${status}`);
  return created.fileId;
}

async function waitFor(
  client: Client,
  id: string,
  done: (f: FileResponse) => boolean,
  timeoutMs: number,
): Promise<FileResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await client.getFile(id);
    if (done(file)) return file;
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutMs} ms, file is ${file.status}`);
    await sleep(500);
  }
}

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1000);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function dlqEntries(fileId: string) {
  const jobs = await dlq.getJobs(['waiting', 'delayed', 'completed', 'failed'], 0, -1);
  return jobs.filter((j) => j.data?.fileId === fileId);
}
const dlqHas = async (fileId: string): Promise<boolean> => (await dlqEntries(fileId)).length > 0;

const workerContainer = () => compose(['ps', '-a', '-q', 'worker']).trim();
const restartCount = (): number =>
  Number(
    spawnSync('docker', ['inspect', '-f', '{{.RestartCount}}', workerContainer()], {
      encoding: 'utf8',
    }).stdout.trim(),
  );

/** Seconds between the `will be retried` log lines of a file, from the worker's JSON logs. */
function retryGaps(fileId: string): number[] {
  const times = compose(['logs', '--no-log-prefix', 'worker'])
    .split('\n')
    .filter((l) => l.includes(fileId) && l.includes('will be retried'))
    .map((l) => Date.parse((JSON.parse(l) as { time: string }).time))
    .sort((a, b) => a - b);
  return times.slice(1).map((t, i) => (t - (times[i] as number)) / 1000);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
async function step(name: string, fn: () => Promise<string | undefined>): Promise<void> {
  console.log(`\n[${results.length + 1}] ${name}`);
  const started = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail });
    console.log(`  PASS (${((Date.now() - started) / 1000).toFixed(1)} s) ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL (${((Date.now() - started) / 1000).toFixed(1)} s) ${detail}`);
  }
}

// State shared between steps
let readyFileId = '';
let completeTraceId = '';
const userId = 'seed-user';

await step('stack is healthy', async () => {
  const health = await user.deepHealth();
  assert(health.status === 'ok', `deep health is ${JSON.stringify(health)}`);
  return JSON.stringify(Object.fromEntries(Object.entries(health.checks).map(([k, v]) => [k, v.status])));
});

await step('JPEG with EXIF reaches ready in under 60 s with three WebP variants', async () => {
  // 3000x2000 tagged orientation 6: upright it is 2000x3000.
  const jpeg = await makeJpeg(3000, 2000, 6);
  const started = Date.now();
  const id = await upload(user, jpeg);
  const completed = await user.completeUpload(id);
  assert(completed.status === 'queued', `status after complete is ${completed.status}`);
  completeTraceId = traceIds.get(`POST /api/uploads/${id}/complete`) ?? '';
  const file = await waitFor(user, id, (f) => f.status === 'ready' || f.status === 'failed', 60_000);
  const elapsed = Date.now() - started;
  assert(file.status === 'ready', `file ended as ${file.status}: ${file.lastError}`);
  assert(
    file.width === 2000 && file.height === 3000,
    `dimensions are ${file.width}x${file.height}, want 2000x3000`,
  );
  assert(file.variants.length === VARIANT_SIZES.length, `${file.variants.length} variants`);
  await initWebpDecoder(await nodeLoader.webpDecoder());
  const dims: string[] = [];
  for (const variant of file.variants) {
    const res = await fetch(variant.url);
    assert(res.ok, `variant ${variant.size} answered ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const decoded = await webpDecode(body as unknown as ArrayBuffer);
    assert(
      decoded.height > decoded.width,
      `variant ${variant.size} is not upright (${decoded.width}x${decoded.height})`,
    );
    // makeJpeg paints red along x and green along y. Orientation 6 turns the image a quarter clockwise, so the
    // upright corners are: top left green, top right black, bottom right red, bottom left yellow.
    const at = (fx: number, fy: number) => {
      const i = (Math.floor(fy * decoded.height) * decoded.width + Math.floor(fx * decoded.width)) * 4;
      return [decoded.data[i] ?? 0, decoded.data[i + 1] ?? 0] as const;
    };
    const near = (got: readonly number[], want: readonly number[]) =>
      got.every((c, k) => Math.abs(c - (want[k] ?? 0)) < 45);
    const corners = {
      topLeft: at(0.06, 0.06),
      topRight: at(0.94, 0.06),
      bottomRight: at(0.94, 0.94),
      bottomLeft: at(0.06, 0.94),
    };
    assert(
      near(corners.topLeft, [15, 240]) &&
        near(corners.topRight, [15, 15]) &&
        near(corners.bottomRight, [240, 15]) &&
        near(corners.bottomLeft, [240, 240]),
      `variant ${variant.size} has the wrong orientation, corner (red, green) values ${JSON.stringify(corners)}`,
    );
    assert(
      Math.max(decoded.width, decoded.height) === variant.size,
      `variant ${variant.size} is ${decoded.width}x${decoded.height}`,
    );
    assert(
      !new TextDecoder('latin1').decode(body).includes('EXIF'),
      `variant ${variant.size} still carries EXIF`,
    );
    dims.push(`${variant.size}:${decoded.width}x${decoded.height}`);
  }
  readyFileId = id;
  return `upload to ready ${elapsed} ms (queued_at to ready_at ${Date.parse(file.readyAt ?? '') - Date.parse(file.queuedAt ?? '')} ms); variants ${dims.join(' ')}`;
});

await step('chaos=fail: five attempts, status failed, message in the DLQ', async () => {
  // The real backoff schedule takes 400 s; scale it down for this run and restore it afterwards.
  compose(['up', '-d', '--force-recreate', '--no-deps', 'worker'], {
    QUEUE_BACKOFF_SCALE: SMOKE_BACKOFF_SCALE,
  });
  await sleep(3000);
  try {
    const id = await upload(admin, await makeJpeg(400, 300));
    await admin.completeUpload(id, { chaos: 'fail' as Chaos });
    const file = await waitFor(admin, id, (f) => f.status === 'failed' || f.status === 'ready', 90_000);
    assert(file.status === 'failed', `file ended as ${file.status}`);
    assert(file.attempts === 5, `attempts is ${file.attempts}, want 5`);
    assert(file.lastError?.includes('chaos=fail'), `last_error is ${file.lastError}`);
    await until('message in DLQ', 15_000, () => dlqHas(id));
    const logs = compose(['logs', '--no-log-prefix', 'worker']);
    const retried = logs.split('\n').filter((l) => l.includes(id) && l.includes('will be retried')).length;
    assert(retried === 4, `${retried} retry log lines, want 4`);
    const gaps = retryGaps(id);
    BACKOFF_SECONDS.slice(0, 3).forEach((seconds, i) => {
      const want = seconds * Number(SMOKE_BACKOFF_SCALE);
      const got = gaps[i] ?? 0;
      assert(
        got >= want * 0.8 && got < want + 6,
        `retry gap ${i + 1} is ${got.toFixed(1)} s, want about ${want.toFixed(1)} s`,
      );
    });
    const entries = await dlqEntries(id);
    assert(entries.length === 1, `${entries.length} DLQ entries for the file, want 1`);
    const body = entries[0]?.data;
    assert(
      body?.type === 'process_image' && body.fileId === id && body.chaos === 'fail' && body.v === 1,
      `unexpected DLQ payload ${JSON.stringify(body)}`,
    );
    return `attempts ${file.attempts}, ${retried} retries, gaps ${gaps.map((g) => g.toFixed(1)).join('/')} s, one DLQ entry with the original message`;
  } finally {
    compose(['up', '-d', '--force-recreate', '--no-deps', 'worker']);
  }
});

await step('chaos=crash: worker exits, Docker restarts it, file ends up ready', async () => {
  const restartsBefore = restartCount();
  const started = Date.now();
  const id = await upload(admin, await makeJpeg(800, 600));
  await admin.completeUpload(id, { chaos: 'crash' as Chaos });
  const crashedAfter = await until('worker restart', 60_000, async () => {
    return restartCount() > restartsBefore ? Date.now() - started : undefined;
  });
  const file = await waitFor(admin, id, (f) => f.status === 'ready' || f.status === 'failed', 240_000);
  assert(file.status === 'ready', `file ended as ${file.status}: ${file.lastError}`);
  assert(file.attempts === 2, `attempts is ${file.attempts}, want 2 (one before the crash, one after)`);
  // D65: lock (60 s) plus stalled check (up to 30 s). Faster means the lock did not do its job.
  const recoveredAfter = Date.now() - started;
  assert(
    recoveredAfter > 55_000 && recoveredAfter < 150_000,
    `recovery took ${recoveredAfter} ms, want 55 to 150 s`,
  );
  return `worker restarted after ${crashedAfter} ms, file ready after ${Date.now() - started} ms (lock expiry + stalled check), attempts ${file.attempts}`;
});

await step('double stall: a job whose worker dies twice is still processed (B2)', async () => {
  // chaos=slow keeps the job busy for 45 s, long enough to kill the worker in the middle of each attempt.
  const id = await upload(admin, await makeJpeg(640, 480));
  await admin.completeUpload(id, { chaos: 'slow' as Chaos });
  const kill = async (attempt: number) => {
    await until(`attempt ${attempt} in progress`, 150_000, async () => {
      const f = await admin.getFile(id);
      return f.status === 'processing' && f.attempts === attempt ? f : undefined;
    });
    await sleep(2000);
    const killed = spawnSync('docker', ['kill', workerContainer()], { encoding: 'utf8' });
    assert(killed.status === 0, `docker kill failed: ${killed.stderr}`);
    // Docker does not apply the restart policy to a container that was killed by hand.
    const started = spawnSync('docker', ['start', workerContainer()], { encoding: 'utf8' });
    assert(started.status === 0, `docker start failed: ${started.stderr}`);
  };
  const startedAt = Date.now();
  await kill(1);
  await kill(2);
  const file = await waitFor(admin, id, (f) => f.status === 'ready' || f.status === 'failed', 240_000);
  assert(file.status === 'ready', `file ended as ${file.status}: ${file.lastError}`);
  assert(file.attempts === 3, `attempts is ${file.attempts}, want 3`);
  assert(!(await dlqHas(id)), 'a processed file was dead-lettered');
  return `two kills, ready after ${Date.now() - startedAt} ms with attempts ${file.attempts}`;
});

await step('invalid image bytes: failed immediately, one attempt, nothing dead-lettered', async () => {
  const id = await upload(user, new TextEncoder().encode('this is not an image'), 'image/png');
  await user.completeUpload(id);
  const file = await waitFor(user, id, (f) => f.status === 'failed' || f.status === 'ready', 30_000);
  assert(file.status === 'failed', `file ended as ${file.status}`);
  assert(file.attempts === 1, `attempts is ${file.attempts}, want 1`);
  // A dead letter copy is written right after the final failure; give it time to show up before saying "none".
  for (let i = 0; i < 5; i++) {
    assert(!(await dlqHas(id)), 'the invalid file was dead-lettered');
    await sleep(1000);
  }
  return `attempts ${file.attempts}, last_error "${file.lastError}"`;
});

await step('non-admin sending x-chaos gets 403', async () => {
  const id = await upload(user, await makeJpeg(200, 100));
  try {
    await user.completeUpload(id, { chaos: 'fail' as Chaos });
  } catch (err) {
    assert(err instanceof ApiError && err.status === 403, `unexpected error ${err}`);
    const file = await user.getFile(id);
    assert(file.status === 'pending_upload', `file moved to ${file.status}`);
    return 'HTTP 403, file stays pending_upload';
  }
  throw new Error('request succeeded');
});

await step('public file: /media serves immutable headers, 404 after unpublishing', async () => {
  const media = `${API_URL}/media/${readyFileId}/512.webp`;
  assert((await fetch(media)).status === 404, 'private file is visible');
  await user.updateFile(readyFileId, { isPublic: true });
  const res = await fetch(media);
  assert(res.status === 200, `public file answered ${res.status}`);
  const cache = res.headers.get('cache-control') ?? '';
  assert(
    /public/.test(cache) && /max-age=31536000/.test(cache) && /immutable/.test(cache),
    `cache-control is "${cache}"`,
  );
  assert(
    res.headers.get('content-type') === 'image/webp',
    `content-type is ${res.headers.get('content-type')}`,
  );
  await res.arrayBuffer();
  await user.updateFile(readyFileId, { isPublic: false });
  const after = await fetch(media);
  assert(after.status === 404, `unpublished file answered ${after.status}`);
  return `200 with "${cache}", then 404`;
});

await step('trace: complete request and worker run are connected', async () => {
  assert(completeTraceId, 'no trace id captured from complete');
  const tempo = async (path: string) => {
    const res = await fetch(`${GRAFANA_URL}/api/datasources/proxy/uid/tempo${path}`, {
      headers: {
        authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}`,
        accept: 'application/json',
      },
    });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as unknown) : null };
  };
  interface Span {
    traceId: string;
    spanId: string;
    name: string;
    links?: { traceId: string; spanId: string }[];
  }
  const spansOf = (body: unknown): Span[] => {
    const doc = body as { trace?: unknown; batches?: unknown[]; resourceSpans?: unknown[] };
    const batches = (doc.batches ??
      doc.resourceSpans ??
      (doc.trace as { resourceSpans?: unknown[] })?.resourceSpans ??
      []) as {
      scopeSpans?: { spans?: Span[] }[];
      instrumentationLibrarySpans?: { spans?: Span[] }[];
    }[];
    return batches.flatMap((b) =>
      (b.scopeSpans ?? b.instrumentationLibrarySpans ?? []).flatMap((s) => s.spans ?? []),
    );
  };
  const producer = await until('producer trace in Tempo', 90_000, async () => {
    const r = await tempo(`/api/traces/${completeTraceId}`);
    return r.status === 200 ? spansOf(r.body) : undefined;
  });
  // Tempo returns ids as base64 or hex depending on the endpoint; compare in hex.
  const hex = (id: string) =>
    /^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : Buffer.from(id, 'base64').toString('hex');
  const producerSpanIds = new Set(producer.map((s) => hex(s.spanId)));
  const names = [...new Set(producer.map((s) => s.name))];
  const query = encodeURIComponent(`{ span.file.id = "${readyFileId}" && name = "process_image" }`);
  const worker = await until('worker trace in Tempo', 90_000, async () => {
    const found = (await tempo(`/api/search?q=${query}&limit=5`)).body as {
      traces?: { traceID: string }[];
    } | null;
    const traceId = found?.traces?.[0]?.traceID;
    if (!traceId) return undefined;
    const r = await tempo(`/api/traces/${traceId}`);
    return r.status === 200 ? { traceId, spans: spansOf(r.body) } : undefined;
  });
  const root = worker.spans.find((s) => s.name === 'process_image');
  assert(root, 'no process_image span in worker trace');
  const link = (root.links ?? []).find(
    (l) => hex(l.traceId) === completeTraceId && producerSpanIds.has(hex(l.spanId)),
  );
  assert(
    link,
    `process_image span has no link to trace ${completeTraceId} (links: ${JSON.stringify(root.links)})`,
  );
  const sameTrace = worker.traceId === completeTraceId;
  const steps = worker.spans.map((s) => s.name).filter((n) => n.startsWith('process_image.'));
  return `producer trace ${completeTraceId} (${names.join(', ')}); worker trace ${worker.traceId} ${sameTrace ? 'is the same trace' : 'is a separate trace'} whose process_image span links to the producer span; worker steps: ${steps.join(', ')}`;
});

await step('scheduler: requeue-stuck, cleanup-expired and daily-stats act on old rows', async () => {
  const runJob = (job: keyof typeof SCHEDULER_JOBS) => {
    const out = compose(['exec', '-T', 'scheduler', 'node', 'dist/run-job.js', job]);
    const line = out.split('\n').find((l) => l.includes('scheduler job finished')) ?? '';
    if (!line) return {};
    const { level, msg, traceId, spanId, time, service, job: _job, durationMs, ...counts } = JSON.parse(line);
    return counts as Record<string, number>;
  };
  const notes: string[] = [];

  // requeue-stuck: a queued row whose message was lost, and one that already used all its attempts.
  const lost = await upload(user, await makeJpeg(640, 480));
  const exhausted = await upload(user, await makeJpeg(640, 480));
  await sql`update files set status = 'queued', queued_at = now(), last_activity_at = now() - interval '20 minutes' where id = ${lost}`;
  await sql`update files set status = 'processing', queued_at = now(), attempts = 5, last_activity_at = now() - interval '20 minutes' where id = ${exhausted}`;
  const stuck = runJob('requeue-stuck');
  assert(stuck.requeued === 1 && stuck.failed === 1, `requeue-stuck result ${JSON.stringify(stuck)}`);
  const recovered = await waitFor(user, lost, (f) => f.status === 'ready' || f.status === 'failed', 60_000);
  assert(recovered.status === 'ready', `requeued file ended as ${recovered.status}: ${recovered.lastError}`);
  assert((await user.getFile(exhausted)).status === 'failed', 'exhausted file is not failed');
  notes.push(`requeue-stuck ${JSON.stringify(stuck)}: lost message processed to ready, exhausted row failed`);

  // cleanup-expired: an expired ready file and an abandoned pending upload.
  const expired = await upload(user, await makeJpeg(640, 480));
  await user.completeUpload(expired);
  await waitFor(user, expired, (f) => f.status === 'ready', 60_000);
  const abandoned = (await user.createUpload({ contentType: 'image/jpeg', bytes: 1000 })).fileId;
  await sql`update files set expires_at = now() - interval '1 minute' where id = ${expired}`;
  await sql`update files set created_at = now() - interval '2 hours' where id = ${abandoned}`;
  const cleaned = runJob('cleanup-expired');
  assert((cleaned.marked ?? 0) >= 2, `cleanup-expired result ${JSON.stringify(cleaned)}`);
  await until('purge by the worker', 30_000, async () => {
    const [row] = await sql`select purged_at from files where id = ${expired}`;
    return row?.purged_at ? row : undefined;
  });
  assert((await storage.head(originalKey(userId, expired))) === null, 'original object still exists');
  for (const size of VARIANT_SIZES) {
    assert((await storage.head(variantKey(userId, expired, size))) === null, `variant ${size} still exists`);
  }
  const [gone] = await sql`select status from files where id = ${abandoned}`;
  assert(gone?.status === 'deleted', `abandoned upload is ${gone?.status}`);
  notes.push(
    `cleanup-expired ${JSON.stringify(cleaned)}: expired file purged (row and objects), abandoned upload deleted`,
  );

  // daily-stats: backdate a file into yesterday and recompute.
  await sql`update files set created_at = now() - interval '1 day' where id = ${lost}`;
  const stats = runJob('daily-stats');
  const [row] =
    await sql`select uploads, ready from daily_stats where platform = 'local-portable' order by day desc limit 1`;
  assert(row && Number(row.uploads) >= 1, `daily_stats row is ${JSON.stringify(row)}`);
  notes.push(`daily-stats ${JSON.stringify(stats)}: row uploads=${row.uploads} ready=${row.ready}`);
  return notes.join('; ');
});

if (RUN_LONG) {
  await step('chaos=fail on the real backoff schedule (10, 30, 90, 270 s), SMOKE_LONG=1', async () => {
    const id = await upload(admin, await makeJpeg(400, 300));
    const started = Date.now();
    await admin.completeUpload(id, { chaos: 'fail' as Chaos });
    const file = await waitFor(admin, id, (f) => f.status === 'failed' || f.status === 'ready', 600_000);
    const total = (Date.now() - started) / 1000;
    assert(
      file.status === 'failed' && file.attempts === 5,
      `file ended as ${file.status} after ${file.attempts} attempts`,
    );
    assert(total > 400 && total < 430, `took ${total.toFixed(0)} s, want a little over 400 s`);
    const gaps = retryGaps(id);
    BACKOFF_SECONDS.slice(0, 3).forEach((seconds, i) => {
      const got = gaps[i] ?? 0;
      assert(
        got >= seconds * 0.95 && got < seconds + 6,
        `retry gap ${i + 1} is ${got.toFixed(1)} s, want ${seconds} s`,
      );
    });
    await until('message in DLQ', 15_000, () => dlqHas(id));
    return `five attempts in ${total.toFixed(0)} s, gaps ${gaps.map((g) => g.toFixed(1)).join('/')} s, one DLQ entry`;
  });
}

// Whatever a step left behind: the worker runs with the default backoff again.
compose(['up', '-d', '--no-deps', 'worker']);
await sql.end();
await dlq.close();

console.log('\nSummary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed === 0 ? 0 : 1);
