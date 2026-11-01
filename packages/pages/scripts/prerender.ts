// Run after the Vite build: writes the two static pages next to the SPA (D21).
// HOSTMARK_PLATFORM, HOSTMARK_VARIANT, HOSTMARK_TOPOLOGY and HOSTMARK_REGION set the RUM attributes; the values
// must come from the closed lists in packages/contract. HOSTMARK_DIST overrides the output directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUM_PLATFORMS, RUM_REGIONS, RUM_TOPOLOGIES, RUM_VARIANTS } from '@hostmark/contract/constants';
import { renderLanding, renderPricing } from '../src/index';

const lists = {
  platform: RUM_PLATFORMS,
  variant: RUM_VARIANTS,
  topology: RUM_TOPOLOGIES,
  region: RUM_REGIONS,
} as const;

function pick(key: keyof typeof lists, envName: string, fallback: string): string {
  const value = process.env[envName] || fallback;
  if (!(lists[key] as readonly string[]).includes(value))
    throw new Error(`${envName}=${value} is not one of: ${lists[key].join(', ')}`);
  return value;
}

const rum = {
  platform: pick('platform', 'HOSTMARK_PLATFORM', 'local'),
  variant: pick('variant', 'HOSTMARK_VARIANT', 'portable'),
  topology: pick('topology', 'HOSTMARK_TOPOLOGY', 'single'),
  region: pick('region', 'HOSTMARK_REGION', 'local'),
};

const dist = resolve(
  process.env.HOSTMARK_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/dist'),
);

const out: [string, string][] = [
  [resolve(dist, 'index.html'), renderLanding(rum)],
  [resolve(dist, 'pricing/index.html'), renderPricing(rum)],
];
for (const [file, html] of out) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  console.log(`wrote ${file} (${html.length} bytes)`);
}
