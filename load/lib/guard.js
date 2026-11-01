// Safety guard. No k6 and no Node imports: k6 scenarios, run.mjs and the Playwright specs all load this file.
// A run against anything but this machine needs a named acknowledgement, and the two scenarios that can cost real
// money (S5, S6) need a second one (spec: budgets and billing alerts before the first S5 and S6).

/** Scenarios that need LOAD_ACK_BUDGETS on a non-loopback target. */
export const BUDGET_SCENARIOS = ['S5', 'S6'];

const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `new URL` does not exist in k6, so this is a small parser. Anything it cannot read is refused. */
export function parseBaseUrl(raw) {
  const m = /^(https?):\/\/([^/?#@]*@)?(\[[0-9a-fA-F:.]+\]|[^/:?#@\s]+)(?::(\d{1,5}))?(\/[^?#]*)?$/.exec(
    raw ?? '',
  );
  if (!m) throw new Error(`BASE_URL is not a plain http(s) URL: ${JSON.stringify(raw)}`);
  if (m[2]) throw new Error('BASE_URL must not carry credentials');
  const host = (m[3] ?? '').toLowerCase();
  return { protocol: m[1], host, port: m[4] ?? '', hostWithPort: m[4] ? `${host}:${m[4]}` : host };
}

/**
 * Only the literal loopback names count. `127.0.0.1.example.com`, `localhost.evil.test`, `0.0.0.0` and a
 * shorthand such as `127.1` are not loopback, so they fall on the safe side and need the acknowledgement.
 */
export function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const m = LOOPBACK_V4.exec(h);
  return Boolean(m?.slice(1).every((octet) => Number(octet) <= 255));
}

/**
 * The host of the purge call. PURGE_URL carries a token (PURGE_TOKEN), so it is held to the same rule as BASE_URL:
 * with a loopback target it must be loopback, with a remote target it must be the target's own host or be
 * acknowledged by name in LOAD_ACK_PURGE_HOST.
 */
export function purgeProblems({ baseUrl, env, targetHost, loopback }) {
  if (!env.PURGE_URL) return [];
  let host;
  try {
    const expanded = env.PURGE_URL.replaceAll('{base}', baseUrl)
      .replaceAll('{id}', 'x')
      .replace(/[?#].*$/, '');
    host = parseBaseUrl(expanded).host;
  } catch (err) {
    return [`PURGE_URL: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (loopback) {
    return isLoopbackHost(host)
      ? []
      : [
          `PURGE_URL host ${host} is not loopback, but the target is: the purge token would leave this machine`,
        ];
  }
  if (host === targetHost || env.LOAD_ACK_PURGE_HOST === host) return [];
  return [
    `PURGE_URL host ${host} is not the target host ${targetHost}: set LOAD_ACK_PURGE_HOST=${host} to send PURGE_TOKEN there`,
  ];
}

/**
 * @param {{ baseUrl: string, scenario: string, env: Record<string, string | undefined> }} input
 * @returns {{ loopback: boolean, host: string, problems: string[] }}
 */
export function checkGuard({ baseUrl, scenario, env }) {
  const problems = [];
  let parsed;
  try {
    parsed = parseBaseUrl(baseUrl);
  } catch (err) {
    return { loopback: false, host: '', problems: [err instanceof Error ? err.message : String(err)] };
  }
  const loopback = isLoopbackHost(parsed.host);
  problems.push(...purgeProblems({ baseUrl, env, targetHost: parsed.host, loopback }));
  if (!loopback) {
    // Results of a remote run must say which platform and region they describe: nothing is inferred.
    for (const name of ['REGION', 'VARIANT']) {
      if (!env[name])
        problems.push(`${name} is required for a non-loopback target, so the result names what it measured`);
    }
    // The value must be the host itself, so a variable left over from an earlier target cannot approve a new one.
    if (env.LOAD_ACK_REMOTE !== parsed.host) {
      problems.push(
        `BASE_URL host ${parsed.host} is not loopback: set LOAD_ACK_REMOTE=${parsed.host} to run load against it`,
      );
    }
    if (BUDGET_SCENARIOS.includes(scenario) && env.LOAD_ACK_BUDGETS !== 'yes') {
      problems.push(
        `${scenario} can generate cost on a platform: set LOAD_ACK_BUDGETS=yes once budgets and billing alerts are set`,
      );
    }
  }
  return { loopback, host: parsed.host, problems };
}

/** A presigned URL from a loopback target must stay on loopback, so a local run never reaches another host. */
export function uploadUrlAllowed(uploadUrl, loopbackTarget) {
  if (!loopbackTarget) return true;
  try {
    return isLoopbackHost(parseBaseUrl(uploadUrl.replace(/[?#].*$/, '')).host);
  } catch {
    return false;
  }
}
