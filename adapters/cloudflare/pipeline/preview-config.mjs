// Turns the production wrangler configs (api, consumer) into the configs of one pull request's preview Workers (D141).
// The point is isolation: a preview gets its own Worker names, queues and Hyperdrive config, a preview bucket and no
// routes, service bindings only to its own sibling Workers, and the renderer refuses any key it does not know, so a
// binding added to production later cannot leak into a preview unnoticed. Nothing here talks to Cloudflare.

/** Removes // and block comments and trailing commas from JSONC, leaving strings alone. */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment in wrangler config');
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/** Keys that are plain settings of the Worker and carry no reference to an account resource. */
const SAFE_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'assets',
  'build',
  'observability',
  'rules',
  'find_additional_modules',
  'no_bundle',
  'minify',
  'keep_vars',
  'limits',
  'placement',
  'upload_source_maps',
  'tsconfig',
  'preserve_file_names',
  'base_dir',
  'secrets',
  'migrations',
  'vars',
  'cache',
  'exports',
]);
/** Keys the renderer rewrites. */
const REWRITTEN_KEYS = new Set(['queues', 'r2_buckets', 'hyperdrive', 'services']);
/** Keys a preview drops: it has no cron and no route, and only the top-level config is rendered. */
const DROPPED_KEYS = new Set([
  'triggers',
  'routes',
  'route',
  'workers_dev',
  'preview_urls',
  'env',
  'account_id',
]);

const PR_NUMBER = /^[1-9][0-9]{0,8}$/;
const VERSION = /^[0-9a-f]{7,40}$/;

/** Preview name of a production Worker: the production name stays recognisable, the pull request is appended. */
export const previewWorkerName = (name, pr) => `${name}-pr-${assertPr(pr)}`;

/** Name of the Hyperdrive config the preview Workers share. */
export const previewHyperdriveName = (pr) => `hostmark-pr-${assertPr(pr)}`;

function assertPr(pr) {
  if (!PR_NUMBER.test(String(pr)))
    throw new Error(`pull request number must be a positive integer, got ${JSON.stringify(pr)}`);
  return String(pr);
}

/** Preview name of a production queue: the production name stays recognisable, the pull request is appended. */
export const previewQueueName = (original, pr) => `${original}-pr-${assertPr(pr)}`;

/**
 * @param {Record<string, any>} base parsed production config
 * @param {{
 *   pr: number | string, sha: string, publicUrl: string, previewBucket: string, hyperdriveId: string,
 *   accountId?: string, workers: string[], isPublic?: boolean,
 * }} input `workers` are the production names of every Worker rendered together; a service binding may only point
 * at one of them. `isPublic` puts the Worker on workers.dev.
 */
export function renderPreviewConfig(
  base,
  { pr, sha, publicUrl, previewBucket, hyperdriveId, accountId, workers, isPublic = false },
) {
  const n = assertPr(pr);
  if (!VERSION.test(sha ?? '')) throw new Error('sha must be a commit hash');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(publicUrl ?? '')) throw new Error('publicUrl must be an https origin');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(previewBucket ?? ''))
    throw new Error('previewBucket is not a bucket name');
  if (!/^[0-9a-f]{32}$/.test(hyperdriveId ?? ''))
    throw new Error('hyperdriveId must be a 32 character hex id');
  if (
    previewBucket === base.vars?.R2_BUCKET_NAME ||
    (base.r2_buckets ?? []).some((b) => b.bucket_name === previewBucket)
  ) {
    throw new Error('the preview bucket is the production bucket');
  }

  const unknown = Object.keys(base).filter(
    (k) => !SAFE_KEYS.has(k) && !REWRITTEN_KEYS.has(k) && !DROPPED_KEYS.has(k),
  );
  if (unknown.length > 0) {
    throw new Error(
      `wrangler config has keys the preview renderer does not know: ${unknown.join(', ')}. ` +
        'A binding it cannot rewrite could point at production; teach pipeline/preview-config.mjs about it first.',
    );
  }

  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (SAFE_KEYS.has(key)) out[key] = structuredClone(value);
  }
  if (!workers.includes(base.name))
    throw new Error(`${base.name} is not in the list of Workers being rendered`);
  out.name = previewWorkerName(base.name, n);
  out.workers_dev = isPublic;
  out.preview_urls = false;

  if (base.services !== undefined) {
    out.services = base.services.map((entry) => {
      if (!workers.includes(entry.service)) {
        throw new Error(
          `service binding ${entry.binding} points at ${entry.service}, which is not a Worker of this preview`,
        );
      }
      return { ...structuredClone(entry), service: previewWorkerName(entry.service, n) };
    });
  }

  if (base.queues !== undefined) {
    const rename = (name) => previewQueueName(name, n);
    out.queues = {};
    for (const [role, entries] of Object.entries(base.queues)) {
      if (role !== 'producers' && role !== 'consumers') throw new Error(`unknown queues.${role}`);
      out.queues[role] = entries.map((entry) => {
        const copy = structuredClone(entry);
        if (typeof copy.queue !== 'string') throw new Error(`queues.${role} entry without a queue name`);
        copy.queue = rename(copy.queue);
        if (copy.dead_letter_queue !== undefined) copy.dead_letter_queue = rename(copy.dead_letter_queue);
        return copy;
      });
    }
  }

  if (base.r2_buckets !== undefined) {
    out.r2_buckets = base.r2_buckets.map((entry) => {
      const { bucket_name: _production, preview_bucket_name: _preview, jurisdiction, ...rest } = entry;
      return { ...rest, bucket_name: previewBucket, ...(jurisdiction ? { jurisdiction } : {}) };
    });
  }

  if (base.hyperdrive !== undefined) {
    out.hyperdrive = base.hyperdrive.map((entry) => {
      const { id: _production, localConnectionString: _local, ...rest } = entry;
      return { ...rest, id: hyperdriveId };
    });
  }

  out.vars = {
    ...(out.vars ?? {}),
    ENVIRONMENT: 'preview',
    APP_VERSION: sha,
    PUBLIC_URL: publicUrl,
    ...(base.vars?.R2_BUCKET_NAME !== undefined ? { R2_BUCKET_NAME: previewBucket } : {}),
    ...(base.vars?.R2_ACCOUNT_ID !== undefined && accountId ? { R2_ACCOUNT_ID: accountId } : {}),
  };
  return out;
}

/**
 * The names a preview creates, so the cleanup deletes exactly those. `bases` are the configs rendered, in deploy order
 * (the api before the consumer that binds to it); `workers` comes back in the order to delete (consumers first).
 * @returns {{ workers: string[], queues: string[], hyperdrive: string }}
 */
export function previewResources(bases, pr) {
  const queues = new Set();
  for (const base of bases) {
    for (const entries of Object.values(base.queues ?? {})) {
      for (const entry of entries) {
        queues.add(previewQueueName(entry.queue, pr));
        if (entry.dead_letter_queue) queues.add(previewQueueName(entry.dead_letter_queue, pr));
      }
    }
  }
  return {
    workers: bases.map((b) => previewWorkerName(b.name, pr)).reverse(),
    queues: [...queues].sort(),
    hyperdrive: previewHyperdriveName(pr),
  };
}

/** An id from the output of `wrangler hyperdrive create`: exactly one 32 character hex token, else null. */
export function hyperdriveIdFromOutput(output) {
  const ids = new Set(String(output ?? '').match(/\b[0-9a-f]{32}\b/g) ?? []);
  return ids.size === 1 ? [...ids][0] : null;
}

/** The id of the Hyperdrive config called `name` in the output of `wrangler hyperdrive list`, matched on whole tokens. */
export function hyperdriveIdFromList(output, name) {
  const found = new Set();
  for (const line of String(output ?? '').split('\n')) {
    const tokens = line.split(/[\s│|"',:]+/).filter(Boolean);
    if (!tokens.includes(name)) continue;
    for (const t of tokens) if (/^[0-9a-f]{32}$/.test(t)) found.add(t);
  }
  return found.size === 1 ? [...found][0] : null;
}
