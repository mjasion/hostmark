import { createServer, type Server, Socket } from 'node:net';
import type { JobMessage } from '@hostmark/contract';
import { Queue as BullQueue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import { createBullQueue, redisConnection, SEND_TIMEOUT_MS } from '../src/queue';

// M3: a producer must fail fast while Redis is unreachable and work again once it is back. A TCP proxy in front of
// the test Redis stands in for "Redis stopped", without touching the shared container.
const redisUrl = process.env.REDIS_TEST_URL;

const message = (): JobMessage => ({
  v: 1,
  type: 'process_image',
  jobId: crypto.randomUUID(),
  fileId: crypto.randomUUID(),
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
});

function proxy(target: URL, port = 0) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = new Socket();
    upstream.connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    for (const s of [client, upstream]) s.on('error', () => s.destroy()).on('close', () => sockets.delete(s));
  });
  return {
    listen: () =>
      new Promise<number>((r) =>
        server.listen(port, '127.0.0.1', () => r((server.address() as { port: number }).port)),
      ),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe.skipIf(!redisUrl)('the producer while Redis is down (M3)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it('rejects within the send timeout and recovers when Redis returns', async () => {
    const name = `down-${crypto.randomUUID()}`;
    const front = proxy(new URL(redisUrl as string));
    const port = await front.listen();
    const queue = createBullQueue(`redis://127.0.0.1:${port}`, name);
    let revived: ReturnType<typeof proxy> | undefined;
    cleanups.push(async () => {
      await queue.close();
      await revived?.close();
      await front.close();
      const cleaner = new BullQueue(name, { connection: redisConnection(redisUrl as string) });
      await cleaner.obliterate({ force: true });
      await cleaner.close();
    });

    await queue.send(message());
    await front.close();
    const started = Date.now();
    await expect(queue.send(message())).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(SEND_TIMEOUT_MS + 2000);
    await expect(queue.sendBatch([message(), message()])).rejects.toThrow();

    revived = proxy(new URL(redisUrl as string), port);
    await revived.listen();
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await queue.send(message());
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 60_000);
});
