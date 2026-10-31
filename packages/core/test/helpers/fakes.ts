import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JobMessage } from '@hostmark/contract';
import type { Metrics, Telemetry } from '@hostmark/telemetry';
import { trace } from '@opentelemetry/api';
import { InvalidImageError } from '../../src/errors';
import type { Clock, ImageProcessor, ObjectStorage, Queue } from '../../src/ports';

export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  /** When true, sleep advances `current` instead of waiting. */
  constructor(public current = new Date('2026-11-02T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const expiry = (ttlSeconds: number): string => String(Date.now() + ttlSeconds * 1000);

export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  readonly presigned: string[] = [];
  failHead: Error | 'hang' | null = null;
  gets = 0;

  constructor(private readonly baseUrl = 'https://storage.test') {}

  async presignPut(key: string, contentType: string, bytes: number, ttl: number): Promise<string> {
    this.presigned.push(key);
    const q = new URLSearchParams({ put: '1', len: String(bytes), type: contentType, exp: expiry(ttl) });
    return `${this.baseUrl}/${key}?${q}`;
  }
  async presignGet(key: string, ttl: number): Promise<string> {
    this.presigned.push(key);
    return `${this.baseUrl}/${key}?get=1&exp=${expiry(ttl)}`;
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    return this.objects.get(key)?.body ?? null;
  }
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    if (this.failHead === 'hang') return new Promise(() => {});
    if (this.failHead) throw this.failHead;
    const o = this.objects.get(key);
    return o ? { size: o.body.byteLength, contentType: o.contentType } : null;
  }
  async delete(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
  }
}

/** Serves presigned URLs of a MemoryStorage over real HTTP, so the storage contract suite can run against it. */
export async function serveMemoryStorage(): Promise<{ storage: MemoryStorage; close(): Promise<void> }> {
  let storage!: MemoryStorage;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = decodeURIComponent(url.pathname.slice(1));
    if (Number(url.searchParams.get('exp')) < Date.now()) return void res.writeHead(403).end();
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        const contentType = req.headers['content-type'] ?? 'application/octet-stream';
        // What a signed S3 URL enforces: the presigned length and content type.
        if (body.byteLength !== Number(url.searchParams.get('len'))) return void res.writeHead(403).end();
        if (contentType !== url.searchParams.get('type')) return void res.writeHead(403).end();
        void storage.put(key, body, contentType).then(() => res.writeHead(200).end());
      });
    } else {
      void storage.get(key).then((body) => {
        if (!body) return res.writeHead(404).end();
        res.writeHead(200).end(Buffer.from(body));
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  storage = new MemoryStorage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return { storage, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export class MemoryQueue implements Queue {
  readonly sent: { msg: JobMessage; delaySeconds?: number }[] = [];
  fail: Error | null = null;
  pingImpl: (() => Promise<void>) | undefined;

  constructor(withPing = true) {
    if (withPing) this.pingImpl = async () => {};
  }
  get ping(): (() => Promise<void>) | undefined {
    return this.pingImpl;
  }
  async send(msg: JobMessage, opts?: { delaySeconds?: number }): Promise<void> {
    if (this.fail) throw this.fail;
    this.sent.push({ msg, delaySeconds: opts?.delaySeconds });
  }
  async sendBatch(msgs: JobMessage[]): Promise<void> {
    if (this.fail) throw this.fail;
    for (const msg of msgs) this.sent.push({ msg });
  }
  messages(type?: JobMessage['type']): JobMessage[] {
    return this.sent.map((s) => s.msg).filter((m) => !type || m.type === type);
  }
}

const text = new TextEncoder();
const decoder = new TextDecoder();

/** A fake "image": `fake:<width>x<height>`. `invalid` bytes are undecodable. */
export const fakeImage = (width = 2000, height = 1000, salt = ''): Uint8Array =>
  text.encode(`fake:${width}x${height}${salt ? `:${salt}` : ''}`);

export class FakeImages implements ImageProcessor {
  readonly impl = 'wasm' as const;
  calls = 0;
  failWith: Error | null = null;

  async process(input: Uint8Array, sizes: number[]) {
    this.calls++;
    if (this.failWith) throw this.failWith;
    const m = /^fake:(\d+)x(\d+)/.exec(decoder.decode(input));
    if (!m) throw new InvalidImageError('not an image');
    const width = Number(m[1]);
    const height = Number(m[2]);
    return {
      width,
      height,
      variants: sizes.map((size) => {
        const body = text.encode(`webp:${size}:${decoder.decode(input)}`);
        return { size, body, bytes: body.byteLength };
      }),
    };
  }
}

interface Recorded {
  name: string;
  value: number;
  attrs?: Record<string, unknown>;
}

const recorder = (name: string, log: Recorded[]) => ({
  record: (value: number, attrs?: Record<string, unknown>) => void log.push({ name, value, attrs }),
  add: (value: number, attrs?: Record<string, unknown>) => void log.push({ name, value, attrs }),
});

export interface TestTelemetry extends Telemetry {
  logs: { level: string; msg: string; fields?: Record<string, unknown> }[];
  recorded: Recorded[];
  of(name: string): Recorded[];
}

export function createTestTelemetry(): TestTelemetry {
  const recorded: Recorded[] = [];
  const logs: TestTelemetry['logs'] = [];
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    void logs.push({ level, msg, fields });
  const metrics = {
    httpRequestDuration: recorder('httpRequestDuration', recorded),
    coldStart: recorder('coldStart', recorded),
    enqueueToStartMs: recorder('enqueueToStartMs', recorded),
    processingDurationMs: recorder('processingDurationMs', recorded),
    uploadToReadyMs: recorder('uploadToReadyMs', recorded),
    jobsRetried: recorder('jobsRetried', recorded),
    jobsDeadLettered: recorder('jobsDeadLettered', recorded),
    schedulerRunDurationMs: recorder('schedulerRunDurationMs', recorded),
    webVitals: recorder('webVitals', recorded),
  } as unknown as Metrics;
  return {
    tracer: trace.getTracer('test'),
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    metrics,
    logs,
    recorded,
    of: (name) => recorded.filter((r) => r.name === name),
  };
}
