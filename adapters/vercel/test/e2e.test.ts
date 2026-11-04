import { randomUUID } from 'node:crypto';
import { createClient, type JobMessage } from '@hostmark/contract';
import { createJobHandler } from '@hostmark/core';
import { seed } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { makeJpeg } from '@hostmark/node-runtime/testing/fixtures';
import type { PurgeApi } from '@vercel/functions';
import { AwsClient } from 'aws4fetch';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/app';
import { withBuildDefaults } from '../src/build-info';
import { createCronHandler } from '../src/cron';
import { cacheTag, createVercelPurger } from '../src/purge';
import { createMessageProcessor, deadLetterTopic, MAX_DELIVERIES } from '../src/queue';
import { createRuntime, type Runtime } from '../src/runtime';
import { QueueStandIn } from './stand-in';

// Needs the Postgres and S3 stand-ins (README, "Tests"):
//   DATABASE_URL=postgres://hostmark:hostmark@127.0.0.1:55812/hostmark  S3_TEST_ENDPOINT=http://127.0.0.1:59000
// The queue is the model of Vercel Queues (test/stand-in.ts) and the purge API is a fake request context: neither
// has a local stand-in. Everything else is the adapter's own code on the real core.
const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';
const ready = Boolean(databaseUrl && s3Endpoint);

const API_KEY = 'e2e-api-key-0123456789abcdef';
const PUBLIC_URL = 'https://hostmark.example';
const TOPIC = 'image-jobs';
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

describe.skipIf(!ready)('api app and queue consumer on Postgres and MinIO', () => {
  const deleted: string[][] = [];
  const purge: PurgeApi = {
    invalidateByTag: async () => {},
    dangerouslyDeleteByTag: async (tag) => void deleted.push([tag].flat()),
    invalidateBySrcImage: async () => {},
    dangerouslyDeleteBySrcImage: async () => {},
  };
  /** What the Vercel runtime installs per invocation; `withContext(false)` is an invocation without one. */
  const withContext = (on: boolean) => {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    if (on) holder[REQUEST_CONTEXT] = { get: () => ({ purge }) };
    else delete holder[REQUEST_CONTEXT];
  };
  const platform = new QueueStandIn(0.001, MAX_DELIVERIES);
  let runtime: Runtime;
  let app: ReturnType<typeof createApiApp>;
  let client: ReturnType<typeof createClient>;
  let dropAll: () => Promise<void>;

  /** One consumer invocation per due message, as `api/queue.js` runs it. */
  async function consume(): Promise<number> {
    const process = createMessageProcessor({
      handler: createJobHandler(runtime.deps),
      deadLetter: async (body, _r, messageId) =>
        void (await platform.send(deadLetterTopic(TOPIC), body, { idempotencyKey: `dlq-${messageId}` })),
    });
    let n = 0;
    while (
      await platform.deliver(TOPIC, (p, deliveryCount, messageId) => process(p, { messageId, deliveryCount }))
    )
      n++;
    return n;
  }

  async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined | false>) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await consume();
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeAll(async () => {
    const base = new URL(databaseUrl as string);
    const name = `hm_vercel_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${name}`);
    const dbUrl = new URL(base);
    dbUrl.pathname = `/${name}`;
    await migrate(dbUrl.toString());
    const node = createNodeDb(dbUrl.toString(), { max: 1 });
    await seed(node.db, { apiKey: API_KEY });
    await node.close();

    const bucket = `e2e-vercel-${Date.now()}`;
    const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'us-east-1' });
    expect((await s3.fetch(`${s3Endpoint}/${bucket}`, { method: 'PUT' })).status).toBe(200);

    const env = {
      ENVIRONMENT: 'staging',
      PUBLIC_URL,
      DATABASE_URL: dbUrl.toString(),
      BETTER_AUTH_SECRET: 'a-long-random-secret-for-the-e2e-0123456789',
      S3_ENDPOINT: s3Endpoint,
      S3_BUCKET: bucket,
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      CRON_SECRET: 'c'.repeat(32),
    };
    runtime = createRuntime(withBuildDefaults(env, { region: 'frankfurt', version: 'e2e1234' }), {
      service: 'api',
      images: createWasmImageProcessor(nodeLoader),
      queueSdk: platform,
      purger: createVercelPurger(),
    });
    app = createApiApp(() => runtime);
    client = createClient({
      baseUrl: PUBLIC_URL,
      apiKey: API_KEY,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.request(input as string, init)) as typeof fetch,
    });
    dropAll = async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    };
  }, 120_000);

  afterAll(async () => {
    withContext(false);
    await runtime?.close();
    await dropAll?.();
  });

  it('takes an upload to ready, tags /f and /media for the CDN, and purges both on unpublish and delete', async () => {
    withContext(true);
    const jpeg = await makeJpeg(1400, 1000);
    const created = await client.createUpload({ contentType: 'image/jpeg', bytes: jpeg.length });
    const put = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: created.uploadHeaders,
      body: jpeg as BodyInit,
    });
    expect(put.status).toBe(200);
    await client.completeUpload(created.fileId);
    await until('the file to be ready', 60_000, async () => {
      const f = await client.getFile(created.fileId);
      if (f.status === 'failed') throw new Error(`file failed: ${f.lastError}`);
      return f.status === 'ready';
    });
    await client.updateFile(created.fileId, { isPublic: true });
    const tag = cacheTag(created.fileId);

    const page = await app.request(`${PUBLIC_URL}/f/${created.fileId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('vercel-cache-tag')).toBe(tag);
    expect(page.headers.get('vercel-cdn-cache-control')).toBe('max-age=60, stale-while-revalidate=600');
    expect(page.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate=600');
    expect(page.headers.get('x-version')).toBe('e2e1234');
    expect(await page.text()).toContain('data-region="frankfurt"');

    const media = await app.request(`${PUBLIC_URL}/media/${created.fileId}/128.webp`);
    expect(media.status).toBe(200);
    expect(media.headers.get('vercel-cache-tag')).toBe(tag);
    expect(media.headers.get('vercel-cdn-cache-control')).toBe('public, max-age=31536000, immutable');

    // Unpublish in an invocation without a request context: the purge fails loudly, the same PATCH retries it.
    withContext(false);
    await expect(client.updateFile(created.fileId, { isPublic: false })).rejects.toMatchObject({
      status: 503,
    });
    expect(deleted).toEqual([]);
    withContext(true);
    expect((await client.updateFile(created.fileId, { isPublic: false })).isPublic).toBe(false);
    expect(deleted).toEqual([[tag]]);
    const privatePage = await app.request(`${PUBLIC_URL}/f/${created.fileId}`);
    expect(privatePage.status).toBe(404);
    expect(privatePage.headers.get('vercel-cache-tag')).toBeNull();

    // delete_file without a request context is not done: it fails and stays on the queue (D100). The job comes from
    // the cleanup-expired cron run, through the cron route.
    deleted.length = 0;
    withContext(false);
    await client.deleteFile(created.fileId);
    const cron = await createCronHandler(() => runtime)(
      new Request(`${PUBLIC_URL}/api/cron/cleanup-expired`, {
        headers: { authorization: `Bearer ${runtime.vars.CRON_SECRET}` },
      }),
    );
    expect(cron.status).toBe(200);
    await consume();
    const pending = () => platform.pending(TOPIC).filter((m: JobMessage) => m.fileId === created.fileId);
    expect(pending().map((m) => m.type)).toEqual(['delete_file']);
    expect(deleted).toEqual([]);
    withContext(true);
    await until('delete_file to purge', 30_000, async () => pending().length === 0 && deleted.length > 0);
    expect(deleted).toEqual([[tag]]);
    expect(platform.pending(deadLetterTopic(TOPIC))).toEqual([]);
  }, 120_000);

  it('answers 404 for a file that is not public, without CDN headers', async () => {
    withContext(true);
    const res = await app.request(`${PUBLIC_URL}/f/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(res.headers.get('vercel-cache-tag')).toBeNull();
  });
});
