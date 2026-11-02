import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateGate, isSameRepository, runGate } from '../gate.mjs';

const file = (platforms) => JSON.stringify({ platforms });
const cf = (extra) => ({ name: 'cloudflare', enabled: false, status: 'emulated', ...extra });

test('the committed platforms.json keeps Cloudflare off', () => {
  const text = readFileSync(new URL('../../../../platforms.json', import.meta.url), 'utf8');
  assert.equal(evaluateGate(text).enabled, false);
  assert.equal(evaluateGate(text, { requireDeployed: true }).enabled, false);
});

test('disabled platform is disabled', () => {
  assert.equal(evaluateGate(file([cf()])).enabled, false);
});

test('only the literal boolean true enables', () => {
  for (const value of ['true', 1, 'yes', null, undefined, [], {}, 'TRUE']) {
    assert.equal(evaluateGate(file([cf({ enabled: value })])).enabled, false, JSON.stringify(value));
  }
  assert.equal(evaluateGate(file([cf({ enabled: true })])).enabled, true);
});

test('unreadable, malformed or unexpected files fail closed', () => {
  for (const text of [
    undefined,
    '',
    '{',
    'null',
    '[]',
    '{}',
    '{"platforms":{}}',
    '{"platforms":"cloudflare"}',
    '{"platforms":[null,1,"x"]}',
  ]) {
    assert.equal(evaluateGate(text).enabled, false, String(text));
  }
});

test('unlisted and duplicated entries fail closed', () => {
  assert.equal(evaluateGate(file([{ name: 'gcp', enabled: true }])).enabled, false);
  assert.equal(evaluateGate(file([cf({ enabled: true }), cf({ enabled: true })])).enabled, false);
  assert.equal(evaluateGate(file([cf({ enabled: false }), cf({ enabled: true })])).enabled, false);
});

test('production needs status deployed on top of enabled', () => {
  const on = file([cf({ enabled: true, status: 'emulated' })]);
  assert.equal(evaluateGate(on).enabled, true);
  assert.equal(evaluateGate(on, { requireDeployed: true }).enabled, false);
  assert.equal(
    evaluateGate(file([cf({ enabled: true, status: 'deployed' })]), { requireDeployed: true }).enabled,
    true,
  );
});

test('a fork is not the same repository', () => {
  assert.equal(isSameRepository('o/r', 'o/r'), true);
  assert.equal(isSameRepository('evil/r', 'o/r'), false);
  assert.equal(isSameRepository(undefined, 'o/r'), false);
  assert.equal(isSameRepository('', ''), false);
});

function run(text, args = [], { missing = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const input = join(dir, 'platforms.json');
  if (!missing) writeFileSync(input, text);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const lines = [];
  const code = runGate([input, ...args], { env: { GITHUB_OUTPUT: out }, print: (l) => lines.push(l) });
  return { code, output: readFileSync(out, 'utf8'), lines };
}

test('CLI: disabled writes enabled=false and exits 0, so the run stays green', () => {
  const r = run(file([cf()]));
  assert.equal(r.code, 0);
  assert.match(r.output, /^enabled=false$/m);
});

test('CLI: missing file writes enabled=false', () => {
  const r = run('', [], { missing: true });
  assert.equal(r.code, 0);
  assert.match(r.output, /^enabled=false$/m);
});

test('CLI: a fork pull request is disabled even when the platform is on', () => {
  const on = file([cf({ enabled: true })]);
  assert.match(run(on, ['--same-repo', 'o/r', 'o/r']).output, /^enabled=true$/m);
  assert.match(run(on, ['--same-repo', 'fork/r', 'o/r']).output, /^enabled=false$/m);
  assert.match(run(on, ['--same-repo', '', 'o/r']).output, /^enabled=false$/m);
});

test('CLI: a usage error exits 2 and still says disabled', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'out');
  writeFileSync(out, '');
  const code = runGate(['--bogus'], { env: { GITHUB_OUTPUT: out }, print: () => {} });
  assert.equal(code, 2);
  assert.match(readFileSync(out, 'utf8'), /^enabled=false$/m);
});

test('CLI: the reason cannot inject another output line', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'out');
  writeFileSync(out, '');
  runGate(['x\nenabled=true'], { env: { GITHUB_OUTPUT: out }, print: () => {} });
  assert.deepEqual(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('enabled=')),
    ['enabled=false'],
  );
});
