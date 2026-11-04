import { vi } from 'vitest';

export const FILE_ID = '0198c8a6-2b1e-7c3a-9d2f-3a5b6c7d8e9f';
const now = '2026-01-01T00:00:00.000Z';

export function fileJson(over: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    status: 'processing',
    contentType: 'image/png',
    bytes: 1234,
    width: null,
    height: null,
    sha256: null,
    isPublic: false,
    attempts: 1,
    lastError: null,
    createdAt: now,
    queuedAt: now,
    readyAt: null,
    expiresAt: '2026-01-08T00:00:00.000Z',
    variants: [],
    ...over,
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const problem = (status: number, title: string, detail?: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * Stubs `fetch` with routes keyed by `METHOD /path`; an unknown route fails the test loudly. Like a browser, an
 * aborted `signal` rejects the call, also while its handler is still pending.
 */
export function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname, init });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`unexpected request ${method} ${url.pathname}`);
    const { signal } = init;
    if (signal?.aborted) throw aborted();
    const answer = Promise.resolve(handler(url, init));
    if (!signal) return answer;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(aborted()), { once: true });
      answer.then(resolve, reject);
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    {
      onprogress: null,
    };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
  static reset() {
    FakeXHR.instances = [];
  }
  static last(): FakeXHR {
    const x = FakeXHR.instances.at(-1);
    if (!x) throw new Error('no XHR was created');
    return x;
  }
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  /** `fatal` mimics the browser giving up (readyState CLOSED); otherwise it is reconnecting. */
  fail(fatal: boolean) {
    this.readyState = fatal ? 2 : 0;
    this.onerror?.();
  }
  static reset() {
    FakeEventSource.instances = [];
  }
  static get open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((i) => !i.closed);
  }
}

export function createFile(name = 'a.png', type = 'image/png', size = 1234): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}
