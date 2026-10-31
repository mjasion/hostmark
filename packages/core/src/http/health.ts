import type { DependencyCheck } from '@hostmark/contract';

/** Bounded probe: a hung dependency must not hang the endpoint. Errors are summarised, never echoed. */
export async function probe(fn: () => Promise<unknown>, timeoutMs: number): Promise<DependencyCheck> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { status: 'ok', latencyMs: latency() };
  } catch (err) {
    const timedOut = err instanceof Error && err.message === 'timeout';
    return { status: 'down', latencyMs: latency(), error: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
