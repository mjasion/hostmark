const BLOCK_BYTES = 64 * 1024;
const YIELD_EVERY = 16;

/** Chained SHA-256 over a 64 KiB block for `ms` milliseconds (D11), yielding so timers and I/O still run. */
export async function burnCpu(ms: number): Promise<{ elapsedMs: number; iterations: number; hash: string }> {
  const block = new Uint8Array(BLOCK_BYTES);
  crypto.getRandomValues(block);
  let digest = new Uint8Array(32);
  let iterations = 0;
  const started = performance.now();
  while (performance.now() - started < ms) {
    block.set(digest, 0);
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
    iterations++;
    if (iterations % YIELD_EVERY === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return {
    elapsedMs: performance.now() - started,
    iterations,
    hash: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}
