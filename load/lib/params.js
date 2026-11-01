// Load parameters. Each has the value of the specification and a smaller one for --short; an environment variable
// of the same name overrides both. The result lists every parameter that is not the specified value, so a reduced
// run cannot be mistaken for the full scenario.
import { SHORT } from './config.js';

const registry = {};

/**
 * @param {string} name environment variable
 * @param {number | string} full value of the specification
 * @param {number | string} short value of --short
 */
export function param(name, full, short) {
  const raw = __ENV[name];
  let value;
  let source;
  if (raw !== undefined && raw !== '') {
    value = typeof full === 'number' ? Number(raw) : raw;
    if (typeof full === 'number' && !Number.isFinite(value)) throw new Error(`${name} must be a number`);
    source = 'env';
  } else if (SHORT) {
    value = short;
    source = 'short';
  } else {
    value = full;
    source = 'spec';
  }
  registry[name] = { value, spec: full, source };
  return value;
}

/** `mode` is "full" only when every parameter equals the specification. */
export function describeLoad() {
  const deviations = Object.keys(registry)
    .filter((name) => registry[name].value !== registry[name].spec)
    .map((name) => ({
      param: name,
      value: registry[name].value,
      spec: registry[name].spec,
      source: registry[name].source,
    }));
  return { mode: deviations.length === 0 ? 'full' : 'reduced', params: { ...registry }, deviations };
}

/** "3m" -> 180. Only the forms the scenarios use. */
export function seconds(duration) {
  const m = /^(\d+)(s|m|h)$/.exec(String(duration));
  if (!m) throw new Error(`bad duration ${duration}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

/**
 * A threshold bound that a slower platform may loosen through an environment variable. It goes through `param`, so a
 * changed bound is listed as a deviation and the run is "reduced", not "full".
 */
export const latencyBound = (name, fallback) => param(name, fallback, fallback);
