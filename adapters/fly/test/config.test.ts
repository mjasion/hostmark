import { readFileSync } from 'node:fs';
import { RUM_REGIONS, RUM_TOPOLOGIES, RUM_VARIANTS } from '@hostmark/contract';
import { normalizedDockerfile } from '@hostmark/node-runtime/testing/dockerfile';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: a parsed fly.toml is only inspected
const config = parse(text) as any;

describe('Dockerfile', () => {
  it('is the image of adapters/local apart from the adapter name and the RUM defaults', () => {
    const local = normalizedDockerfile(new URL('../../local/Dockerfile', import.meta.url), 'local');
    expect(normalizedDockerfile(new URL('../Dockerfile', import.meta.url), 'fly')).toBe(local);
  });
});

describe('fly.toml', () => {
  it('parses and names an app and a region', () => {
    expect(config.app).toMatch(/^[a-z0-9-]+$/);
    expect(config.primary_region).toBe('fra');
  });

  it('runs the three roles as process groups of one image', () => {
    expect(Object.keys(config.processes).sort()).toEqual(['api', 'scheduler', 'worker']);
    expect(config.processes.api).toContain('dist/api.js');
    expect(config.processes.worker).toContain('dist/worker.js');
    expect(config.processes.scheduler).toContain('dist/scheduler.js');
  });

  it('exposes only the api group', () => {
    expect(config.http_service.processes).toEqual(['api']);
    expect(config.services).toBeUndefined();
    expect(config.http_service.auto_stop_machines).toBe('off');
    expect(config.http_service.checks[0].path).toBe('/api/health');
  });

  it('counts requests, with a hard limit far above S6 and SSE, and a softer one below it (D282)', () => {
    const c = config.http_service.concurrency;
    expect(c.type).toBe('requests');
    expect(c.soft_limit).toBeLessThan(c.hard_limit);
    expect(c.hard_limit).toBeGreaterThanOrEqual(500);
    // SSE streams stay open up to 60 s (D20); the idle timeout stays above that, keepalive or not (D236).
    expect(config.http_service.http_options.idle_timeout).toBeGreaterThan(60);
  });

  it('deploys blue-green, which needs the api health check (D282)', () => {
    expect(config.deploy.strategy).toBe('bluegreen');
    expect(config.http_service.checks.length).toBeGreaterThan(0);
  });

  it('gives every process group a machine size, the worker 4 GB for its 3.2 GiB peak (D79)', () => {
    const byGroup = new Map<string, { memory: string }>();
    for (const vm of config.vm) for (const group of vm.processes) byGroup.set(group, vm);
    expect([...byGroup.keys()].sort()).toEqual(['api', 'scheduler', 'worker']);
    expect(byGroup.get('worker')?.memory).toBe('4gb');
  });

  it('runs one job per worker process and waits for it on shutdown (D97, 60 s lock)', () => {
    expect(config.env.WORKER_CONCURRENCY).toBe('1');
    expect(config.kill_timeout).toBeGreaterThanOrEqual(70);
  });

  it('applies the bucket lifecycle and the schema before the machines are replaced', () => {
    const cmd: string = config.deploy.release_command;
    expect(cmd.indexOf('dist/init-bucket.js')).toBeGreaterThanOrEqual(0);
    expect(cmd.indexOf('dist/init-bucket.js')).toBeLessThan(cmd.indexOf('dist/migrate.js'));
    expect(cmd.indexOf('dist/migrate.js')).toBeLessThan(cmd.indexOf('dist/seed.js'));
  });

  it('uses values of the closed RUM lists for the build arguments', () => {
    const args = config.build.args;
    expect(args.HOSTMARK_PLATFORM).toBe('fly');
    expect(RUM_VARIANTS).toContain(args.HOSTMARK_VARIANT);
    expect(RUM_TOPOLOGIES).toContain(args.HOSTMARK_TOPOLOGY);
    expect(RUM_REGIONS).toContain(args.HOSTMARK_REGION);
    expect(config.env.HOSTMARK_REGION).toBe(args.HOSTMARK_REGION);
  });

  it('holds no secret: those are set with `fly secrets set`', () => {
    for (const key of Object.keys(config.env))
      expect(key).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|REDIS_URL/);
  });
});
