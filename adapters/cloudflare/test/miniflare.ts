import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { type BuiltName, buildDir, workerDir } from './build';

export const COMPATIBILITY_DATE = '2026-08-06';

type Worker = NonNullable<MiniflareOptions['workers']>[number];

/**
 * A built production Worker (`api`, `consumer`, `scheduler`, `image-service`) with the given bindings added. The
 * modules are listed by hand: Miniflare's module scan refuses the computed `import()` in a Better Auth adapter that
 * the Worker never reaches, and wrangler does not scan.
 */
export function builtWorker(name: BuiltName, extra: Partial<Worker> & { name: string }): Worker {
  const dir = workerDir(name);
  const files = readdirSync(dir);
  const typeOf = (file: string) =>
    file.endsWith('.wasm') ? 'CompiledWasm' : file.endsWith('.txt') ? 'Text' : 'ESModule';
  const modules = files
    .filter((f) => /\.(js|wasm|txt)$/.test(f))
    .sort((a, b) => (a === `${name}.js` ? -1 : b === `${name}.js` ? 1 : a.localeCompare(b)))
    .map((file) => ({ type: typeOf(file), path: join(dir, file) }));
  return {
    modules,
    modulesRoot: dir,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    ...extra,
  } as Worker;
}

/** A test fixture Worker from `.build/test/fixtures`. */
export function fixtureWorker(file: string, extra: Partial<Worker> & { name: string }): Worker {
  return {
    modules: true,
    script: readFileSync(join(buildDir, 'fixtures', `${file}.js`), 'utf8'),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    ...extra,
  } as Worker;
}

export function newMiniflare(workers: Worker[], persistRoot?: string): Miniflare {
  return new Miniflare({
    workers,
    ...(persistRoot ? { defaultPersistRoot: persistRoot } : {}),
  } as MiniflareOptions);
}
