// Builds the Workers the way `wrangler deploy` does (bundle plus compiled wasm modules), once per test run, so the
// emulator tests run the real bundles and not the sources.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const buildDir = join(root, '.build', 'test');

export type BuiltName = 'api' | 'consumer' | 'scheduler' | 'image-service';
export const workerDir = (name: BuiltName) => join(buildDir, name);

/** `wrangler deploy --dry-run`: bundles, uploads nothing, needs no login. */
function bundle(name: BuiltName) {
  const config = name === 'image-service' ? 'test/fixtures/wrangler.image.jsonc' : `wrangler.${name}.jsonc`;
  const scratch = join(buildDir, 'wrangler');
  mkdirSync(scratch, { recursive: true });
  const run = spawnSync(
    join(root, 'node_modules', '.bin', 'wrangler'),
    ['deploy', '-c', config, '--dry-run', '--outdir', workerDir(name)],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(scratch, 'xdg'),
        WRANGLER_LOG_PATH: join(scratch, 'logs'),
        WRANGLER_SEND_METRICS: 'false',
        CI: '1',
      },
    },
  );
  if (run.status !== 0) throw new Error(`wrangler bundle of ${name} failed:\n${run.stdout}\n${run.stderr}`);
}

/** Small test-only Workers (queue harness, dead letter sink), bundled with the real `consumeBatch`. */
async function bundleFixtures() {
  for (const name of ['consumer-harness', 'dlq-sink']) {
    await build({
      entryPoints: [join(root, 'test', 'fixtures', `${name}.ts`)],
      outfile: join(buildDir, 'fixtures', `${name}.js`),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: ['cloudflare:*'],
      logLevel: 'error',
    });
  }
}

export default async function setup() {
  mkdirSync(buildDir, { recursive: true });
  const assets = join(root, '.build', 'assets');
  if (!existsSync(assets)) {
    mkdirSync(join(assets, 'app'), { recursive: true });
    writeFileSync(join(assets, 'app', 'index.html'), '<!doctype html><title>hostmark</title>');
  }
  for (const name of ['api', 'consumer', 'scheduler', 'image-service'] as const) bundle(name);
  await bundleFixtures();
}
