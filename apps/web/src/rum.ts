// Web Vitals reporter (D18, D85). Loaded as `/rum.js` by every page, so it must not import React or the
// contract's schemas (zod): only the closed attribute lists.
import { RUM_PLATFORMS, RUM_REGIONS, RUM_TOPOLOGIES, RUM_VARIANTS } from '@hostmark/contract/constants';
import { type Metric, onCLS, onINP, onLCP, onTTFB } from 'web-vitals';

const ENDPOINT = '/api/rum';

export interface RumAttributes {
  platform: (typeof RUM_PLATFORMS)[number];
  variant: (typeof RUM_VARIANTS)[number];
  topology: (typeof RUM_TOPOLOGIES)[number];
  region: (typeof RUM_REGIONS)[number];
}

function pick<T extends string>(list: readonly T[], value: string | undefined): T | null {
  return list.find((v) => v === value) ?? null;
}

/** Null unless all four attributes are present and in their closed lists. */
export function readAttributes(script: HTMLElement | null): RumAttributes | null {
  if (!script) return null;
  const platform = pick(RUM_PLATFORMS, script.dataset.platform);
  const variant = pick(RUM_VARIANTS, script.dataset.variant);
  const topology = pick(RUM_TOPOLOGIES, script.dataset.topology);
  const region = pick(RUM_REGIONS, script.dataset.region);
  if (!platform || !variant || !topology || !region) return null;
  return { platform, variant, topology, region };
}

/** One metric per request, exactly the keys of `RumRequest`. */
export function toBody(metric: Pick<Metric, 'name' | 'value' | 'rating'>, attributes: RumAttributes) {
  return { name: metric.name, value: metric.value, rating: metric.rating, ...attributes };
}

/**
 * `sendBeacon` survives page unload. A Blob typed `application/json` is sent with that content type (a plain
 * string would be `text/plain`, which the API does not parse). Falls back to a keepalive `fetch`.
 */
export function send(body: object): void {
  const json = JSON.stringify(body);
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([json], { type: 'application/json' }))) return;
  } catch {
    // fall through to fetch
  }
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json,
    keepalive: true,
  }).catch(() => {});
}

export function startRum(
  script: HTMLElement | null = document.querySelector<HTMLElement>('script[data-rum]'),
) {
  const attributes = readAttributes(script);
  if (!attributes) return false;
  const report = (metric: Metric) => send(toBody(metric, attributes));
  onLCP(report);
  onINP(report);
  onCLS(report);
  onTTFB(report);
  return true;
}

// Self-starting only on pages that carry the tag, so importing the module in tests does nothing.
if (typeof document !== 'undefined' && document.querySelector('script[data-rum]')) startRum();
