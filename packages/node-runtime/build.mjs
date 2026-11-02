// Bundles the entrypoints of a Node adapter into its dist/. Workspace packages are TypeScript source (D4), so they are bundled.
// The jSquash packages stay external: the Node loader finds their .wasm files through require.resolve.
// Run from the adapter directory: `node build.mjs` there calls buildNodeAdapter().
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const jsquash = ['@jsquash/jpeg', '@jsquash/png', '@jsquash/resize', '@jsquash/webp'];
const dbCli = (name) => fileURLToPath(new URL(`../db/src/cli/${name}.ts`, import.meta.url));

export async function buildNodeAdapter() {
  await build({
    entryPoints: {
      api: 'src/api.ts',
      worker: 'src/worker.ts',
      scheduler: 'src/scheduler.ts',
      'run-job': 'src/run-job.ts',
      'init-bucket': 'src/init-bucket.ts',
      migrate: dbCli('migrate'),
      seed: dbCli('seed'),
    },
    outdir: 'dist',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external: jsquash,
    // packages/pages renders with Hono JSX.
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
    // CommonJS dependencies (OpenTelemetry, ioredis) call require() on Node built-ins.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'info',
  });

  // The bundles are ESM; the Dockerfile adds the jSquash packages next to them with `pnpm deploy --prod`.
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/package.json', `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`);
}
