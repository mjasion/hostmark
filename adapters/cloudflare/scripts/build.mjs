// Prepares what wrangler uploads besides the Worker code: the static assets (the web build plus a `_headers` file).
// The Workers themselves are bundled by `wrangler deploy`; `pnpm check` bundles them offline to prove they build.
//   node --import tsx scripts/build.mjs [--skip-web]      (`pnpm build`; headers.mjs imports TypeScript, D310)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFile, storageOriginForBuild } from './headers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..', '..');
const dist = join(repo, 'apps', 'web', 'dist');
const assets = join(root, '.build', 'assets');

if (!process.argv.includes('--skip-web')) {
  // D85: the RUM attributes are baked into the pages. `region` is overridable for the deployment.
  const env = {
    ...process.env,
    HOSTMARK_PLATFORM: 'cloudflare',
    HOSTMARK_VARIANT: 'portable',
    HOSTMARK_TOPOLOGY: process.env.HOSTMARK_TOPOLOGY ?? 'multi',
    HOSTMARK_REGION: process.env.HOSTMARK_REGION ?? 'unknown',
  };
  const run = spawnSync('pnpm', ['--filter', '@hostmark/web', 'build'], { cwd: repo, env, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
if (!existsSync(join(dist, 'app', 'index.html'))) {
  console.error(`${dist} has no app/index.html: run without --skip-web first`);
  process.exit(1);
}

// D310: the origin of presigned R2 URLs for the prerendered pages' policy, from the same vars the Worker presigns with.
const storageOrigin = storageOriginForBuild();
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(dist, assets, { recursive: true });
// Same cache policy as the Node static handler (packages/node-runtime/src/static.ts, D88), one value per file (D251),
// and the security headers of D310.
writeFileSync(join(assets, '_headers'), headersFile({ storageOrigin }));
console.log(`assets ready in ${assets} (storage origin in the pages' policy: ${storageOrigin})`);
