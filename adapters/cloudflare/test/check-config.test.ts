// `pnpm check --deploy` (D255): the committed placeholders pass the offline check and are refused in deploy mode.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_HYPERDRIVE_ID, placeholderProblems } from '../scripts/placeholders.mjs';
import { root } from './build';

const committed = {
  vars: {
    ENVIRONMENT: 'production',
    PUBLIC_URL: 'https://hostmark.example.com',
    AUTH_TRUSTED_ORIGINS: '',
    R2_ACCOUNT_ID: 'REPLACE_WITH_ACCOUNT_ID',
    R2_BUCKET_NAME: 'hostmark-files',
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: PLACEHOLDER_HYPERDRIVE_ID }],
};
const filled = {
  vars: {
    ...committed.vars,
    PUBLIC_URL: 'https://hostmark.dev',
    AUTH_TRUSTED_ORIGINS: 'https://www.hostmark.dev',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
};

describe('placeholderProblems', () => {
  it('names every placeholder of the committed configs', () => {
    expect(placeholderProblems('api', committed)).toEqual([
      'api: vars.PUBLIC_URL is the placeholder "https://hostmark.example.com"',
      'api: vars.R2_ACCOUNT_ID is the placeholder "REPLACE_WITH_ACCOUNT_ID"',
      'api: hyperdrive HYPERDRIVE still has the all-zero placeholder id',
    ]);
  });

  it('accepts the owner values', () => {
    expect(placeholderProblems('api', filled)).toEqual([]);
  });

  it('can leave the Hyperdrive id to the bootstrap, which creates it', () => {
    expect(placeholderProblems('api', committed, { skip: ['hyperdrive'] })).toHaveLength(2);
  });

  it('matches the reserved example domains as hosts only', () => {
    const one = (value: string) => placeholderProblems('x', { vars: { V: value } }).length;
    for (const v of [
      'https://example.com',
      'https://a.example.org:8443/x',
      'ops@example.net',
      'replace_with_me',
    ])
      expect(one(v), v).toBe(1);
    for (const v of ['https://notexample.com', 'https://example.community', 'https://hostmark.dev'])
      expect(one(v), v).toBe(0);
  });

  it('refuses an account_id placeholder at the top level', () => {
    expect(placeholderProblems('api', { ...filled, account_id: 'REPLACE_WITH_ACCOUNT_ID' })).toEqual([
      'api: account_id is a placeholder',
    ]);
  });
});

describe('scripts/check-config.ts --deploy', () => {
  it('refuses the committed configs and names each placeholder', { timeout: 240_000 }, () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts', 'check-config.ts'), '--deploy'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status, run.stdout).toBe(1);
    for (const name of ['api', 'consumer', 'scheduler']) {
      expect(run.stderr).toContain(`${name}: vars.R2_ACCOUNT_ID is the placeholder`);
      expect(run.stderr).toContain(`${name}: vars.PUBLIC_URL is the placeholder`);
      expect(run.stderr).toContain(`${name}: hyperdrive HYPERDRIVE still has the all-zero placeholder id`);
    }
    // Nothing else is wrong with them: the offline mode passes (`pnpm check` in CI).
    expect(run.stderr).toMatch(/^9 problem\(s\):/m);
  });
});
