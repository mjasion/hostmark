// Neon database branches for pull request previews. A small client over the v2 REST API with an injected `fetch`,
// so every test runs against fake responses. No dependency.
//
// Endpoints used (from a search of the Neon API reference, not verified against a live project, D141):
//   GET    /projects/{project}/branches?search=<name>            list, filtered by name
//   POST   /projects/{project}/branches                          { branch: { name, parent_id, expires_at }, endpoints: [{ type }] }
//   GET    /projects/{project}/branches/{branch}/endpoints       { endpoints: [{ id, host }] }
//   GET    /projects/{project}/connection_uri?branch_id&endpoint_id&database_name&role_name&pooled
//   DELETE /projects/{project}/branches/{branch}
// A branch that has children, or is the default branch of the project, cannot be deleted; the API answers with an
// error and `deletePreviewBranch` reports it instead of hiding it.

const BASE_URL = 'https://console.neon.tech/api/v2';
const BRANCH_ID = /^br-[a-z0-9-]+$/;
const ENDPOINT_ID = /^ep-[a-z0-9-]+$/;
const PROJECT_ID = /^[a-z0-9-]+$/;

export class NeonError extends Error {
  /** @param {string} message @param {{ status?: number, body?: unknown }} [details] */
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'NeonError';
    this.status = status;
    this.body = body;
  }
}

/** Branch name of the preview of pull request `pr`. Throws on anything but a positive integer. */
export function previewBranchName(pr) {
  return `preview/pr-${positiveInt(pr, 'pull request number')}`;
}

export function positiveInt(value, what) {
  const n = typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${what} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/**
 * @param {{ apiKey: string, projectId: string, fetch?: typeof fetch, baseUrl?: string, timeoutMs?: number }} options
 */
export function createNeonClient({
  apiKey,
  projectId,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = BASE_URL,
  timeoutMs = 30_000,
}) {
  if (!apiKey) throw new Error('NEON_API_KEY is empty');
  if (!PROJECT_ID.test(projectId ?? '')) throw new Error('NEON_PROJECT_ID is empty or malformed');
  const project = `${baseUrl}/projects/${projectId}`;

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${project}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new NeonError(`${method} ${path.split('?')[0]} failed before a response: ${error.message}`);
    }
    const text = await response.text();
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail = typeof json?.message === 'string' ? `: ${json.message}` : '';
      throw new NeonError(`${method} ${path.split('?')[0]} answered ${response.status}${detail}`, {
        status: response.status,
        body: json,
      });
    }
    return json;
  }

  return {
    /** The branch with exactly this name, or null. */
    async findBranch(name) {
      const json = await call('GET', `/branches?search=${encodeURIComponent(name)}`);
      if (!Array.isArray(json?.branches))
        throw new NeonError('list branches answered without a "branches" array');
      const matches = json.branches.filter((b) => b?.name === name);
      if (matches.length > 1)
        throw new NeonError(`${matches.length} branches are named ${name}; refusing to pick one`);
      const [branch] = matches;
      if (!branch) return null;
      if (!BRANCH_ID.test(branch.id ?? '')) throw new NeonError(`branch ${name} has no usable id`);
      return { id: branch.id, name: branch.name };
    },

    /** Creates a branch with a read-write endpoint. Returns `{ branchId, endpointId }`; partial answers throw. */
    async createBranch({ name, parentId, expiresAt }) {
      const json = await call('POST', '/branches', {
        branch: { name, parent_id: parentId, expires_at: expiresAt },
        endpoints: [{ type: 'read_write' }],
      });
      const branchId = json?.branch?.id;
      const endpointId = json?.endpoints?.[0]?.id;
      if (!BRANCH_ID.test(branchId ?? '')) {
        throw new NeonError('create branch answered without a branch id', { body: json });
      }
      if (!ENDPOINT_ID.test(endpointId ?? '')) {
        // The branch exists and costs nothing yet, but it is not usable. The caller removes it.
        throw new NeonError(
          `create branch answered without an endpoint id (branch ${branchId} was created)`,
          {
            body: json,
          },
        );
      }
      return { branchId, endpointId };
    },

    async endpointOf(branchId) {
      const json = await call('GET', `/branches/${branchId}/endpoints`);
      const endpoint = Array.isArray(json?.endpoints)
        ? json.endpoints.find((e) => ENDPOINT_ID.test(e?.id ?? ''))
        : undefined;
      return endpoint ? endpoint.id : null;
    },

    async connectionUri({ branchId, endpointId, database, role, pooled }) {
      const query = new URLSearchParams({
        branch_id: branchId,
        endpoint_id: endpointId,
        database_name: database,
        role_name: role,
        pooled: String(pooled),
      });
      const json = await call('GET', `/connection_uri?${query}`);
      const uri = json?.uri;
      if (typeof uri !== 'string' || !/^postgres(ql)?:\/\/[^\s]+$/.test(uri)) {
        throw new NeonError('connection_uri answered without a usable "uri"');
      }
      return uri;
    },

    /** @returns {Promise<boolean>} false when the branch was already gone */
    async deleteBranch(branchId) {
      try {
        await call('DELETE', `/branches/${branchId}`);
        return true;
      } catch (error) {
        if (error instanceof NeonError && error.status === 404) return false;
        throw error;
      }
    },
  };
}

/**
 * Creates the preview branch of a pull request, or reuses it when a push finds it already there.
 * Returns the two connection strings: `direct` for migrations, `pooled` for the Worker.
 *
 * @param {ReturnType<typeof createNeonClient>} client
 * @param {{ pr: number | string, parentId: string, database: string, role: string, ttlDays?: number, now?: Date }} input
 */
export async function ensurePreviewBranch(
  client,
  { pr, parentId, database, role, ttlDays = 7, now = new Date() },
) {
  if (!BRANCH_ID.test(parentId ?? '')) throw new Error('NEON_PREVIEW_PARENT_BRANCH_ID is empty or malformed');
  if (!database || !role) throw new Error('NEON_DATABASE and NEON_ROLE are required');
  const name = previewBranchName(pr);
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();

  let created = false;
  let branch = await client.findBranch(name);
  let endpointId;
  if (branch) {
    endpointId = await client.endpointOf(branch.id);
    if (!endpointId)
      throw new NeonError(`branch ${name} exists without an endpoint; delete it and push again`);
  } else {
    let made;
    try {
      made = await client.createBranch({ name, parentId, expiresAt });
    } catch (error) {
      // A partial create (a branch without an endpoint) must not stay behind: the TTL is the only other cleanup.
      const stray = typeof error.body?.branch?.id === 'string' ? error.body.branch.id : undefined;
      if (stray && BRANCH_ID.test(stray)) {
        try {
          await client.deleteBranch(stray);
        } catch (cleanup) {
          error.message += ` (and removing it failed: ${cleanup.message})`;
        }
      }
      throw error;
    }
    branch = { id: made.branchId, name };
    endpointId = made.endpointId;
    created = true;
  }

  const common = { branchId: branch.id, endpointId, database, role };
  const [direct, pooled] = await Promise.all([
    client.connectionUri({ ...common, pooled: false }),
    client.connectionUri({ ...common, pooled: true }),
  ]);
  return { branchId: branch.id, endpointId, name, created, direct, pooled };
}

/**
 * Removes the preview branch of a pull request. An absent branch is a success (cleanup runs twice), any other
 * failure throws, so the cleanup job fails visibly instead of leaving a branch nobody sees.
 */
export async function deletePreviewBranch(client, { pr }) {
  const name = previewBranchName(pr);
  const branch = await client.findBranch(name);
  if (!branch) return { name, deleted: false, reason: 'absent' };
  const deleted = await client.deleteBranch(branch.id);
  return { name, deleted, branchId: branch.id, reason: deleted ? 'deleted' : 'absent' };
}
