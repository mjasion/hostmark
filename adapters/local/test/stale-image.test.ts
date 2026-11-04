import { describe, expect, it } from 'vitest';
import { affectsImage, IMAGE, staleProblems } from '../scripts/stale-image';

const base = {
  imageId: 'sha256:aaaaaaaaaaaaaaaa',
  imageCreated: 1_000,
  containers: [
    { service: 'api', image: 'sha256:aaaaaaaaaaaaaaaa' },
    { service: 'worker', image: 'sha256:aaaaaaaaaaaaaaaa' },
  ],
  files: [{ path: 'packages/core/src/index.ts', mtime: 500 }],
};

describe('staleProblems', () => {
  it('accepts a stack whose containers run the tag and whose image is newer than the sources', () => {
    expect(staleProblems(base)).toEqual([]);
  });

  it('names a container that still runs an older image than the tag (D132)', () => {
    const problems = staleProblems({
      ...base,
      containers: [...base.containers, { service: 'scheduler', image: 'sha256:bbbbbbbbbbbbbbbb' }],
    });
    expect(problems).toEqual([`scheduler runs bbbbbbbbbbbb, not the current ${IMAGE} (aaaaaaaaaaaa)`]);
  });

  it('names source files changed after the image was built, newest first', () => {
    const problems = staleProblems({
      ...base,
      files: [
        { path: 'packages/core/src/a.ts', mtime: 2_000 },
        { path: 'adapters/local/src/b.ts', mtime: 3_000 },
        { path: 'apps/web/src/c.tsx', mtime: 900 },
      ],
    });
    expect(problems).toEqual([`${IMAGE} is older than adapters/local/src/b.ts, packages/core/src/a.ts`]);
  });

  it('counts a deleted source as a change', () => {
    const problems = staleProblems({
      ...base,
      files: [{ path: 'packages/db/src/gone.ts', mtime: Number.POSITIVE_INFINITY }],
    });
    expect(problems).toHaveLength(1);
  });

  it('shortens a long list', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `packages/core/src/f${i}.ts`,
      mtime: 2_000 + i,
    }));
    expect(staleProblems({ ...base, files })[0]).toMatch(/and 2 more$/);
  });
});

describe('affectsImage', () => {
  it.each([
    'packages/core/src/index.ts',
    'apps/web/src/main.tsx',
    'adapters/local/Dockerfile',
    'pnpm-lock.yaml',
    'adapters/local/.env.example',
  ])('counts %s', (path) => expect(affectsImage(path)).toBe(true));

  it.each([
    'docs/plan.md',
    'README.md',
    'load/k6/s1.js',
    'packages/core/test/contract/queue.ts',
    'apps/web/e2e/journey.spec.ts',
    'adapters/local/src/api.test.ts',
    '.github/workflows/ci.yml',
    'adapters/local/.env',
  ])('ignores %s', (path) => expect(affectsImage(path)).toBe(false));
});
