// Gradual production rollout with automatic rollback (D142). Everything that decides is a pure function; the one
// orchestrator takes `exec`, `probe` and `sleep` as arguments, so the tests run it against fakes and no Cloudflare
// account is ever touched.

export const DEFAULT_POLICY = Object.freeze({
  steps: [10, 50, 100],
  soakMs: 120_000,
  minSamples: 20,
  maxErrorRate: 0.01,
  maxP95Ms: 1500,
});

/**
 * One health reading. Anything missing, non-numeric or inconsistent is "no signal", and no signal means rollback:
 * a rollout that cannot see its own health must not go on (fail safe).
 *
 * @param {unknown} signal `{ samples, errors, p95Ms }`
 * @returns {{ action: 'promote' | 'rollback', reason: string }}
 */
export function decide(signal, policy = DEFAULT_POLICY) {
  if (signal === null || typeof signal !== 'object') return rollback('no health signal');
  const { samples, errors, p95Ms } = /** @type {Record<string, unknown>} */ (signal);
  if (!Number.isInteger(samples) || !Number.isInteger(errors) || !Number.isFinite(p95Ms)) {
    return rollback('health signal is malformed');
  }
  if (samples < 0 || errors < 0 || errors > samples || p95Ms < 0)
    return rollback('health signal is inconsistent');
  if (samples < policy.minSamples) return rollback(`only ${samples} samples, need ${policy.minSamples}`);
  const rate = errors / samples;
  if (rate > policy.maxErrorRate)
    return rollback(`error rate ${(rate * 100).toFixed(2)}% above ${policy.maxErrorRate * 100}%`);
  if (p95Ms > policy.maxP95Ms) return rollback(`p95 ${Math.round(p95Ms)} ms above ${policy.maxP95Ms} ms`);
  return { action: 'promote', reason: `${samples} samples, ${errors} errors, p95 ${Math.round(p95Ms)} ms` };
}

/** `decide` that can never throw and never leave the decision open. */
export function decideSafe(signal, policy) {
  try {
    return decide(signal, policy);
  } catch (error) {
    return rollback(`decision failed: ${error?.message ?? error}`);
  }
}

function rollback(reason) {
  return { action: 'rollback', reason };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isVersionId = (value) => typeof value === 'string' && UUID.test(value);

/** `WRANGLER_OUTPUT_FILE_PATH` is newline-delimited JSON, one object per event. Bad lines are skipped. */
export function parseOutputFile(text) {
  const entries = [];
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      if (entry !== null && typeof entry === 'object') entries.push(entry);
    } catch {
      // A partial line from an interrupted write is not an entry.
    }
  }
  return entries;
}

/** The id `wrangler versions upload` printed, or null when the output has none. */
export function uploadedVersionId(entries) {
  const found = entries.filter((e) => e.type === 'version-upload' && isVersionId(e.version_id));
  return found.length === 0 ? null : found[found.length - 1].version_id;
}

/**
 * The version that serves 100% of production traffic now, from `wrangler deployments list --json`. Tolerant of the
 * shape (an array, or `{ deployments }`), strict about the result: null unless exactly one version holds 100%.
 */
export function activeVersionId(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.deployments) ? json.deployments : null;
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a, b) =>
    String(a?.created_on ?? '').localeCompare(String(b?.created_on ?? '')),
  );
  const latest = sorted[sorted.length - 1];
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const full = versions.filter((v) => v?.percentage === 100 && isVersionId(v.version_id));
  return versions.length === 1 && full.length === 1 ? full[0].version_id : null;
}

/** Arguments of `wrangler versions deploy` for a split between the candidate and the stable version. */
export function deployArgs({ candidate, stable, percent, message, config }) {
  if (!/^wrangler\.[a-z]+\.jsonc$/.test(config ?? ''))
    throw new Error('config must be a wrangler.<role>.jsonc file name');
  if (!isVersionId(candidate) || !isVersionId(stable)) throw new Error('version ids must be UUIDs');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('percent must be 0..100');
  const split =
    percent === 100
      ? [`${candidate}@100`]
      : percent === 0
        ? [`${stable}@100`]
        : [`${candidate}@${percent}`, `${stable}@${100 - percent}`];
  return ['wrangler', 'versions', 'deploy', ...split, '--config', config, '--yes', '--message', message];
}

/**
 * The version serving 100% of production traffic for `config`, from `wrangler deployments list`. Null when the command
 * fails, prints something unreadable, or no single version holds 100%.
 */
export async function servingVersion(exec, config) {
  const listed = await exec(['wrangler', 'deployments', 'list', '--config', config, '--json']).catch(() => ({
    code: 1,
    stdout: '',
  }));
  if (listed.code !== 0) return null;
  try {
    return activeVersionId(JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))));
  } catch {
    return null;
  }
}

/**
 * Puts `stable` back at 100%. Used after a run that failed or was cancelled, so that production does not stay on a
 * split or on a version nobody verified. Does nothing when `stable` already serves everything (a rollout that
 * rolled itself back, or one that never started). If the listing is unclear it deploys anyway: `stable` is the known
 * good version.
 *
 * @returns {Promise<{ outcome: 'already-stable' | 'restored' | 'failed', reason?: string }>}
 */
export async function restoreStable({ exec, config, stable, message }) {
  if (!isVersionId(stable)) return { outcome: 'failed', reason: 'no valid stable version id was recorded' };
  if ((await servingVersion(exec, config)) === stable) return { outcome: 'already-stable' };
  const result = await exec(deployArgs({ candidate: stable, stable, percent: 0, message, config })).catch(
    (e) => ({ code: 1, stdout: String(e?.message ?? e) }),
  );
  return result.code === 0
    ? { outcome: 'restored' }
    : { outcome: 'failed', reason: `versions deploy exited ${result.code}` };
}

/**
 * @param {{
 *   exec: (args: string[]) => Promise<{ code: number, stdout: string }>,
 *   probe?: (target: { candidate: string, percent: number }) => Promise<unknown>,
 *   verify?: () => Promise<{ ok: boolean, detail?: string }>,
 *   sleep: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   candidate: string, stable: string, sha: string, config: string, policy?: typeof DEFAULT_POLICY,
 * }} input
 * @returns {Promise<{ outcome: 'promoted' | 'rolled-back' | 'rollback-failed', reason: string, reached: number }>}
 */
export async function runRollout({
  exec,
  probe,
  verify,
  sleep,
  log = () => {},
  candidate,
  stable,
  sha,
  config,
  policy = DEFAULT_POLICY,
}) {
  if (!probe && !verify)
    throw new Error('a rollout needs a probe or a verification: refusing to promote blind');
  let reached = 0;

  async function back(reason) {
    log(`rollback: ${reason}`);
    let result;
    try {
      result = await exec(
        deployArgs({ candidate, stable, percent: 0, message: `rollback of ${sha}`, config }),
      );
    } catch (error) {
      result = { code: 1, stdout: String(error?.message ?? error) };
    }
    if (result.code !== 0) {
      return {
        outcome: 'rollback-failed',
        reason: `${reason}; the rollback itself failed (exit ${result.code})`,
        reached,
      };
    }
    return { outcome: 'rolled-back', reason, reached };
  }

  for (const percent of policy.steps) {
    const deployed = await exec(
      deployArgs({ candidate, stable, percent, message: `gradual ${percent}% ${sha}`, config }),
    ).catch((e) => ({
      code: 1,
      stdout: String(e?.message ?? e),
    }));
    if (deployed.code !== 0) return back(`deploying ${percent}% failed (exit ${deployed.code})`);
    reached = percent;
    log(`${percent}% deployed, soaking ${policy.soakMs} ms`);
    await sleep(policy.soakMs);
    // A Worker without an HTTP surface (the queue consumer) has no probe; `verify` below is then its only gate.
    if (probe) {
      const signal = await probe({ candidate, percent }).catch(() => undefined);
      const verdict = decideSafe(signal, policy);
      log(`${percent}%: ${verdict.action} (${verdict.reason})`);
      if (verdict.action === 'rollback') return back(`at ${percent}%: ${verdict.reason}`);
    }
  }

  if (verify) {
    const verdict = await verify().catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
    if (verdict?.ok !== true)
      return back(`post-deploy verification failed: ${verdict?.detail ?? 'no result'}`);
  }
  return { outcome: 'promoted', reason: 'all steps healthy', reached };
}
