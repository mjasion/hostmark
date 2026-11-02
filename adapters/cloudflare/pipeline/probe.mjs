// HTTP sampler for the rollout. Requests go to /api/health. With `override` set, the version-overrides header pins
// them to one Worker version, so the candidate is measured even while it serves only a few percent of the traffic.
// A response counts as an error unless it is 200 and reports the expected version (the commit SHA in `x-version`).

/** @param {number[]} values */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * @param {{
 *   baseUrl: string, count: number, intervalMs?: number, timeoutMs?: number,
 *   workerName?: string, override?: string, expectVersion?: string,
 *   fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} input
 * @returns {Promise<{ samples: number, errors: number, p95Ms: number }>}
 */
export async function runProbe({
  baseUrl,
  count,
  intervalMs = 200,
  timeoutMs = 5000,
  workerName,
  override,
  expectVersion,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
}) {
  if (!/^https:\/\/[^\s/]+$/.test(baseUrl)) throw new Error('probe base URL must be an https origin');
  const headers = { accept: 'application/json' };
  if (override) {
    if (!workerName) throw new Error('workerName is required with a version override');
    headers['cloudflare-workers-version-overrides'] = `${workerName}="${override}"`;
  }
  const latencies = [];
  let errors = 0;
  for (let i = 0; i < count; i++) {
    const started = now();
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      await response.arrayBuffer().catch(() => undefined);
      const wrongVersion = expectVersion !== undefined && response.headers.get('x-version') !== expectVersion;
      if (response.status !== 200 || wrongVersion) errors++;
    } catch {
      errors++;
    }
    latencies.push(now() - started);
    if (i < count - 1) await sleep(intervalMs);
  }
  return { samples: count, errors, p95Ms: percentile(latencies, 95) };
}

/** Sums two readings (candidate-pinned and unpinned) into one; a missing one makes the result missing. */
export function combine(a, b) {
  if (!a || !b) return undefined;
  return { samples: a.samples + b.samples, errors: a.errors + b.errors, p95Ms: Math.max(a.p95Ms, b.p95Ms) };
}
