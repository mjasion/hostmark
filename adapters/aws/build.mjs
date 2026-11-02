// Bundles the three Lambda functions into dist/<name>/index.mjs, each with the wasm codecs of the jSquash packages next
// to it (src/images.ts reads them from ./wasm). Workspace packages are TypeScript source (D4), so they are bundled.
//   node build.mjs
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const codec = (pkg, file) => join(dirname(require.resolve(`${pkg}/package.json`)), file);
const WASM = [
  ['@jsquash/jpeg', 'codec/dec/mozjpeg_dec.wasm'],
  ['@jsquash/png', 'codec/pkg/squoosh_png_bg.wasm'],
  ['@jsquash/webp', 'codec/dec/webp_dec.wasm'],
  ['@jsquash/webp', 'codec/enc/webp_enc.wasm'],
  ['@jsquash/webp', 'codec/enc/webp_enc_simd.wasm'],
  ['@jsquash/resize', 'lib/resize/pkg/squoosh_resize_bg.wasm'],
];
const FUNCTIONS = {
  api: ['src/api.ts', true],
  worker: ['src/worker.ts', true],
  scheduler: ['src/scheduler.ts', false],
};

rmSync('dist', { recursive: true, force: true });
for (const [name, [entry, withWasm]] of Object.entries(FUNCTIONS)) {
  const outdir = join('dist', name);
  await build({
    entryPoints: { index: entry },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // packages/pages renders with Hono JSX.
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
    // CommonJS dependencies call require() on Node built-ins.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'info',
  });
  if (withWasm) {
    mkdirSync(join(outdir, 'wasm'), { recursive: true });
    for (const [pkg, file] of WASM)
      copyFileSync(codec(pkg, file), join(outdir, 'wasm', file.split('/').pop()));
  }
  writeFileSync(join(outdir, 'package.json'), `${JSON.stringify({ type: 'module', private: true })}\n`);
}
console.log('dist/ ready: api, worker, scheduler');
