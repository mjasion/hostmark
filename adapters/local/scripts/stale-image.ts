// Detects a smoke run against an image that does not match the tree (D203). The smoke test never builds (D132), so
// without this check a stale `hostmark-local:dev`, or containers still running an older image than the tag, pass
// silently.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export const IMAGE = 'hostmark-local:dev';
/** Compose services that run the app image and stay up. The one-shot jobs exit and are not checked. */
export const APP_SERVICES = ['api', 'worker', 'scheduler'] as const;

/**
 * Files of the build context that cannot change the image: documentation, tests and test fixtures, and the
 * directories `.dockerignore` keeps out. A change to one of them does not make the image stale.
 */
export function affectsImage(path: string): boolean {
  if (/^(docs|load|\.github|\.claude)\//.test(path)) return false;
  if (/(^|\/)(test|e2e|__tests__)\//.test(path)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/\.md$/i.test(path)) return false;
  if (/(^|\/)(node_modules|dist|coverage|test-results|playwright-report)\//.test(path)) return false;
  if (/(^|\/)\.env(\.|$)/.test(path) && !path.endsWith('.env.example')) return false;
  return true;
}

export interface StaleInput {
  imageId: string;
  /** Creation time of the image, epoch milliseconds. */
  imageCreated: number;
  /** Image id per running app container. */
  containers: { service: string; image: string }[];
  /** Files of the tree that go into the image, with their modification time in epoch milliseconds. */
  files: { path: string; mtime: number }[];
}

/** Problems that make the running stack differ from the tree; empty when the stack is current. */
export function staleProblems(input: StaleInput): string[] {
  const problems: string[] = [];
  for (const c of input.containers) {
    if (c.image !== input.imageId)
      problems.push(
        `${c.service} runs ${short(c.image)}, not the current ${IMAGE} (${short(input.imageId)})`,
      );
  }
  const newer = input.files
    .filter((f) => affectsImage(f.path) && f.mtime > input.imageCreated)
    .sort((a, b) => b.mtime - a.mtime);
  if (newer.length > 0) {
    const names = newer.slice(0, 3).map((f) => f.path);
    const more = newer.length > 3 ? ` and ${newer.length - 3} more` : '';
    problems.push(`${IMAGE} is older than ${names.join(', ')}${more}`);
  }
  return problems;
}

function short(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function run(cmd: string, args: string[], cwd: string): string {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Reads the image, the running app containers and the tree's files. `stackDir` is `adapters/local`. */
export function readStaleInput(stackDir: string): StaleInput {
  const [imageId = '', created = ''] = run(
    'docker',
    ['image', 'inspect', IMAGE, '--format', '{{.Id}} {{.Created}}'],
    stackDir,
  )
    .trim()
    .split(' ');
  const containers: StaleInput['containers'] = [];
  for (const service of APP_SERVICES) {
    const ids = run('docker', ['compose', 'ps', '-q', service], stackDir).trim().split('\n').filter(Boolean);
    for (const id of ids) {
      containers.push({
        service,
        image: run('docker', ['inspect', id, '--format', '{{.Image}}'], stackDir).trim(),
      });
    }
  }
  const root = run('git', ['rev-parse', '--show-toplevel'], stackDir).trim();
  const paths = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
    .split('\0')
    .filter(Boolean);
  const files: StaleInput['files'] = [];
  for (const path of paths) {
    try {
      files.push({ path, mtime: statSync(join(root, path)).mtimeMs });
    } catch {
      // Deleted in the working tree but still in the index: the image may still carry it.
      files.push({ path, mtime: Number.POSITIVE_INFINITY });
    }
  }
  return { imageId, imageCreated: Date.parse(created), containers, files };
}
