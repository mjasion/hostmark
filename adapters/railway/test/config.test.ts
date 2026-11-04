import { existsSync, readFileSync } from 'node:fs';
import { RUM_REGIONS } from '@hostmark/contract';
import { normalizedDockerfile } from '@hostmark/node-runtime/testing/dockerfile';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: a parsed config file is only inspected
const config = JSON.parse(read('services.json')) as any;
const services = ['api', 'worker', 'scheduler'] as const;

// Railway reads none of this file (Config as Code is deprecated, see README), so there is no schema to validate against.
// The test guards the values the adapter depends on and rejects keys it does not know.
const knownKeys = [
  'startCommand',
  'preDeployCommand',
  'preDeployTimeoutSeconds',
  'numReplicas',
  'healthcheckPath',
  'healthcheckTimeout',
  'drainingSeconds',
  'overlapSeconds',
  'restartPolicyType',
  'memoryBytes',
];

describe('Dockerfile', () => {
  it('is the image of adapters/local apart from the adapter name and the RUM defaults', () => {
    const local = normalizedDockerfile(new URL('../../local/Dockerfile', import.meta.url), 'local');
    expect(normalizedDockerfile(new URL('../Dockerfile', import.meta.url), 'railway')).toBe(local);
  });

  it('defaults the region to a value of the closed RUM list (Railway has no Frankfurt)', () => {
    const region = /^ARG HOSTMARK_REGION=(.*)$/m.exec(read('Dockerfile'))?.[1];
    expect(RUM_REGIONS).toContain(region);
    expect(read('Dockerfile')).toContain('ARG HOSTMARK_PLATFORM=railway\n');
  });
});

describe('services.json', () => {
  it('names the adapter Dockerfile, which exists, and exactly the three services', () => {
    expect(existsSync(new URL(`../../../${config.dockerfilePath}`, import.meta.url))).toBe(true);
    expect(Object.keys(config.services).sort()).toEqual([...services].sort());
  });

  it.each(services)(
    '%s starts dist/%s.js, uses known keys and restarts whatever the exit code',
    (service) => {
      const s = config.services[service];
      for (const key of Object.keys(s)) expect(knownKeys).toContain(key);
      expect(s.startCommand).toContain(`dist/${service}.js`);
      expect(s.restartPolicyType).toBe('ALWAYS');
    },
  );

  it('runs exactly one scheduler, and does not let a deploy start a second beside the old one', () => {
    const s = config.services.scheduler;
    expect(s.numReplicas).toBe(1);
    expect(s.overlapSeconds).toBe(0);
  });

  it('runs two workers with 4 GiB each and time to finish a job on SIGTERM (D79, D97, 60 s lock)', () => {
    const s = config.services.worker;
    expect(s.numReplicas).toBe(2);
    expect(s.memoryBytes).toBeGreaterThanOrEqual(4 * 1024 ** 3);
    // Railway's default is SIGKILL right after SIGTERM, so a job in flight is lost unless this is set.
    expect(s.drainingSeconds).toBeGreaterThanOrEqual(70);
  });

  it('applies the bucket lifecycle, then the schema, then the seed before the api starts', () => {
    const cmd: string = config.services.api.preDeployCommand;
    const order = ['dist/init-bucket.js', 'dist/migrate.js', 'dist/seed.js'].map((f) => cmd.indexOf(f));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('gates the api rollout on /api/health', () => {
    expect(config.services.api.healthcheckPath).toBe('/api/health');
  });

  it('caps the pre-deploy command, which otherwise has no time limit (D283)', () => {
    expect(config.services.api.preDeployTimeoutSeconds).toBe(600);
  });

  it('places every service, and Redis, in Amsterdam, the Railway region nearest Frankfurt and its database (D283)', () => {
    expect(config.region).toBe('europe-west4-drams3a');
  });

  it('holds no secret: variables are set in Railway', () => {
    expect(read('services.json')).not.toMatch(/SECRET|PASSWORD|TOKEN|postgres:\/\//i);
  });
});
