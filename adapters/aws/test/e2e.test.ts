import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createClient, MAX_ATTEMPTS } from '@hostmark/contract';
import { createJobHandler } from '@hostmark/core';
import { seed } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { makeJpeg } from '@hostmark/node-runtime/testing/fixtures';
import { AwsClient } from 'aws4fetch';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/app';
import { handleSqsEvent } from '../src/queue';
import { createRuntime, type Runtime } from '../src/runtime';
import { startEventSourceMapping } from './esm';

// Needs all three stand-ins (README, "Tests"):
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55812/postgres
//   S3_TEST_ENDPOINT=http://127.0.0.1:55810  SQS_TEST_ENDPOINT=http://127.0.0.1:55811
const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_TEST_ENDPOINT;
const sqsEndpoint = process.env.SQS_TEST_ENDPOINT;
const ready = Boolean(databaseUrl && s3Endpoint && sqsEndpoint);

const API_KEY = 'e2e-api-key-0123456789abcdef';
const PUBLIC_URL = 'https://hostmark.example';
const ORIGIN_SECRET = 'e'.repeat(40);

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

describe.skipIf(!ready)('api app and worker on Postgres, MinIO and ElasticMQ', () => {
  const purged: string[][] = [];
  let api: Runtime;
  let worker: Runtime;
  let dropAll: () => Promise<void>;
  let stopMapping: () => Promise<void>;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const base = new URL(databaseUrl as string);
    const name = `hm_aws_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${name}`);
    const dbUrl = new URL(base);
    dbUrl.pathname = `/${name}`;
    await migrate(dbUrl.toString());
    const node = createNodeDb(dbUrl.toString(), { max: 1 });
    await seed(node.db, { apiKey: API_KEY });
    await node.close();

    const bucket = `e2e-${Date.now()}`;
    const s3 = new AwsClient({
      accessKeyId: 'hostmark',
      secretAccessKey: 'hostmark-aws-secret',
      service: 's3',
      region: 'us-east-1',
    });
    expect((await s3.fetch(`${s3Endpoint}/${bucket}`, { method: 'PUT' })).status).toBe(200);

    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: sqsEndpoint,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    });
    const suffix = randomUUID().slice(0, 8);
    const dlq = (await sqs.send(new CreateQueueCommand({ QueueName: `e2e-dlq-${suffix}` })))
      .QueueUrl as string;
    const dlqArn = (
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn;
    const queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `e2e-${suffix}`,
          Attributes: {
            VisibilityTimeout: '10',
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_ATTEMPTS }),
          },
        }),
      )
    ).QueueUrl as string;

    const env = {
      ENVIRONMENT: 'staging',
      PUBLIC_URL,
      DATABASE_URL: dbUrl.toString(),
      BETTER_AUTH_SECRET: 'a-long-random-secret-for-the-e2e-0123456789',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'hostmark',
      AWS_SECRET_ACCESS_KEY: 'hostmark-aws-secret',
      S3_BUCKET: bucket,
      S3_ENDPOINT: s3Endpoint,
      SQS_QUEUE_URL: queueUrl,
      SQS_ENDPOINT: sqsEndpoint,
      CLOUDFRONT_DISTRIBUTION_ID: 'E2ETEST',
      ORIGIN_SECRET,
      QUEUE_BACKOFF_SCALE: '0.1',
    };
    const processor = createWasmImageProcessor(nodeLoader);
    const purger = { purge: async (paths: string[]) => void purged.push(paths) };
    api = createRuntime(env, { service: 'api', images: processor, purger });
    worker = createRuntime(env, { service: 'worker', images: processor, purger });
    const app = createApiApp(() => api);
    const handler = createJobHandler(worker.deps);
    const mapping = startEventSourceMapping(worker.sqs, queueUrl, (record) =>
      handleSqsEvent({ Records: [record] }, { handler, sqs: worker.sqs, queueUrl, backoffScale: 0.1 }),
    );
    stopMapping = mapping.stop;
    client = createClient({
      baseUrl: PUBLIC_URL,
      apiKey: API_KEY,
      // The origin secret is what CloudFront adds in front of the function.
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('x-hostmark-origin-secret', ORIGIN_SECRET);
        return app.request(input as string, { ...init, headers });
      }) as typeof fetch,
    });
    dropAll = async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    };
  });

  afterAll(async () => {
    await stopMapping?.();
    await api?.close();
    await worker?.close();
    await dropAll?.();
  });

  it('answers the deep health check: Postgres, S3 and SQS', async () => {
    expect((await client.deepHealth()).status).toBe('ok');
  });

  it('takes an upload to ready through presigned PUT, SQS and the worker, then purges on unpublish and delete', async () => {
    const jpeg = await makeJpeg(1400, 1000);
    const created = await client.createUpload({ contentType: 'image/jpeg', bytes: jpeg.length });
    const put = await fetch(created.uploadUrl, {
      method: 'PUT',
      headers: created.uploadHeaders,
      body: jpeg as BodyInit,
    });
    expect(put.status).toBe(200);
    await client.completeUpload(created.fileId);
    const file = await until('the file to be ready', 60_000, async () => {
      const f = await client.getFile(created.fileId);
      if (f.status === 'failed') throw new Error(`file failed: ${f.lastError}`);
      return f.status === 'ready' ? f : undefined;
    });
    expect(file.variants.map((v) => v.size).sort((a, b) => a - b)).toEqual([128, 512, 1600]);

    expect((await client.updateFile(created.fileId, { isPublic: true })).isPublic).toBe(true);
    expect((await client.updateFile(created.fileId, { isPublic: false })).isPublic).toBe(false);
    expect(purged.flat().some((p) => p.includes(created.fileId))).toBe(true);

    purged.length = 0;
    await client.deleteFile(created.fileId);
    await until('the delete to purge', 30_000, async () => purged.length > 0);
    expect(purged.flat().some((p) => p.includes(created.fileId))).toBe(true);
  });

  it('refuses a request without the origin secret', async () => {
    const app = createApiApp(() => api);
    expect((await app.request('/api/health')).status).toBe(403);
  });

  it('ends an undecodable image in failed without retries', async () => {
    const junk = new TextEncoder().encode('this is not an image'.repeat(10));
    const created = await client.createUpload({ contentType: 'image/jpeg', bytes: junk.length });
    await fetch(created.uploadUrl, { method: 'PUT', headers: created.uploadHeaders, body: junk as BodyInit });
    await client.completeUpload(created.fileId);
    const file = await until('the file to fail', 60_000, async () => {
      const f = await client.getFile(created.fileId);
      return f.status === 'failed' ? f : undefined;
    });
    expect(file.status).toBe('failed');
  });
});
