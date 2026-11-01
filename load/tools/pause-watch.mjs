// Host pause watcher. A laptop that sleeps freezes Docker and every process on it, and the run then measures the sleep.
// Timers fire late after a wake, so a tick that arrives far later than it was due is the evidence. This runs as a child
// process of run.mjs, so nothing in the runner (a blocking `docker` call, say) can delay the ticks.
//
//   node load/tools/pause-watch.mjs    # prints one JSON line with the pauses when stdin closes
import { fileURLToPath } from 'node:url';

/** Records ticks and keeps the gaps between them that are longer than `minGapS`. */
export function gapRecorder(minGapS = 5, start = Date.now()) {
  const pauses = [];
  let last = start;
  return {
    pauses,
    tick(now = Date.now()) {
      if ((now - last) / 1000 > minGapS)
        pauses.push({
          atS: Math.round((last - start) / 100) / 10,
          gapS: Math.round((now - last) / 100) / 10,
        });
      last = now;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const recorder = gapRecorder(Number(process.env.PAUSE_MIN_GAP_S ?? 5));
  const timer = setInterval(() => recorder.tick(), 1000);
  const finish = () => {
    clearInterval(timer);
    recorder.tick();
    process.stdout.write(`${JSON.stringify({ pauses: recorder.pauses })}\n`, () => process.exit(0));
  };
  // stdin closes when the runner asks for the result, and also when the runner dies, so the watcher never outlives it.
  process.stdin.resume();
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
}
