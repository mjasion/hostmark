import { readFileSync } from 'node:fs';
import { normalizedDockerfile } from '@hostmark/node-runtime/testing/dockerfile';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CLIENT_IP_HEADER } from '../src/platform';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: a parsed compose file is only inspected
const compose = parse(read('docker-compose.yml'), { merge: true }) as any;

describe('Dockerfile', () => {
  it('is the image of adapters/local apart from the adapter name and the RUM defaults', () => {
    const local = normalizedDockerfile(new URL('../../local/Dockerfile', import.meta.url), 'local');
    expect(normalizedDockerfile(new URL('../Dockerfile', import.meta.url), 'vps')).toBe(local);
  });
});

describe('docker-compose.yml', () => {
  it('runs exactly one scheduler', () => {
    const scheduler = compose.services.scheduler;
    expect(scheduler.deploy?.replicas ?? 1).toBe(1);
    expect(scheduler.scale).toBeUndefined();
    expect(scheduler.container_name).toBeUndefined();
  });

  it('runs the worker as in adapters/local: one job per process, two replicas, a memory limit', () => {
    const worker = compose.services.worker;
    expect(worker.environment.WORKER_CONCURRENCY).toBe('1');
    expect(worker.deploy.replicas).toContain('WORKER_REPLICAS:-2');
    expect(worker.mem_limit).toContain('WORKER_MEM_LIMIT:-4g');
    expect(worker.memswap_limit).toBe(worker.mem_limit);
    expect(worker.stop_grace_period).toBe('70s');
  });

  it('exposes only Caddy: no other service publishes a port', () => {
    for (const [name, service] of Object.entries<{ ports?: unknown }>(compose.services)) {
      if (name === 'caddy') expect(service.ports).toBeDefined();
      else expect(service.ports, name).toBeUndefined();
    }
  });

  it('applies the bucket lifecycle through the init job before migrations', () => {
    expect(compose.services['minio-init'].command).toEqual(['node', 'dist/init-bucket.js']);
    expect(compose.services.migrate.depends_on['minio-init'].condition).toBe(
      'service_completed_successfully',
    );
  });

  it('has no Postgres container: the portable variants use the shared database', () => {
    expect(compose.services.postgres).toBeUndefined();
    expect(compose.services.api.environment.DATABASE_URL).toContain('DATABASE_URL');
  });
});

describe('Caddyfile', () => {
  it('overwrites the header the api trusts with the TCP peer', () => {
    const text = read('Caddyfile');
    expect(text).toContain(`header_up ${CLIENT_IP_HEADER} {remote_host}`);
    expect(text).toContain('reverse_proxy api:8080');
  });

  it('compresses the app responses, as the CDNs of the other platforms do (D208)', () => {
    const app = read('Caddyfile').split('{$S3_DOMAIN}')[0] ?? '';
    expect(app).toMatch(/^\s*encode zstd gzip$/m);
  });
});

describe('.env.example', () => {
  it('holds placeholders only', () => {
    const text = read('.env.example');
    expect(text).toMatch(/replace/i);
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
