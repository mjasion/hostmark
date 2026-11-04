// `buildCommand` of vercel.json (`node --import tsx scripts/build.ts`, run in adapters/vercel):
// 1. builds apps/web with the RUM attributes of this deployment and copies it to public/ (the `outputDirectory`);
// 2. bundles each function with esbuild into dist/<name>.mjs, with the wasm codecs in dist/wasm/.
// `api/<name>.js` re-exports its bundle. Unbundled, the functions do not load: this package is `"type": "module"` with
// extensionless imports, and the workspace packages are TypeScript source (D4). Vercel runs the build command before
// it traces `api/` (the CLI sorts the static build first), so the bundles exist when the functions are built.
//   --skip-web   bundle the functions only (tests)
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { buildVersion, rumRegionOf } from '../src/build-info';

const adapter = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(adapter, '../..');

/** Function file (`api/<name>.js`, the key in vercel.json `functions`) to entry, and whether it decodes images. */
export const FUNCTIONS = {
  index: { entry: 'src/functions/api.ts', images: true },
  queue: { entry: 'src/functions/queue.ts', images: true },
  cron: { entry: 'src/functions/cron.ts', images: false },
} as const;

const require = createRequire(import.meta.url);
const codec = (pkg: string, file: string) => join(dirname(require.resolve(`${pkg}/package.json`)), file);
export const WASM = [
  ['@jsquash/jpeg', 'codec/dec/mozjpeg_dec.wasm'],
  ['@jsquash/png', 'codec/pkg/squoosh_png_bg.wasm'],
  ['@jsquash/webp', 'codec/dec/webp_dec.wasm'],
  ['@jsquash/webp', 'codec/enc/webp_enc.wasm'],
  ['@jsquash/webp', 'codec/enc/webp_enc_simd.wasm'],
  ['@jsquash/resize', 'lib/resize/pkg/squoosh_resize_bg.wasm'],
] as const;

function gitHead(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export async function buildFunctions(opts: { region: string; version: string; outdir?: string }) {
  const outdir = opts.outdir ?? join(adapter, 'dist');
  rmSync(outdir, { recursive: true, force: true });
  await build({
    absWorkingDir: adapter,
    entryPoints: Object.fromEntries(Object.entries(FUNCTIONS).map(([name, f]) => [name, f.entry])),
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // packages/pages renders with Hono JSX.
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
    define: {
      'process.env.HOSTMARK_BUILD_REGION': JSON.stringify(opts.region),
      'process.env.HOSTMARK_BUILD_VERSION': JSON.stringify(opts.version),
    },
    // CommonJS dependencies (`@vercel/functions`, `@vercel/oidc`) call require() on Node built-ins.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  });
  mkdirSync(join(outdir, 'wasm'), { recursive: true });
  for (const [pkg, file] of WASM)
    copyFileSync(codec(pkg, file), join(outdir, 'wasm', file.split('/').pop() ?? file));
  return outdir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { 'skip-web': { type: 'boolean', default: false } } });
  const config = JSON.parse(readFileSync(join(adapter, 'vercel.json'), 'utf8')) as { regions?: unknown };
  const region = rumRegionOf(config);
  const version = buildVersion(process.env, gitHead);
  if (!values['skip-web']) {
    const web = spawnSync('pnpm', ['--filter', '@hostmark/web', 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        HOSTMARK_PLATFORM: 'vercel',
        HOSTMARK_VARIANT: 'portable',
        HOSTMARK_TOPOLOGY: 'single',
        HOSTMARK_REGION: region,
      },
    });
    if (web.status !== 0) process.exit(web.status ?? 1);
    rmSync(join(adapter, 'public'), { recursive: true, force: true });
    cpSync(join(root, 'apps/web/dist'), join(adapter, 'public'), { recursive: true });
  }
  await buildFunctions({ region, version });
  console.log(`built: functions ${Object.keys(FUNCTIONS).join(', ')} (region ${region}, version ${version})`);
}
