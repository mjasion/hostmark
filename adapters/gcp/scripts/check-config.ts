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

/** Bodies of every `resource "<type>" "<name>" { ... }` block of that type, by name (braces matched, strings skipped). */
export function resourceBlocks(tf: string, type: string): Map<string, string> {
  return blockBodies(tf, new RegExp(`^resource "${type}" "([\\w-]+)" \\{`, 'gm'));
}

/** Defaults of the `variable` blocks: a string default unquoted, any other default as written, `undefined` without one. */
export function variableDefaults(tf: string): Map<string, string | undefined> {
  const defaults = new Map<string, string | undefined>();
  for (const [name, body] of blockBodies(tf, /^variable "([\w-]+)" \{/gm)) {
    const value = body.match(/^ {2}default\s*=\s*(.+)$/m)?.[1]?.trim();
    defaults.set(name, value?.startsWith('"') ? value.slice(1, -1) : value);
  }
  return defaults;
}

/** The body of `name = { ... }` or `name = merge({ ... }, ...)` in `locals`, up to the first closing brace at its indent. */
function localBlock(tf: string, name: string): string {
  return tf.match(new RegExp(`^ {2}${name} = (?:merge\\()?\\{([\\s\\S]*?)\\n {2}\\}`, 'm'))?.[1] ?? '';
}

function blockBodies(tf: string, header: RegExp): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const m of tf.matchAll(header)) {
    const start = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let inString = false;
    for (let i = start; i < tf.length; i++) {
      const c = tf[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        blocks.set(m[1] as string, tf.slice(start + 1, i));
        break;
      }
    }
  }
  return blocks;
}

/** All of `infra/*.tf` as one text. */
export function readInfra(): string {
  const infra = join(root, 'infra');
  return readdirSync(infra)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(join(infra, f), 'utf8'))
    .join('\n');
}

/** Returns the problems found; empty when the configuration is consistent. */
export function checkConfig(tf: string = readInfra()): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

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
  // Without an expiration policy a subscription is deleted after 31 days without activity; the dead letter reader is
  // idle by design.
  const subscriptions = resourceBlocks(tf, 'google_pubsub_subscription');
  expect(
    subscriptions.has('worker') && subscriptions.has('dlq'),
    'the worker and dlq subscriptions must exist',
  );
  for (const [name, body] of subscriptions)
    expect(
      /expiration_policy\s*\{\s*ttl\s*=\s*""/.test(body),
      `subscription ${name} must never expire (expiration_policy { ttl = "" })`,
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
  // The origin's Cache-Control decides what is cached and for how long (D6: /media a year, immutable). Cloud CDN caps
  // an origin TTL at 30 days by default, and the API refuses default_ttl, max_ttl and client_ttl with USE_ORIGIN_HEADERS.
  const backend = resourceBlocks(tf, 'google_compute_backend_service').get('api') ?? '';
  expect(/cache_mode\s*=\s*"USE_ORIGIN_HEADERS"/.test(backend), 'Cloud CDN must use the origin headers');
  expect(/compression_mode\s*=\s*"AUTOMATIC"/.test(backend), 'Cloud CDN must compress text responses (D208)');
  for (const ttl of ['default_ttl', 'max_ttl', 'client_ttl'])
    expect(
      !new RegExp(`^\\s*${ttl}\\s*=`, 'm').test(backend),
      `${ttl} cannot be set with USE_ORIGIN_HEADERS`,
    );

  // D295: stale copies at most 10 minutes past their TTL (the API default is a day).
  expect(
    /serve_while_stale\s*=\s*600\b/.test(backend),
    'Cloud CDN must serve stale content for at most 600 s',
  );

  // Instance-based billing for both services: the worker pulls between requests, and the api's telemetry exporters and
  // shutdown must not be throttled outside requests (D292).
  const services = resourceBlocks(tf, 'google_cloud_run_v2_service');
  for (const name of ['api', 'worker'])
    expect(
      /cpu_idle\s*=\s*false/.test(services.get(name) ?? ''),
      `the ${name} needs CPU outside requests (cpu_idle = false)`,
    );
  // Worker: a fixed count of always-on instances, one job per process (D97), by manual scaling (D293).
  const worker = services.get('worker') ?? '';
  expect(
    /scaling_mode\s*=\s*"MANUAL"/.test(worker) &&
      /manual_instance_count\s*=\s*var\.worker_instances\b/.test(worker),
    'the worker must scale manually to var.worker_instances',
  );
  expect(
    !/(min|max)_instance_count/.test(worker),
    'manual scaling ignores min and max instance counts; do not set them on the worker',
  );
  expect(/WORKER_CONCURRENCY\s*=\s*"1"/.test(tf), 'WORKER_CONCURRENCY must be 1 (D97)');

  // D294: no allUsers binding; the api skips the invoker check and ingress admits only the load balancer.
  expect(
    /invoker_iam_disabled\s*=\s*true/.test(services.get('api') ?? ''),
    'the api must disable the invoker IAM check',
  );
  expect(!/"allUsers"|"allAuthenticatedUsers"/.test(tf), 'no resource may be granted to allUsers');
  // D294: port 80 redirects to https on the same address.
  const redirectMap = resourceBlocks(tf, 'google_compute_url_map').get('http_redirect') ?? '';
  expect(/https_redirect\s*=\s*true/.test(redirectMap), 'the http url map must redirect to https');
  const rules = resourceBlocks(tf, 'google_compute_global_forwarding_rule');
  expect(
    /port_range\s*=\s*"80"/.test(rules.get('http') ?? '') &&
      /target_http_proxy\.http_redirect\.id/.test(rules.get('http') ?? '') &&
      /ip_address\s*=\s*google_compute_global_address\.lb\.id/.test(rules.get('http') ?? ''),
    'port 80 of the load balancer address must go to the redirect proxy',
  );

  // D295: deleted objects are gone at once (no soft delete).
  expect(
    /soft_delete_policy\s*\{\s*retention_duration_seconds\s*=\s*0\s*\}/.test(
      resourceBlocks(tf, 'google_storage_bucket').get('media') ?? '',
    ),
    'the bucket must keep no soft-deleted objects (retention_duration_seconds = 0)',
  );

  // D297: the APIs behind the service accounts, the custom role and the project lookup.
  for (const api of ['iam.googleapis.com', 'cloudresourcemanager.googleapis.com'])
    expect(tf.includes(`"${api}"`), `${api} must be enabled`);

  // D297: one account per role. The scheduled jobs reach the database and the queue only (D19): no HMAC key, no
  // bucket role, no seed key; only the operator jobs read the seed keys.
  const jobs = resourceBlocks(tf, 'google_cloud_run_v2_job');
  const scheduled = jobs.get('scheduled') ?? '';
  expect(
    /service_account\s*=\s*google_service_account\.jobs\.email/.test(scheduled) &&
      /for_each\s*=\s*local\.jobs_env/.test(scheduled) &&
      /for_each\s*=\s*local\.jobs_secrets/.test(scheduled),
    'the scheduled jobs must run as the jobs account with jobs_env and jobs_secrets',
  );
  expect(
    /service_account\s*=\s*google_service_account\.operator\.email/.test(jobs.get('operator') ?? ''),
    'the operator jobs must run as the operator account',
  );
  const jobsSecrets = localBlock(tf, 'jobs_secrets');
  expect(
    /DATABASE_URL/.test(jobsSecrets) && !/S3_|SEED_|AUTH/.test(jobsSecrets),
    'the scheduled jobs get DATABASE_URL and no storage, auth or seed secret',
  );
  expect(!/SEED_/.test(localBlock(tf, 'runtime_secrets')), 'api and worker must not get the seed keys');
  const accessors = resourceBlocks(tf, 'google_secret_manager_secret_iam_member');
  const grants: Record<string, [string, string]> = {
    runtime: ['local.runtime_secrets', 'runtime'],
    jobs: ['local.jobs_secrets', 'jobs'],
    operator: ['local.operator_secret_ids', 'operator'],
  };
  expect(
    [...accessors.keys()].sort().join() === Object.keys(grants).sort().join(),
    `secret accessors must be exactly ${Object.keys(grants).join(', ')}`,
  );
  for (const [name, [secrets, account]] of Object.entries(grants)) {
    const body = accessors.get(name) ?? '';
    expect(
      body.includes(`for_each  = ${secrets}`) && body.includes(`google_service_account.${account}.email`),
      `secret accessor ${name} must grant ${secrets} to the ${account} account`,
    );
  }
  for (const body of resourceBlocks(tf, 'google_storage_bucket_iam_member').values())
    expect(
      body.includes('google_service_account.runtime.email'),
      'only the runtime account may have a bucket role',
    );

  // D7, D291: signup is off unless the deploy turns it on; D290: telemetry export follows var.otlp_endpoint.
  const runtimeEnv = localBlock(tf, 'runtime_env');
  const defaults = variableDefaults(tf);
  expect(
    /^\s*AUTH_SIGNUP_ENABLED\s*=\s*var\.auth_signup_enabled\s*$/m.test(runtimeEnv) &&
      defaults.get('auth_signup_enabled') === 'false',
    'AUTH_SIGNUP_ENABLED must come from var.auth_signup_enabled, default "false" (D7)',
  );
  expect(
    /^\s*OTLP_ENDPOINT\s*=\s*var\.otlp_endpoint\s*$/m.test(runtimeEnv) &&
      defaults.get('otlp_endpoint') === '',
    'OTLP_ENDPOINT must come from var.otlp_endpoint, default "" (export off)',
  );

  // The plain environment of the services must pass the schema together with placeholders for the secrets.
  const plain = Object.fromEntries(
    [...runtimeEnv.matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)].map((m) => {
      const value = (m[2] as string).trim();
      // A variable stands for its default; any other reference (`google_storage_bucket.media.name`) for a value known
      // at apply time.
      const variable = value.match(/^var\.(\w+)$/)?.[1];
      const fallback = variable === undefined ? undefined : defaults.get(variable);
      if (fallback !== undefined) return [m[1] as string, fallback];
      return [
        m[1] as string,
        value.startsWith('"') ? value.slice(1, -1).replace(/\$\{[^}]*\}/g, 'example') : 'example',
      ];
    }),
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

  // The scheduled jobs: the same plain environment, their stand-in S3 keys and DATABASE_URL, without the auth secret.
  const jobsEnv = Object.fromEntries(
    [
      ...(tf.match(/^ {2}jobs_env = merge\(local\.runtime_env, \{([\s\S]*?)\n {2}\}\)/m)?.[1] ?? '').matchAll(
        /^\s*(\w+)\s*=\s*"([^"]*)"\s*$/gm,
      ),
    ].map((m) => [m[1] as string, m[2] as string]),
  );
  const jobsParsed = envSchema.safeParse({
    ...plain,
    ...jobsEnv,
    PUBLIC_URL: 'https://example.test',
    S3_BUCKET: 'example-bucket',
    DATABASE_URL: 'postgres://example',
  });
  expect(
    jobsParsed.success,
    `environment of the scheduled jobs fails the schema: ${jobsParsed.success ? '' : jobsParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`,
  );

  // The seed job never generates, and so never prints, a key: both values come from Secret Manager.
  const operator = resourceBlocks(tf, 'google_cloud_run_v2_job').get('operator') ?? '';
  expect(
    /for_each\s*=\s*local\.operator_secrets/.test(operator),
    'the operator jobs must take local.operator_secrets',
  );
  const seedSecrets = tf.match(/seed_secrets = \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  for (const name of ['SEED_API_KEY', 'SEED_ADMIN_API_KEY'])
    expect(
      new RegExp(`^\\s*${name}\\s*=`, 'm').test(seedSecrets),
      `the seed job must get ${name} from Secret Manager`,
    );
  expect(/^\s*seed\s*=.*local\.seed_secrets/m.test(tf), 'the seed job must get the seed secrets');

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
