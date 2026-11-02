// Creates and removes everything one pull request's preview owns. `exec` and the Neon client are arguments, so the
// tests drive both with fakes. Cloudflare resources are named from the pull request number only (preview-config.mjs),
// and every delete is by exact name, so cleanup cannot touch a resource the preview did not create.

import { deletePreviewBranch, ensurePreviewBranch } from './neon.mjs';
import { hyperdriveIdFromList, hyperdriveIdFromOutput, previewResources } from './preview-config.mjs';

const ALREADY = /already exist/i;
const ABSENT = /not found|does not exist|no such|could not be found/i;

/**
 * @typedef {(args: string[], options?: { env?: Record<string, string> }) => Promise<{ code: number, stdout: string }>} Exec
 * `args` are the arguments of the command named by `wrangler` or `pnpm` in the first element.
 */

/**
 * @param {{ exec: Exec, neon: any, bases: Record<string, any>[], pr: number, neonEnv: { parentId: string, database: string, role: string }, log?: (line: string) => void }} input
 * @returns {Promise<{ hyperdriveId: string, branch: string, resources: ReturnType<typeof previewResources> }>}
 */
export async function provisionPreview({ exec, neon, bases, pr, neonEnv, log = () => {} }) {
  const resources = previewResources(bases, pr);

  const branch = await ensurePreviewBranch(neon, { pr, ...neonEnv });
  log(`database branch ${branch.name} ${branch.created ? 'created' : 'reused'}`);
  for (const secret of [branch.direct, branch.pooled]) {
    log(`::add-mask::${secret}`);
    // The runner masks exact strings only: the password alone must be masked too, or a log line quoting it leaks.
    const password = URL.canParse(secret) ? decodeURIComponent(new URL(secret).password) : '';
    if (password) log(`::add-mask::${password}`);
  }

  const migrated = await exec(['pnpm', '--filter', '@hostmark/db', 'run', 'migrate'], {
    env: { DATABASE_URL: branch.direct },
  });
  if (migrated.code !== 0) throw new Error(`migrating the preview database failed (exit ${migrated.code})`);

  for (const queue of resources.queues) {
    const made = await exec(['wrangler', 'queues', 'create', queue]);
    if (made.code !== 0 && !ALREADY.test(made.stdout))
      throw new Error(`creating queue ${queue} failed (exit ${made.code})`);
  }

  // Hyperdrive wants the direct (unpooled) endpoint: it pools by itself.
  const listed = await exec(['wrangler', 'hyperdrive', 'list']);
  if (listed.code !== 0) throw new Error(`listing Hyperdrive configs failed (exit ${listed.code})`);
  let hyperdriveId = hyperdriveIdFromList(listed.stdout, resources.hyperdrive);
  if (hyperdriveId) {
    const updated = await exec([
      'wrangler',
      'hyperdrive',
      'update',
      hyperdriveId,
      '--connection-string',
      branch.direct,
      // D106: Hyperdrive's query cache is never invalidated by writes.
      '--caching-disabled',
    ]);
    if (updated.code !== 0) throw new Error(`updating the Hyperdrive config failed (exit ${updated.code})`);
  } else {
    const created = await exec([
      'wrangler',
      'hyperdrive',
      'create',
      resources.hyperdrive,
      '--connection-string',
      branch.direct,
      '--caching-disabled',
    ]);
    if (created.code !== 0) throw new Error(`creating the Hyperdrive config failed (exit ${created.code})`);
    hyperdriveId = hyperdriveIdFromOutput(created.stdout);
    if (!hyperdriveId)
      throw new Error('could not read the id of the new Hyperdrive config from wrangler output');
  }
  return { hyperdriveId, branch: branch.name, resources };
}

/**
 * Removes the Workers, queues, Hyperdrive config and database branch of a pull request. Every step runs even when an
 * earlier one failed, a resource that is already gone counts as removed, and any real failure makes the whole
 * call throw at the end, listing what is left.
 *
 * @param {{ exec: Exec, neon: any, bases: Record<string, any>[], pr: number, log?: (line: string) => void }} input
 */
export async function teardownPreview({ exec, neon, bases, pr, log = () => {} }) {
  const resources = previewResources(bases, pr);
  const left = [];

  async function step(what, run) {
    try {
      const outcome = await run();
      log(`${what}: ${outcome}`);
    } catch (error) {
      log(`${what}: FAILED ${error.message}`);
      left.push(`${what} (${error.message})`);
    }
  }

  const tolerant = async (args) => {
    const result = await exec(args);
    if (result.code === 0) return 'removed';
    if (ABSENT.test(result.stdout)) return 'already gone';
    throw new Error(`exit ${result.code}`);
  };

  for (const worker of resources.workers) {
    await step(`worker ${worker}`, () => tolerant(['wrangler', 'delete', worker, '--force']));
  }
  for (const queue of resources.queues) {
    await step(`queue ${queue}`, () => tolerant(['wrangler', 'queues', 'delete', queue]));
  }
  await step(`hyperdrive ${resources.hyperdrive}`, async () => {
    const listed = await exec(['wrangler', 'hyperdrive', 'list']);
    if (listed.code !== 0) throw new Error(`list exit ${listed.code}`);
    const id = hyperdriveIdFromList(listed.stdout, resources.hyperdrive);
    if (!id) return 'already gone';
    return tolerant(['wrangler', 'hyperdrive', 'delete', id]);
  });
  await step(
    `database branch preview/pr-${pr}`,
    async () => (await deletePreviewBranch(neon, { pr })).reason,
  );

  if (left.length > 0)
    throw new Error(`preview of pull request ${pr} is not fully removed: ${left.join('; ')}`);
  return resources;
}
