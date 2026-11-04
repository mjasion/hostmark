import type { RUM_REGIONS } from '@hostmark/contract';

type RumRegion = (typeof RUM_REGIONS)[number];

/**
 * Vercel function regions this adapter may run in, with the region name of the closed RUM list. Vercel has no Warsaw
 * region. The database must be in (or next to) the same region: every request of every function talks to it.
 */
export const VERCEL_REGIONS = {
  fra1: 'frankfurt',
  iad1: 'us-east',
  sin1: 'singapore',
} as const satisfies Record<string, RumRegion>;

/** The RUM region of the single function region in `vercel.json` (`regions`). Throws on anything else. */
export function rumRegionOf(config: { regions?: unknown }): RumRegion {
  const regions = config.regions;
  if (!Array.isArray(regions) || regions.length !== 1)
    throw new Error('vercel.json: "regions" must list exactly one function region');
  const id = regions[0] as string;
  if (!Object.hasOwn(VERCEL_REGIONS, id))
    throw new Error(
      `vercel.json: region "${id}" has no RUM region; use one of ${Object.keys(VERCEL_REGIONS).join(', ')}`,
    );
  return VERCEL_REGIONS[id as keyof typeof VERCEL_REGIONS];
}

/**
 * The `x-version` of a build: `APP_VERSION` if set, else the commit Vercel builds (`VERCEL_GIT_COMMIT_SHA`, a system
 * variable of git deployments), else the local checkout (`vercel build` in CI), else `dev`. Short SHA, as on GCP.
 */
export function buildVersion(
  env: Record<string, string | undefined>,
  gitHead: () => string | undefined,
): string {
  if (env.APP_VERSION?.trim()) return env.APP_VERSION.trim();
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim() || gitHead()?.trim();
  return sha ? sha.slice(0, 7) : 'dev';
}

/**
 * The bundle carries the region and version of its build (esbuild `define`, scripts/build.ts). A variable set on the
 * project wins, so the owner can still override either without a rebuild.
 */
export function withBuildDefaults(
  env: Record<string, string | undefined>,
  build: { region?: string; version?: string },
): Record<string, string | undefined> {
  return {
    ...(build.region ? { HOSTMARK_REGION: build.region } : {}),
    ...(build.version ? { APP_VERSION: build.version } : {}),
    ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')),
  };
}
