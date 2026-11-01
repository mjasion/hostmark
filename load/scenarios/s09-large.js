// S9: large file. Phase "png": PNG_UPLOADS uploads of a 10 MB PNG (1826 x 1826), one at a time, each waited for.
// Phase "stream" (D79): STREAM_UPLOADS maximum-size images sent back to back so the worker never idles, cycling
// through the four inputs D79 measured (50 MP JPEG, 16-bit PNG, WebP, tall PNG, each about 49 to 50 MP). The memory
// peak (cgroup), restarts and attempts of that phase are read from the stack by run.mjs, because k6 cannot see them.
// Every file of the stream must reach `ready` and every upload must have been sent, or the run fails.
import { sleep } from 'k6';
import { Gauge, Rate } from 'k6/metrics';
import { waitTerminal } from '../lib/api.js';
import { assertAllowed, requireKey } from '../lib/config.js';
import { loadFixture, tokenOf } from '../lib/fixtures.js';
import { param, seconds } from '../lib/params.js';
import { baseOptions, errorGates, makeHandleSummary, newestFile, setupCommon } from '../lib/scenario.js';
import { outcomeThresholds, uploadOnce, uploadToReady } from '../lib/upload.js';

assertAllowed('S9');
const pngUploads = param('PNG_UPLOADS', 5, 1);
const streamUploads = param('STREAM_UPLOADS', 24, 6);
const streamWait = param('STREAM_WAIT', '15m', '15m');
const png = loadFixture('png-10mb.png');
const MIX = ['jpeg-50mp.jpg', 'png16-49mp.png', 'webp-49mp.webp', 'png-tall-49mp.png'];
const mix = MIX.map((name) => loadFixture(name));
const streamSeconds = new Gauge('stream_seconds');
// One sample per file that was sent (true only when it reached `ready`), and one for the stream as a whole.
const streamFileReady = new Rate('stream_file_ready');
const streamSentAll = new Rate('stream_sent_all');

export const options = baseOptions({
  scenarios: {
    large: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '40m' },
  },
  thresholds: {
    ...outcomeThresholds(),
    ...errorGates({ scenario: 'large' }),
    'upload_ok{phase:png}': ['rate==1'],
    'upload_ok{phase:stream}': ['rate==1'],
    stream_file_ready: ['rate==1'],
    stream_sent_all: ['rate==1'],
    'upload_to_ready_ms{phase:png}': ['p(95)<120000'],
    'upload_to_ready_ms{phase:stream}': ['p(95)<600000'],
    'upload_total_ms{phase:png}': ['avg>=0'],
    'upload_bytes{phase:png}': ['count>=0'],
    'upload_bytes{phase:stream}': ['count>=0'],
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S9', { key });
  data.boundary = newestFile(key)?.id ?? null;
  return data;
}

export default function (data) {
  const key = requireKey();
  for (let i = 0; i < pngUploads; i++) {
    uploadOnce({
      key,
      fixture: png,
      token: tokenOf(data.runId, 'p9', i),
      timeoutMs: 300000,
      intervalS: 1,
      tags: { phase: 'png' },
    });
  }
  const started = Date.now();
  const ids = [];
  const kinds = {};
  for (let i = 0; i < streamUploads; i++) {
    const fixture = mix[i % mix.length];
    const r = uploadOnce({
      key,
      fixture,
      token: tokenOf(data.runId, 'x9', i),
      wait: false,
      tags: { phase: 'stream' },
    });
    kinds[fixture.name] ??= { sent: 0, ready: 0 };
    if (r.id && r.outcome === 'complete_ok') {
      ids.push({ id: r.id, name: fixture.name });
      kinds[fixture.name].sent++;
    }
  }
  streamSentAll.add(ids.length === streamUploads);
  let ready = 0;
  for (const { id, name } of ids) {
    const { file } = waitTerminal(key, id, { timeoutMs: seconds(streamWait) * 1000, intervalS: 1 });
    const ok = file?.status === 'ready';
    streamFileReady.add(ok);
    if (ok) {
      ready++;
      kinds[name].ready++;
      if (file.queuedAt && file.readyAt)
        uploadToReady.add(Date.parse(file.readyAt) - Date.parse(file.queuedAt), { phase: 'stream' });
    }
    sleep(0);
  }
  streamSeconds.add(Math.round((Date.now() - started) / 1000));
  console.log(
    `HM_EVENT ${JSON.stringify({ type: 'stream', planned: streamUploads, sent: ids.length, ready, kinds, seconds: Math.round((Date.now() - started) / 1000) })}`,
  );
}

export const handleSummary = makeHandleSummary({
  id: 'S9',
  title: 'Large file: 10 MB PNG, then a stream of maximum-size images',
  scope: 'large',
  local:
    'Measures the memory of one worker process under maximum-size inputs (D79): the result lists the cgroup memory peak per worker replica, restarts, OOMKilled and attempts read from the stack, taken on freshly restarted workers. The worker has mem_limit 4g per replica and no swap; each replica runs one job at a time (D97), so the peak is that of one process. Processing time is the wall time of one 10 MB decode and three resizes with no cold start. The stream phase goes beyond the specification (D79 documents why).',
  extra: (data, setup) => {
    const planned = streamUploads;
    // Only the stream sends without waiting, so its accepted uploads are the complete_ok outcomes.
    const sent = data.metrics['upload_outcome{outcome:complete_ok}']?.values.count;
    const failures = [];
    // Everything that was planned must have been accepted: a stream that stopped early proves nothing.
    if ((sent ?? 0) !== planned) failures.push(`stream sent ${sent ?? 0} of ${planned} planned uploads`);
    return {
      failures,
      phases: {
        png: 'one 10 MB PNG at a time, waited for',
        stream: `maximum-size images back to back (${MIX.join(', ')})`,
      },
      boundary: setup.boundary ?? null,
    };
  },
});
