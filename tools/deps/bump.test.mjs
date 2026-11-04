import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loosen, manifests, pin, SKIP } from './bump.mjs';

test('loosens exact pins only, skips workspace links, ranges and the D231 exception', () => {
  const m = {
    dependencies: {
      hono: '4.13.16',
      '@hostmark/core': 'workspace:*',
      zod: '^4.6.7',
      'path-to-regexp': '6.3.0',
    },
    devDependencies: { vitest: '5.1.0', '@vercel/queue': '0.11.0', tag: 'latest' },
  };
  const changed = loosen(m);
  assert.deepEqual(
    changed.map((e) => e.name),
    ['hono', 'vitest', '@vercel/queue'],
  );
  assert.equal(m.dependencies.hono, '^4.13.16');
  assert.equal(m.dependencies['@hostmark/core'], 'workspace:*');
  assert.equal(m.dependencies.zod, '^4.6.7');
  assert.equal(m.dependencies['path-to-regexp'], '6.3.0');
  assert.equal(m.devDependencies.tag, 'latest');
  assert.ok(SKIP.has('path-to-regexp'));
});

test('pins the loosened entries at the version the update wrote, and leaves other ranges alone', () => {
  const m = { dependencies: { hono: '^4.13.20', zod: '^4.6.7' } };
  pin(m, [{ section: 'dependencies', name: 'hono', from: '4.13.16' }]);
  assert.deepEqual(m.dependencies, { hono: '4.13.20', zod: '^4.6.7' });
});

test('finds the root manifest and the ones under apps/, packages/ and adapters/', () => {
  const root = mkdtempSync(join(tmpdir(), 'hm-bump-'));
  writeFileSync(join(root, 'package.json'), '{}');
  for (const dir of ['apps/web', 'packages/core', 'adapters/aws', 'load']) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), '{}');
  }
  mkdirSync(join(root, 'packages/empty'), { recursive: true });
  const found = manifests(root)
    .map((f) => f.slice(root.length + 1))
    .sort();
  assert.deepEqual(found, [
    'adapters/aws/package.json',
    'apps/web/package.json',
    'package.json',
    'packages/core/package.json',
  ]);
});
