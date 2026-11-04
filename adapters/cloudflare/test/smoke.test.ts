import { randomUUID } from 'node:crypto';
import {
  API_CSP,
  createClient,
  DLQ_NAME,
  HTML_SECURITY_HEADERS,
  htmlCsp,
  MAX_ATTEMPTS,
  QUEUE_NAME,
} from '@hostmark/contract';
import { seed } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import type { Miniflare } from 'miniflare';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeJpeg } from './fixtures/jpeg';
import { presignEndpoint } from './fixtures/presign-endpoint';
import { builtWorker, newMiniflare } from './miniflare';

// Needs Postgres, like the core tests: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55532/postgres
const databaseUrl = process.env.DATABASE_URL;

const API_KEY = 'smoke-api-key-0123456789';
const PUBLIC_URL = 'http://hostmark.test';

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
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe.skipIf(!databaseUrl)(
  'api and consumer Workers on Miniflare, Hyperdrive to Postgres, R2, Queues',
  () => {
    let mf: Miniflare;
    let closeShim: () => void;
    let dropDb: () => Promise<void>;
    let client: ReturnType<typeof createClient>;
    let shimOrigin: string;

    beforeAll(async () => {
      const base = new URL(databaseUrl as string);
      const name = `hm_cf_${randomUUID().replaceAll('-', '')}`;
      const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database ${name}`);
      const url = new URL(base);
      url.pathname = `/${name}`;
      await migrate(url.toString());
      const node = createNodeDb(url.toString(), { max: 1 });
      await seed(node.db, { apiKey: API_KEY });
      await node.close();
      dropDb = async () => {
        await admin.unsafe(`drop database if exists ${name} with (force)`);
        await admin.end();
      };

      let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>> | undefined;
      const shim = await presignEndpoint(async () => bucket as NonNullable<typeof bucket>);
      closeShim = () => void shim.server.close();
      shimOrigin = shim.origin;

      const vars = {
        ENVIRONMENT: 'staging',
        PUBLIC_URL,
        BETTER_AUTH_SECRET: 'a-long-random-secret-for-the-smoke-0123456789',
        R2_ACCOUNT_ID: 'test-account',
        R2_BUCKET_NAME: 'hostmark-files',
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_PUBLIC_ENDPOINT: shim.origin,
      };
      mf = newMiniflare([
        builtWorker('api', {
          name: 'api',
          bindings: vars,
          hyperdrives: { HYPERDRIVE: url.toString() },
          r2Buckets: { BUCKET: 'hostmark-files' },
          queueProducers: { QUEUE: QUEUE_NAME },
          // The asset server's answer for the shell; the Worker adds the HTML headers of D310.
          serviceBindings: {
            ASSETS: async (request: Request) =>
              new Response(new URL(request.url).pathname === '/app/' ? '<!doctype html>shell' : 'miss', {
                status: new URL(request.url).pathname === '/app/' ? 200 : 404,
                headers: {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': 'public, max-age=300',
                },
              }),
          },
        }),
        builtWorker('consumer', {
          name: 'consumer',
          bindings: vars,
          hyperdrives: { HYPERDRIVE: url.toString() },
          r2Buckets: { BUCKET: 'hostmark-files' },
          queueProducers: { QUEUE: QUEUE_NAME },
          queueConsumers: {
            [QUEUE_NAME]: {
              maxBatchSize: 1,
              maxBatchTimeout: 1,
              maxRetires: MAX_ATTEMPTS - 1,
              retryDelay: 10,
              deadLetterQueue: DLQ_NAME,
            },
          },
          serviceBindings: { MEDIA: { name: 'api', entrypoint: 'Media' } },
        }),
      ]);
      await mf.ready;
      bucket = await mf.getR2Bucket('BUCKET');
      client = createClient({
        baseUrl: PUBLIC_URL,
        apiKey: API_KEY,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          mf.dispatchFetch(input as string, init as never)) as unknown as typeof fetch,
      });
    });

    afterAll(async () => {
      await mf?.dispose();
      closeShim?.();
      await dropDb?.();
    });

    it('serves the bundled licence texts from the api Worker', async () => {
      const res = await mf.dispatchFetch(`${PUBLIC_URL}/THIRD-PARTY-LICENSES.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      const text = await res.text();
      expect(text).toMatch(/Apache License|BSD 3-Clause|Redistribution and use/);
    });

    it('sends the security headers of D310 on the shell, the API and its own answers', async () => {
      const common = {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      };
      for (const path of ['/app/files/x', '/login', '/signup/', '/app']) {
        const res = await mf.dispatchFetch(`${PUBLIC_URL}${path}`);
        expect(await res.text(), path).toBe('<!doctype html>shell');
        expect(Object.fromEntries(res.headers), path).toMatchObject({
          ...common,
          ...HTML_SECURITY_HEADERS,
          // R2_PUBLIC_ENDPOINT replaces the account origin here, as it does for the presigned URLs.
          'content-security-policy': htmlCsp({
            storageOrigin: new URL(shimOrigin).origin,
            styleHashes: STYLE_HASHES,
          }),
          'cache-control': 'public, max-age=300',
        });
        // PUBLIC_URL is plain http in this test.
        expect(res.headers.get('strict-transport-security'), path).toBeNull();
      }
      const api = await mf.dispatchFetch(`${PUBLIC_URL}/api/health`);
      expect(Object.fromEntries(api.headers)).toMatchObject({
        ...common,
        'content-security-policy': API_CSP,
      });
      const licences = await mf.dispatchFetch(`${PUBLIC_URL}/THIRD-PARTY-LICENSES.txt`);
      await licences.arrayBuffer();
      expect(Object.fromEntries(licences.headers)).toMatchObject(common);
      const missing = await mf.dispatchFetch(`${PUBLIC_URL}/media/${randomUUID()}/128.webp`);
      await missing.arrayBuffer();
      expect(missing.status).toBe(404);
      expect(Object.fromEntries(missing.headers)).toMatchObject(common);
    });

    it('answers the deep health check: Postgres through Hyperdrive and the R2 binding', async () => {
      const health = await client.deepHealth();
      expect(health.status).toBe('ok');
    });

    it('takes an upload from pending to ready: presigned PUT, queue, consumer, wasm decode, variants in R2', async () => {
      const jpeg = await makeJpeg(1400, 1000);
      const created = await client.createUpload({ contentType: 'image/jpeg', bytes: jpeg.length });
      const put = await fetch(created.uploadUrl, {
        method: 'PUT',
        headers: created.uploadHeaders,
        body: jpeg as BodyInit,
      });
      expect(put.status).toBe(200);
      await client.completeUpload(created.fileId);
      const file = await until('the file to be ready', 45_000, async () => {
        const f = await client.getFile(created.fileId);
        if (f.status === 'failed') throw new Error(`file failed: ${f.lastError}`);
        return f.status === 'ready' ? f : undefined;
      });
      expect(file.width).toBe(1400);
      expect(file.height).toBe(1000);
      expect(file.variants.map((v) => v.size).sort((a, b) => a - b)).toEqual([128, 512, 1600]);
    });

    it('fails closed when the cache cannot be purged: workerd has no Workers Caching to purge (D100)', async () => {
      const jpeg = await makeJpeg(640, 480);
      const created = await client.createUpload({ contentType: 'image/jpeg', bytes: jpeg.length });
      await fetch(created.uploadUrl, {
        method: 'PUT',
        headers: created.uploadHeaders,
        body: jpeg as BodyInit,
      });
      await client.completeUpload(created.fileId);
      await until(
        'the file to be ready',
        45_000,
        async () => (await client.getFile(created.fileId)).status === 'ready',
      );
      expect((await client.updateFile(created.fileId, { isPublic: true })).isPublic).toBe(true);
      const publicRes = await mf.dispatchFetch(`${PUBLIC_URL}/media/${created.fileId}/128.webp`);
      expect(publicRes.status).toBe(200);
      // Through the gateway's restamp (D257): one trace id per response, also on what the cache would serve.
      expect(publicRes.headers.get('x-trace-id')).toMatch(/^[0-9a-f]{32}$/);
      expect(publicRes.headers.get('cache-control')).toContain('immutable');
      // The successful purge is not proven here: Miniflare cannot purge. What is proven is that the api does not
      // answer "ok" when the purge did not happen, and that the file is private anyway (a retry is safe).
      await expect(client.updateFile(created.fileId, { isPublic: false })).rejects.toMatchObject({
        status: 503,
      });
      expect((await client.getFile(created.fileId)).isPublic).toBe(false);
      expect((await mf.dispatchFetch(`${PUBLIC_URL}/media/${created.fileId}/128.webp`)).status).toBe(404);
    });

    it('fails an image that is not decodable at once, without retries, because the failure is permanent', async () => {
      // Not an image: the processor rejects it at once, which core treats as a permanent failure (no retries).
      const junk = new TextEncoder().encode('this is not an image'.repeat(10));
      const created = await client.createUpload({ contentType: 'image/jpeg', bytes: junk.length });
      await fetch(created.uploadUrl, {
        method: 'PUT',
        headers: created.uploadHeaders,
        body: junk as BodyInit,
      });
      await client.completeUpload(created.fileId);
      const file = await until('the file to fail', 45_000, async () => {
        const f = await client.getFile(created.fileId);
        return f.status === 'failed' ? f : undefined;
      });
      expect(file.status).toBe('failed');
    });
  },
);
