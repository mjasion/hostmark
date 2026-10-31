import { type JobMessage, originalKey } from '@hostmark/contract';
import { files } from '@hostmark/db';
import { eq } from 'drizzle-orm';
import type { CoreDeps, SessionAuth } from '../../src/deps';
import { createApp } from '../../src/http/app';
import { createJobHandler } from '../../src/jobs/handler';
import { createSchedulerJobs } from '../../src/jobs/scheduler';
import type { JobContext } from '../../src/ports';
import { resetAndSeed, type TestDb } from './db';
import {
  createTestTelemetry,
  FakeClock,
  FakeImages,
  MemoryQueue,
  MemoryStorage,
  type TestTelemetry,
} from './fakes';

export interface Harness {
  deps: CoreDeps;
  clock: FakeClock;
  storage: MemoryStorage;
  queue: MemoryQueue;
  images: FakeImages;
  telemetry: TestTelemetry;
  app: ReturnType<typeof createApp>;
  handler: ReturnType<typeof createJobHandler>;
  scheduler: ReturnType<typeof createSchedulerJobs>;
  crashes: number;
  request(path: string, init?: RequestInit & { key?: string; json?: unknown }): Promise<Response>;
  ctx(overrides?: Partial<JobContext>): JobContext;
  /** Uploads through the API and PUTs the bytes into the fake storage; returns the file id. */
  upload(key: string, bytes: Uint8Array, contentType?: string): Promise<string>;
  /** Upload plus complete. */
  uploadAndComplete(key: string, bytes: Uint8Array, headers?: Record<string, string>): Promise<string>;
  deliver(msg: JobMessage, ctx?: Partial<JobContext>): Promise<void>;
  row(id: string): Promise<typeof files.$inferSelect>;
  apiKeyIds: Record<'alice' | 'bob' | 'admin', string>;
}

export async function createHarness(testDb: TestDb, opts: { auth?: SessionAuth } = {}): Promise<Harness> {
  const { apiKeyIds } = await resetAndSeed(testDb.db);
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  const queue = new MemoryQueue();
  const images = new FakeImages();
  const telemetry = createTestTelemetry();
  const deps: CoreDeps = {
    db: testDb.db,
    storage,
    queue,
    images,
    clock,
    telemetry,
    config: { platform: 'test-portable', version: 'abc1234' },
    auth: opts.auth,
  };
  const app = createApp(() => deps, { probeTimeoutMs: 200 });
  const handler = createJobHandler(deps);
  const scheduler = createSchedulerJobs(deps);

  const h: Harness = {
    deps,
    clock,
    storage,
    queue,
    images,
    telemetry,
    app,
    handler,
    scheduler,
    crashes: 0,
    apiKeyIds,
    async request(path, init = {}) {
      const { key, json, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (key) headers.set('authorization', `Bearer ${key}`);
      let body = rest.body;
      if (json !== undefined) {
        body = JSON.stringify(json);
        headers.set('content-type', 'application/json');
      }
      return app.request(path, { ...rest, headers, body });
    },
    ctx(overrides = {}) {
      return {
        attempt: 1,
        maxAttempts: 5,
        receivedAt: clock.now(),
        crash: async () => {
          h.crashes++;
          throw new Error('crash');
        },
        ...overrides,
      };
    },
    async upload(key, bytes, contentType = 'image/png') {
      const res = await h.request('/api/uploads', {
        method: 'POST',
        key,
        json: { contentType, bytes: bytes.byteLength },
      });
      if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
      const { fileId } = (await res.json()) as { fileId: string };
      const row = await h.row(fileId);
      await storage.put(row.originalKey, bytes, contentType);
      return fileId;
    },
    async uploadAndComplete(key, bytes, headers = {}) {
      const id = await h.upload(key, bytes);
      const res = await h.request(`/api/uploads/${id}/complete`, { method: 'POST', key, headers });
      if (res.status !== 200) throw new Error(`complete failed: ${res.status} ${await res.text()}`);
      return id;
    },
    deliver(msg, ctx) {
      return handler(msg, h.ctx(ctx));
    },
    async row(id) {
      const [row] = await testDb.db.select().from(files).where(eq(files.id, id));
      if (!row) throw new Error(`no row ${id}`);
      return row;
    },
  };
  return h;
}

export const lastMessage = (h: Harness): JobMessage => {
  const msg = h.queue.messages().at(-1);
  if (!msg) throw new Error('nothing was enqueued');
  return msg;
};

export { originalKey };
