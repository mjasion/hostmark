// Plain Node, no loader: imports each `api/<name>.js` the way the Vercel Node runtime does (dynamic import, `default`
// unwrapped, then a `fetch` or per-method handler; read from `@vercel/node` 29.0.1 dev-server.mjs) and calls it.
// Run by test/bundle.test.ts after `scripts/build.ts --skip-web`. Every outgoing fetch goes to a recorder: nothing
// leaves the machine. Prints one JSON report on stdout.
import { readFile } from 'node:fs/promises';

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'];

async function load(file) {
  let listener = await import(new URL(`../api/${file}`, import.meta.url).href);
  for (let i = 0; i < 5; i++) if (listener.default) listener = listener.default;
  if (typeof listener.fetch === 'function')
    return Object.fromEntries(METHODS.map((m) => [m, listener.fetch]));
  return Object.fromEntries(
    METHODS.filter((m) => typeof listener[m] === 'function').map((m) => [m, listener[m]]),
  );
}

const outgoing = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers);
  let body;
  if (typeof init.body === 'string') body = init.body;
  else if (init.body instanceof Uint8Array) body = new TextDecoder().decode(init.body);
  outgoing.push({
    method: init.method ?? 'GET',
    url,
    idempotencyKey: headers.get('vqs-idempotency-key'),
    body,
  });
  return new Response(JSON.stringify({ messageId: 'probe-dlq-message' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const report = { exports: {}, wasm: {} };
const api = await load('index.js');
const cron = await load('cron.js');
const queue = await load('queue.js');
report.exports = { index: Object.keys(api), cron: Object.keys(cron), queue: Object.keys(queue) };

const origin = 'https://hostmark.example';
const health = await api.GET(new Request(`${origin}/api/health`));
report.health = {
  status: health.status,
  version: health.headers.get('x-version'),
  body: await health.json(),
};
const page = await api.GET(new Request(`${origin}/f/NOT-A-UUID`));
const html = await page.text();
report.notFoundPage = {
  status: page.status,
  region: /data-region="([^"]*)"/.exec(html)?.[1],
  platform: /data-platform="([^"]*)"/.exec(html)?.[1],
};

report.cron = {
  noSecret: (await cron.GET(new Request(`${origin}/api/cron?job=daily-stats`))).status,
  unknownJob: (
    await cron.GET(
      new Request(`${origin}/api/cron?job=drop-tables`, {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    )
  ).status,
};

const malformed = await queue.POST(new Request(`${origin}/api/queue`, { method: 'POST', body: 'not json' }));
report.queueMalformed = malformed.status;

// A binary mode CloudEvent (`queue/v2beta`) of a job on its sixth delivery: the consumer must dead-letter it without
// running the job, then acknowledge.
const job = {
  v: 1,
  type: 'process_image',
  jobId: '00000000-0000-4000-8000-000000000001',
  fileId: '00000000-0000-4000-8000-000000000002',
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
};
const delivery = await queue.POST(
  new Request(`${origin}/api/queue`, {
    method: 'POST',
    headers: {
      'ce-type': 'com.vercel.queue.v2beta',
      'ce-vqsqueuename': 'image-jobs',
      'ce-vqsconsumergroup': 'probe',
      'ce-vqsmessageid': 'probe-message',
      'ce-vqsreceipthandle': 'probe-receipt',
      'ce-vqsdeliverycount': '6',
      'ce-vqsregion': 'fra1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(job),
  }),
);
report.queueDelivery = { status: delivery.status, body: await delivery.json(), outgoing };

for (const file of process.argv.slice(2)) {
  const module = await WebAssembly.compile(await readFile(new URL(`../dist/wasm/${file}`, import.meta.url)));
  report.wasm[file] = WebAssembly.Module.exports(module).length > 0;
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(0);
