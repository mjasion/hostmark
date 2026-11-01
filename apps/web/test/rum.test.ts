import { RumRequest } from '@hostmark/contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers: Record<string, (m: unknown) => void> = {};
vi.mock('web-vitals', () => {
  const on = (name: string) => (cb: (m: unknown) => void) => {
    handlers[name] = cb;
  };
  return { onLCP: on('LCP'), onINP: on('INP'), onCLS: on('CLS'), onTTFB: on('TTFB') };
});

const { readAttributes, send, startRum, toBody } = await import('../src/rum');

function tag(attrs: Record<string, string>) {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v;
  return el;
}
const good = { platform: 'cloudflare', variant: 'idiomatic', topology: 'multi', region: 'frankfurt' };

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe('rum', () => {
  it('reads attributes from the closed lists', () => {
    expect(readAttributes(tag(good))).toEqual(good);
  });

  it.each([
    ['unknown platform', { ...good, platform: 'heroku' }],
    ['unknown region', { ...good, region: 'mars' }],
    ['missing topology', { platform: 'local', variant: 'portable', region: 'local' }],
    ['empty', {}],
  ])('rejects %s', (_name, attrs) => {
    expect(readAttributes(tag(attrs))).toBeNull();
  });

  it('produces a body that RumRequest parses', () => {
    const attrs = readAttributes(tag(good));
    if (!attrs) throw new Error('attributes');
    const body = toBody({ name: 'LCP', value: 1234.5, rating: 'good' }, attrs);
    expect(RumRequest.safeParse(body).success).toBe(true);
  });

  it('sends with sendBeacon as an application/json blob', async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    send({ hello: 1 });
    const call = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(call[0]).toBe('/api/rum');
    expect(call[1].type).toBe('application/json');
    expect(JSON.parse(await call[1].text())).toEqual({ hello: 1 });
  });

  it('falls back to a keepalive fetch when sendBeacon refuses', () => {
    vi.stubGlobal('navigator', { sendBeacon: () => false });
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    send({ a: 1 });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe('POST');
  });

  it('reports each metric once with valid attributes', () => {
    const sent: unknown[] = [];
    vi.stubGlobal('navigator', {
      sendBeacon: (_u: string, blob: Blob) => {
        void blob.text().then((t) => sent.push(JSON.parse(t)));
        return true;
      },
    });
    expect(startRum(tag(good))).toBe(true);
    expect(Object.keys(handlers).sort()).toEqual(['CLS', 'INP', 'LCP', 'TTFB']);
    handlers.CLS?.({ name: 'CLS', value: 0.05, rating: 'good' });
    return vi.waitFor(() => {
      expect(sent).toHaveLength(1);
      expect(RumRequest.safeParse(sent[0]).success).toBe(true);
    });
  });

  it('sends nothing and subscribes to nothing for bad attributes', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    expect(startRum(tag({ ...good, platform: 'nope' }))).toBe(false);
    expect(startRum(null)).toBe(false);
    expect(Object.keys(handlers)).toHaveLength(0);
    expect(beacon).not.toHaveBeenCalled();
  });
});
