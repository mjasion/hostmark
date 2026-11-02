// Offline validation of infra/*.tf against the contract constants and the env schema: no network, no account, nothing is deployed.
//   node --import tsx scripts/check-config.ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKOFF_SECONDS,
  DLQ_NAME,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  SCHEDULER_JOBS,
  VISIBILITY_TIMEOUT_SECONDS,
} from '@hostmark/contract';
import { envSchema } from '../src/env';
import { CLIENT_IP_HEADER } from '../src/platform';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns the problems found; empty when the configuration is consistent. */
export function checkConfig(): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  const infra = join(root, 'infra');
  const tf = readdirSync(infra)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(join(infra, f), 'utf8'))
    .join('\n');

  // Queue topology (D17).
  expect(tf.includes(`topic      = "${QUEUE_NAME}"`), `topic must be ${QUEUE_NAME}`);
  expect(tf.includes(`dlq_topic  = "${DLQ_NAME}"`), `dead letter topic must be ${DLQ_NAME}`);
  expect(
    new RegExp(`max_delivery_attempts\\s*=\\s*${MAX_ATTEMPTS}\\b`).test(tf),
    `max_delivery_attempts must be ${MAX_ATTEMPTS}`,
  );
  expect(
    new RegExp(`ack_deadline_seconds\\s*=\\s*${VISIBILITY_TIMEOUT_SECONDS}\\b`).test(tf),
    `ack_deadline_seconds must be ${VISIBILITY_TIMEOUT_SECONDS}`,
  );
  expect(Math.max(...BACKOFF_SECONDS) <= 600, 'a backoff above 600 s does not fit the Pub/Sub ack deadline');
  expect(
    !/retry_policy\s*\{/.test(tf),
    'retry_policy would override the backoff the consumer sets per message',
  );

  // Scheduler (one Cloud Scheduler job per core job; the plan's one-replica rule does not apply).
  for (const [name, cron] of Object.entries(SCHEDULER_JOBS)) {
    expect(
      new RegExp(`"${name}"\\s*=\\s*"${cron.replaceAll('*', '\\*')}"`).test(tf),
      `scheduler job ${name} must run on "${cron}"`,
    );
  }

  // D74.
  expect(/age\s*=\s*8\b/.test(tf), 'bucket lifecycle must expire after 8 days (D74)');
  expect(
    tf.includes('matches_prefix = ["originals/", "variants/"]'),
    'bucket lifecycle must cover originals/ and variants/',
  );

  // D80: the header the app trusts is set by the load balancer and nothing else can reach the api.
  expect(
    tf.includes(`custom_request_headers = ["${CLIENT_IP_HEADER}: {client_ip_address}"]`),
    `the backend service must set ${CLIENT_IP_HEADER} to {client_ip_address}`,
  );
  expect(tf.includes('INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER'), 'the api must only accept the load balancer');
  expect(tf.includes('roles/pubsub.viewer'), 'the runtime account must read the topic for queue.ping (D200)');
  expect(
    !tf.match(/runtime_env = \{([\s\S]*?)\n {2}\}/)?.[1]?.includes('google_compute_url_map'),
    'runtime_env must not depend on the url map (D200)',
  );
  expect(/default_uri_disabled\s*=\s*true/.test(tf), 'the run.app URL must be disabled');

  // D100.
  expect(
    tf.includes('compute.urlMaps.invalidateCache'),
    'the runtime needs invalidateCache for the CDN purge',
  );
  expect(/enable_cdn\s*=\s*true/.test(tf), 'Cloud CDN must be enabled on the backend service');

  // Worker: a fixed count of always-on instances, one job per process (D97).
  expect(/cpu_idle\s*=\s*false/.test(tf), 'the worker needs CPU outside requests (instance-based billing)');
  expect(/WORKER_CONCURRENCY\s*=\s*"1"/.test(tf), 'WORKER_CONCURRENCY must be 1 (D97)');

  // The plain environment of the services must pass the schema together with placeholders for the secrets.
  const plain = Object.fromEntries(
    [...(tf.match(/runtime_env = \{([\s\S]*?)\n {2}\}/)?.[1] ?? '').matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)].map(
      (m) => {
        const value = (m[2] as string).trim();
        // A reference (`var.project`, `google_storage_bucket.media.name`) stands for a value known at apply time.
        return [
          m[1] as string,
          value.startsWith('"') ? value.slice(1, -1).replace(/\$\{[^}]*\}/g, 'example') : 'example',
        ];
      },
    ),
  );
  const parsed = envSchema.safeParse({
    ...plain,
    PUBLIC_URL: 'https://example.test',
    S3_ENDPOINT: plain.S3_ENDPOINT,
    S3_BUCKET: 'example-bucket',
    DATABASE_URL: 'postgres://example',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    S3_ACCESS_KEY_ID: 'example',
    S3_SECRET_ACCESS_KEY: 'example',
  });
  expect(
    parsed.success,
    `environment of the services fails the schema: ${parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`,
  );

  // No secret in the repository.
  expect(!/BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{20,}/.test(tf), 'infra/ holds key material');
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkConfig();
  if (problems.length > 0) {
    console.error(`infra/ is inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('infra/ matches the contract constants and the env schema');
}
