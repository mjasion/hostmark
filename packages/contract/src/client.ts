import { HEADER_CHAOS, PROBLEM_CONTENT_TYPE } from './constants';
import type { Chaos } from './messages';
import {
  type CreateUploadRequest,
  CreateUploadResponse,
  DebugCpuResponse,
  DeepHealth,
  FileResponse,
  Health,
  type ListFilesQuery,
  ListFilesResponse,
  Problem,
  type RumRequest,
  StatsResponse,
  type UpdateFileRequest,
} from './schemas';

export interface ClientOptions {
  /** Prefix for every request, e.g. `https://api.example.com`. Empty means same origin. */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer`. Browser clients leave it out and rely on the session cookie. */
  apiKey?: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  /** Extra headers on every request, e.g. `traceparent`. */
  headers?: () => Record<string, string>;
}

/** A non-2xx answer. `problem` is null when the body was not an RFC 9457 document. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
    readonly response: Response,
  ) {
    super(problem ? `${problem.title}${problem.detail ? `: ${problem.detail}` : ''}` : `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

interface Schema<T> {
  parse(data: unknown): T;
}

interface RequestSpec<T> {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses that carry a body to parse with `schema`; `undefined` schema means no body is read. */
  schema?: Schema<T>;
  /** Additional statuses that are not errors and are parsed with `schema` (e.g. 503 of deep health). */
  alsoOk?: number[];
}

export function createClient(options: ClientOptions = {}) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');

  async function request<T = void>(spec: RequestSpec<T>): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...options.headers?.(),
      ...spec.headers,
    };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    if (spec.body !== undefined) headers['content-type'] = 'application/json';

    const res = await doFetch(`${baseUrl}${spec.path}${qs ? `?${qs}` : ''}`, {
      method: spec.method,
      headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      credentials: options.credentials,
    });

    const acceptable = res.ok || spec.alsoOk?.includes(res.status);
    if (!acceptable) {
      throw new ApiError(res.status, await readProblem(res), res);
    }
    if (!spec.schema || res.status === 204) return undefined as T;
    return spec.schema.parse(await res.json());
  }

  return {
    health: () => request({ method: 'GET', path: '/api/health', schema: Health }),
    /** Resolves for 200 and 503; inspect `status`. */
    deepHealth: () => request({ method: 'GET', path: '/api/health/deep', schema: DeepHealth, alsoOk: [503] }),
    createUpload: (body: CreateUploadRequest) =>
      request({ method: 'POST', path: '/api/uploads', body, schema: CreateUploadResponse }),
    completeUpload: (id: string, opts: { chaos?: Chaos } = {}) =>
      request({
        method: 'POST',
        path: `/api/uploads/${id}/complete`,
        headers: opts.chaos ? { [HEADER_CHAOS]: opts.chaos } : undefined,
        schema: FileResponse,
      }),
    listFiles: (query: ListFilesQuery = {}) =>
      request({ method: 'GET', path: '/api/files', query, schema: ListFilesResponse }),
    getFile: (id: string) => request({ method: 'GET', path: `/api/files/${id}`, schema: FileResponse }),
    updateFile: (id: string, body: UpdateFileRequest) =>
      request({ method: 'PATCH', path: `/api/files/${id}`, body, schema: FileResponse }),
    deleteFile: (id: string) => request({ method: 'DELETE', path: `/api/files/${id}` }),
    stats: () => request({ method: 'GET', path: '/api/stats', schema: StatsResponse }),
    debugCpu: (ms: number) =>
      request({ method: 'POST', path: '/api/debug/cpu', query: { ms }, schema: DebugCpuResponse }),
    rum: (body: RumRequest) => request({ method: 'POST', path: '/api/rum', body }),
    /** URL for `EventSource`; the stream itself is not wrapped. */
    eventsUrl: (id: string) => `${baseUrl}/api/files/${id}/events`,
  };
}

export type Client = ReturnType<typeof createClient>;

async function readProblem(res: Response): Promise<Problem | null> {
  if (!res.headers.get('content-type')?.includes(PROBLEM_CONTENT_TYPE)) return null;
  const parsed = Problem.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
