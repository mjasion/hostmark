// The off switch of every Cloudflare workflow (D70, D140). A workflow job that can reach a secret, an account or
// anything that costs money runs only after this gate says `enabled=true`. The gate reads platforms.json from the
// base of the change, never from the pull request, with no dependency and no secret.
//
// Fail closed: a missing or unreadable file, a malformed entry, a duplicate entry or anything but the literal
// boolean `true` means "disabled". Disabled is a normal answer (exit 0), not an error, so a disabled platform
// leaves every run green and every downstream job skipped.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string | undefined} text contents of platforms.json
 * @param {{ platform?: string, requireDeployed?: boolean }} [options]
 * @returns {{ enabled: boolean, reason: string }}
 */
export function evaluateGate(text, { platform = 'cloudflare', requireDeployed = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    return { enabled: false, reason: 'platforms.json is missing or not valid JSON' };
  }
  const list = parsed !== null && typeof parsed === 'object' ? parsed.platforms : undefined;
  if (!Array.isArray(list)) return { enabled: false, reason: 'platforms.json has no "platforms" array' };

  const entries = list.filter((p) => p !== null && typeof p === 'object' && p.name === platform);
  if (entries.length === 0) return { enabled: false, reason: `platform "${platform}" is not listed` };
  if (entries.length > 1)
    return { enabled: false, reason: `platform "${platform}" is listed more than once` };

  const [entry] = entries;
  if (entry.enabled !== true) return { enabled: false, reason: `platform "${platform}" is disabled` };
  if (requireDeployed && entry.status !== 'deployed') {
    return {
      enabled: false,
      reason: `platform "${platform}" is enabled but its status is ${JSON.stringify(entry.status)}, not "deployed"`,
    };
  }
  return { enabled: true, reason: `platform "${platform}" is enabled` };
}

/**
 * A pull request from a fork gets no secrets from GitHub and must never reach them, so the preview gate also
 * requires the head repository to be the base repository. A deleted fork has no head repository: not the same.
 */
export function isSameRepository(headRepo, baseRepo) {
  return (
    typeof headRepo === 'string' && typeof baseRepo === 'string' && baseRepo !== '' && headRepo === baseRepo
  );
}

/**
 * @param {string[]} argv `<platforms.json> [--platform <name>] [--require-deployed] [--same-repo <head> <base>]`
 * @param {{ env?: Record<string, string | undefined>, print?: (line: string) => void }} [io]
 * @returns {number} exit code: 0 for any decision, 2 for a usage error (the outputs then say disabled)
 */
export function runGate(argv, { env = process.env, print = console.log } = {}) {
  const options = { platform: 'cloudflare', requireDeployed: false };
  let file;
  let sameRepo;
  let usage;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') options.platform = argv[++i] ?? '';
    else if (arg === '--require-deployed') options.requireDeployed = true;
    else if (arg === '--same-repo') sameRepo = [argv[++i], argv[++i]];
    else if (!arg.startsWith('--') && file === undefined) file = arg;
    else usage = `unexpected argument ${JSON.stringify(arg)}`;
  }
  if (file === undefined)
    usage =
      'usage: gate <platforms.json> [--platform <name>] [--require-deployed] [--same-repo <head> <base>]';

  let result;
  if (usage) {
    result = { enabled: false, reason: usage };
  } else {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = undefined;
    }
    result = evaluateGate(text, options);
    if (result.enabled && sameRepo && !isSameRepository(sameRepo[0], sameRepo[1])) {
      result = { enabled: false, reason: 'the pull request comes from a fork, which gets no secrets' };
    }
  }

  print(`gate: ${result.enabled ? 'enabled' : 'disabled'} (${result.reason})`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `enabled=${result.enabled}\nreason=${result.reason.replace(/[\r\n]/g, ' ')}\n`,
    );
  }
  return usage ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runGate(process.argv.slice(2));
}
