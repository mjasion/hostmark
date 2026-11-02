// Bundles api, worker and run-job into dist/. Workspace packages are TypeScript source (D4), so they are bundled.
// jSquash stays external (its .wasm files are found through require.resolve), and so does the Pub/Sub client: gRPC
// and the proto files are loaded from disk at runtime, which bundling breaks. The Dockerfile installs both with `pnpm deploy --prod`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const external = [
  '@jsquash/jpeg',
  '@jsquash/png',
  '@jsquash/resize',
  '@jsquash/webp',
  '@google-cloud/pubsub',
];
const dbCli = (name) => fileURLToPath(new URL(`../../packages/db/src/cli/${name}.ts`, import.meta.url));

await build({
  entryPoints: {
    api: 'src/api.ts',
    worker: 'src/worker.ts',
    'run-job': 'src/run-job.ts',
    migrate: dbCli('migrate'),
    seed: dbCli('seed'),
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`);
