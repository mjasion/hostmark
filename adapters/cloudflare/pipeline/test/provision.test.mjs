import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNeonClient } from '../neon.mjs';
import {
  hyperdriveIdFromList,
  hyperdriveIdFromOutput,
  parseJsonc,
  previewResources,
  renderPreviewConfig,
  stripJsonc,
} from '../preview-config.mjs';
import { provisionPreview, teardownPreview } from '../provision.mjs';
import { BRANCH, ENDPOINT, fakeFetch, PARENT, URI_DIRECT, URI_POOLED } from './helpers.mjs';

const HD = 'a'.repeat(32);
const HD_PROD = '0'.repeat(32);
const ADAPTER = new URL('../../', import.meta.url);
const real = (name) => parseJsonc(readFileSync(new URL(name, ADAPTER), 'utf8'));
const api = real('wrangler.api.jsonc');
const consumer = real('wrangler.consumer.jsonc');
const scheduler = real('wrangler.scheduler.jsonc');
const bases = [api, consumer];
const workers = bases.map((b) => b.name);

const render = (base, over = {}) =>
  renderPreviewConfig(base, {
    pr: 12,
    sha: 'abc1234',
    publicUrl: 'https://hostmark-api-pr-12.acct.workers.dev',
    previewBucket: 'hostmark-preview',
    hyperdriveId: HD,
    accountId: 'f'.repeat(32),
    workers,
    ...over,
  });

test('JSONC: comments and trailing commas go, strings stay', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // y", /* b */ "b": [1, 2,], }'), { a: 'x // y', b: [1, 2] });
  assert.throws(() => stripJsonc('/* open'), /unterminated/);
});

test('render the real api config: nothing of production survives', () => {
  const out = render(api, { isPublic: true });
  assert.equal(out.name, 'hostmark-api-pr-12');
  assert.equal(out.workers_dev, true);
  assert.deepEqual(out.queues.producers, [{ binding: 'QUEUE', queue: 'image-jobs-pr-12' }]);
  assert.deepEqual(out.r2_buckets, [{ binding: 'BUCKET', bucket_name: 'hostmark-preview' }]);
  assert.deepEqual(out.hyperdrive, [{ binding: 'HYPERDRIVE', id: HD }]);
  assert.equal(out.vars.ENVIRONMENT, 'preview');
  assert.equal(out.vars.APP_VERSION, 'abc1234');
  assert.equal(out.vars.PUBLIC_URL, 'https://hostmark-api-pr-12.acct.workers.dev');
  assert.equal(out.vars.R2_BUCKET_NAME, 'hostmark-preview');
  assert.equal(out.vars.R2_ACCOUNT_ID, 'f'.repeat(32));
  assert.ok(out.assets && out.exports, 'assets and exports are carried over');
  const text = JSON.stringify(out);
  for (const production of [
    'hostmark-files',
    'localConnectionString',
    '00000000000000000000000000000000',
    'hostmark.example.com',
    '"image-jobs"',
  ]) {
    assert.ok(!text.includes(production), production);
  }
});

test('render the real consumer config: own queues, service binding to the preview api, no workers.dev', () => {
  const out = render(consumer);
  assert.equal(out.name, 'hostmark-consumer-pr-12');
  assert.equal(out.workers_dev, false);
  assert.deepEqual(out.services, [{ binding: 'MEDIA', service: 'hostmark-api-pr-12', entrypoint: 'Media' }]);
  const [c] = out.queues.consumers;
  assert.equal(c.queue, 'image-jobs-pr-12');
  assert.equal(c.dead_letter_queue, 'image-jobs-dlq-pr-12');
  assert.equal(c.max_retries, 4);
  assert.equal(out.limits.cpu_ms, 300000);
});

test('render: the scheduler is not part of a preview, and a service binding outside the preview is refused', () => {
  assert.throws(() => render(consumer, { workers: ['hostmark-consumer'] }), /not a Worker of this preview/);
  assert.throws(() => render(scheduler), /not in the list/);
  const out = render(scheduler, { workers: [...workers, scheduler.name] });
  assert.equal(out.triggers, undefined, 'a preview never runs on a cron');
});

test('render: a key the renderer does not know is refused (could point at production)', () => {
  for (const key of [
    'd1_databases',
    'kv_namespaces',
    'vectorize',
    'ai',
    'durable_objects',
    'analytics_engine_datasets',
  ]) {
    assert.throws(() => render({ ...api, [key]: [{}] }), new RegExp(key));
  }
});

test('render: refuses the production bucket and malformed inputs', () => {
  assert.throws(() => render(api, { previewBucket: 'hostmark-files' }), /production bucket/);
  assert.throws(() => render(api, { pr: '12; id' }), /positive integer/);
  assert.throws(() => render(api, { sha: 'zz' }), /commit hash/);
  assert.throws(() => render(api, { publicUrl: 'http://x.example.com' }), /https origin/);
  assert.throws(() => render(api, { hyperdriveId: HD_PROD.slice(1) }), /32 character/);
});

test('render does not mutate the base config', () => {
  const copy = structuredClone(api);
  render(api);
  assert.deepEqual(api, copy);
});

test('resources: exactly the names the renders use, consumers deleted first', () => {
  assert.deepEqual(previewResources(bases, 12), {
    workers: ['hostmark-consumer-pr-12', 'hostmark-api-pr-12'],
    queues: ['image-jobs-dlq-pr-12', 'image-jobs-pr-12'],
    hyperdrive: 'hostmark-pr-12',
  });
  assert.throws(() => previewResources(bases, '12; x'), /positive integer/);
});

test('hyperdrive output parsing is strict about ambiguity', () => {
  assert.equal(hyperdriveIdFromOutput(`created\n"id": "${HD}"\n`), HD);
  assert.equal(hyperdriveIdFromOutput(`${HD} ${'b'.repeat(32)}`), null);
  assert.equal(hyperdriveIdFromOutput('nothing'), null);
  const table = `│ ${HD} │ hostmark-pr-12 │\n│ ${'b'.repeat(32)} │ hostmark-pr-120 │`;
  assert.equal(hyperdriveIdFromList(table, 'hostmark-pr-12'), HD);
  assert.equal(hyperdriveIdFromList(table, 'hostmark-pr-1'), null);
});

// --- orchestration against a fake wrangler ---
function fakeExec(handlers = {}) {
  const calls = [];
  const exec = async (args, options) => {
    calls.push({ args, options });
    const key = args.slice(0, args[0] === 'wrangler' ? 3 : 1).join(' ');
    const handler = Object.entries(handlers).find(([k]) => key.startsWith(k));
    return handler ? handler[1](args) : { code: 0, stdout: '' };
  };
  exec.calls = calls;
  return exec;
}
const neonFor = (routes) => createNeonClient({ apiKey: 'k', projectId: 'proj-1', fetch: fakeFetch(routes) });
const neonEnv = { parentId: PARENT, database: 'hostmark', role: 'app' };
const createRoutes = () => [
  { method: 'GET', match: 'search', json: { branches: [] } },
  { method: 'POST', match: '/branches', json: { branch: { id: BRANCH }, endpoints: [{ id: ENDPOINT }] } },
  { method: 'GET', match: 'connection_uri', json: { uri: URI_DIRECT } },
  { method: 'GET', match: 'connection_uri', json: { uri: URI_POOLED } },
];
const flat = (exec) => exec.calls.map((c) => c.args.join(' '));

test('provision: migrates the preview branch only, creates queues and Hyperdrive, masks secrets', async () => {
  const logs = [];
  const exec = fakeExec({
    'wrangler hyperdrive list': () => ({ code: 0, stdout: '' }),
    'wrangler hyperdrive create': () => ({ code: 0, stdout: `"id": "${HD}"` }),
  });
  const result = await provisionPreview({
    exec,
    neon: neonFor(createRoutes()),
    bases,
    pr: 12,
    neonEnv,
    log: (l) => logs.push(l),
  });
  assert.equal(result.hyperdriveId, HD);
  assert.equal(exec.calls.find((c) => c.args[0] === 'pnpm').options.env.DATABASE_URL, URI_DIRECT);
  assert.deepEqual(
    exec.calls.filter((c) => c.args[1] === 'queues').map((c) => c.args[3]),
    ['image-jobs-dlq-pr-12', 'image-jobs-pr-12'],
  );
  assert.ok(
    flat(exec).includes(
      `wrangler hyperdrive create hostmark-pr-12 --connection-string ${URI_DIRECT} --caching-disabled`,
    ),
  );
  assert.ok(logs.includes(`::add-mask::${URI_DIRECT}`));
  assert.ok(logs.includes('::add-mask::s3cret-pass'));
  assert.ok(!logs.some((l) => l.includes('s3cret-pass') && !l.startsWith('::add-mask::')));
});

test('provision: an existing Hyperdrive config is updated, an existing queue is fine', async () => {
  const exec = fakeExec({
    'wrangler queues create': () => ({ code: 1, stdout: 'A queue with this name already exists' }),
    'wrangler hyperdrive list': () => ({ code: 0, stdout: `${HD} hostmark-pr-12` }),
  });
  const result = await provisionPreview({ exec, neon: neonFor(createRoutes()), bases, pr: 12, neonEnv });
  assert.equal(result.hyperdriveId, HD);
  const update = exec.calls.find((c) => c.args[1] === 'hyperdrive' && c.args[2] === 'update');
  assert.ok(update?.args.includes('--caching-disabled'));
  assert.ok(!exec.calls.some((c) => c.args[1] === 'hyperdrive' && c.args[2] === 'create'));
});

test('provision: each failure stops it with a message', async () => {
  const run = (handlers) =>
    provisionPreview({ exec: fakeExec(handlers), neon: neonFor(createRoutes()), bases, pr: 12, neonEnv });
  await assert.rejects(run({ pnpm: () => ({ code: 1, stdout: '' }) }), /migrating/);
  await assert.rejects(
    run({ 'wrangler queues create': () => ({ code: 1, stdout: 'quota exceeded' }) }),
    /creating queue/,
  );
  await assert.rejects(
    run({ 'wrangler hyperdrive list': () => ({ code: 1, stdout: '' }) }),
    /listing Hyperdrive/,
  );
  await assert.rejects(
    run({
      'wrangler hyperdrive create': () => ({ code: 0, stdout: 'created, no id' }),
      'wrangler hyperdrive list': () => ({ code: 0, stdout: '' }),
    }),
    /could not read the id/,
  );
});

const foundBranch = () => ({
  method: 'GET',
  match: 'search',
  json: { branches: [{ id: BRANCH, name: 'preview/pr-12' }] },
});

test('teardown: removes everything by exact name', async () => {
  const exec = fakeExec({
    'wrangler hyperdrive list': () => ({
      code: 0,
      stdout: `${HD} hostmark-pr-12\n${'b'.repeat(32)} hostmark-pr-1`,
    }),
  });
  await teardownPreview({
    exec,
    neon: neonFor([foundBranch(), { method: 'DELETE', match: BRANCH, json: {} }]),
    bases,
    pr: 12,
  });
  const calls = flat(exec);
  assert.ok(
    calls.indexOf('wrangler delete hostmark-consumer-pr-12 --force') <
      calls.indexOf('wrangler delete hostmark-api-pr-12 --force'),
  );
  assert.ok(calls.includes('wrangler queues delete image-jobs-pr-12'));
  assert.ok(calls.includes(`wrangler hyperdrive delete ${HD}`));
  assert.ok(!calls.some((l) => l.includes('b'.repeat(32))));
  assert.ok(
    !calls.some((l) => /delete (hostmark-api|hostmark-consumer|image-jobs)( |$)/.test(l)),
    'never a production name',
  );
});

test('teardown: everything already gone is a success (the cleanup can run twice)', async () => {
  const exec = fakeExec({
    'wrangler delete': () => ({ code: 1, stdout: 'Worker not found' }),
    'wrangler queues delete': () => ({ code: 1, stdout: 'Queue does not exist' }),
    'wrangler hyperdrive list': () => ({ code: 0, stdout: '' }),
  });
  await teardownPreview({
    exec,
    neon: neonFor([{ method: 'GET', match: 'search', json: { branches: [] } }]),
    bases,
    pr: 12,
  });
});

test('teardown: one failure does not skip the rest, and the call still fails', async () => {
  const exec = fakeExec({
    'wrangler delete hostmark-api': () => ({ code: 1, stdout: 'API error 500' }),
    'wrangler hyperdrive list': () => ({ code: 0, stdout: '' }),
  });
  await assert.rejects(
    teardownPreview({
      exec,
      neon: neonFor([foundBranch(), { method: 'DELETE', match: BRANCH, json: {} }]),
      bases,
      pr: 12,
    }),
    /not fully removed: worker hostmark-api-pr-12/,
  );
  assert.ok(flat(exec).includes('wrangler queues delete image-jobs-pr-12'));
});

test('teardown: a Neon failure is reported while the Cloudflare resources are still removed', async () => {
  const exec = fakeExec({ 'wrangler hyperdrive list': () => ({ code: 0, stdout: '' }) });
  await assert.rejects(
    teardownPreview({
      exec,
      neon: neonFor([{ method: 'GET', match: 'search', status: 500, json: {} }]),
      bases,
      pr: 12,
    }),
    /database branch/,
  );
  assert.ok(flat(exec).includes('wrangler delete hostmark-api-pr-12 --force'));
});
