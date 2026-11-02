import { OpenAPIHono } from '@hono/zod-openapi';
import {
  apiRoutes,
  DEFAULT_PAGE_LIMIT,
  type DeepHealth,
  FILE_RETENTION_DAYS,
  HEADER_PLATFORM,
  HEADER_TRACE_ID,
  HEADER_VERSION,
  JOB_MESSAGE_VERSION,
  type JobMessage,
  MAX_UPLOAD_BYTES,
  originalKey,
  RUM_MAX_BODY_BYTES,
  SSE_MAX_DURATION_MS,
  SSE_POLL_INTERVAL_MS,
  STATS_DAYS,
  securitySchemes,
  UPLOAD_URL_TTL_SECONDS,
  VARIANT_SIZES,
  variantKey,
} from '@hostmark/contract';
import { dailyStats, files } from '@hostmark/db';
import { renderError, renderNotFound, renderPublicFile } from '@hostmark/pages';
import { contextFromTraceparent, currentTraceId, injectTraceContext, withSpan } from '@hostmark/telemetry';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes, routePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import { v4, v7 } from 'uuid';
import type { CoreDeps } from '../deps';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from '../errors';
import { authenticate } from './auth';
import type { HttpEnv } from './context';
import { burnCpu } from './cpu';
import { type FileRow, toFileResponses, toStatusEvent } from './files';
import { probe } from './health';
import { problemResponse, randomTraceId } from './problem';
import { htmlResponse, PUBLIC_PAGE_CACHE, pageModel, pageOrigin, rumAttributes } from './public';
import { publicPaths } from './purge';

export interface AppOptions {
  /** Per dependency probe of `/api/health/deep`. */
  probeTimeoutMs?: number;
}

const DAY_MS = 86_400_000;
const AUTH_ROUTE = '/api/auth/*';
const AUTH_MAX_BODY_BYTES = 64 * 1024;
const TERMINAL = new Set(['ready', 'failed', 'deleted']);
const MEDIA_FILE = /^(\d+)\.webp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D100: a public URL is cached and purged by path, and a purge matches the path as written. An uppercase or
 * percent-encoded id would reach the same row under a path the purge does not cover, so only the canonical form (the
 * lowercase id, exactly as in the raw request path) is served.
 */
const hasCanonicalId = (c: Context<HttpEnv>, id: string): boolean =>
  UUID.test(id) && id === id.toLowerCase() && new URL(c.req.url).pathname.split('/')[2] === id;

// Once per instance (isolate or process), not per request.
let coldStartRecorded = false;

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
};

/** The pattern of the matched route, never the raw path: raw paths would explode metric cardinality. */
function matchedRoute(c: Context<HttpEnv>): string {
  const route = matchedRoutes(c)
    .filter((r) => r.method !== 'ALL')
    .at(-1);
  if (route) return route.path;
  return routePath(c, -1) === AUTH_ROUTE ? AUTH_ROUTE : 'unmatched';
}

function withHeaders(c: Context<HttpEnv>, headers: Record<string, string>): void {
  try {
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
  } catch {
    // Responses from fetch() have immutable headers; copy once.
    c.res = new Response(c.res.body, c.res);
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
  }
}

export function createApp(
  resolveDeps: (c: Context) => CoreDeps,
  options: AppOptions = {},
): OpenAPIHono<HttpEnv> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 2000;

  const app = new OpenAPIHono<HttpEnv>({
    defaultHook: (result, c) => {
      if (result.success) return;
      const errors = result.error.issues.map((issue) => ({
        path: [result.target, ...issue.path].join('.'),
        message: issue.message,
      }));
      return problemResponse(c, 400, 'Bad Request', 'Request validation failed', errors);
    },
  });

  for (const [name, scheme] of Object.entries(securitySchemes)) {
    app.openAPIRegistry.registerComponent('securitySchemes', name, scheme);
  }

  // Last good platform and version, so the D9 headers survive a failing `resolveDeps`.
  let knownHeaders: Record<string, string> = {};

  // Server span, request metric, cold start flag and the headers of D9 on every response, errors included.
  const observe: MiddlewareHandler<HttpEnv> = async (c, next) => {
    let deps: CoreDeps;
    try {
      deps = resolveDeps(c);
    } catch (err) {
      // No logger without deps; the cause must still reach stderr.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'resolving dependencies failed',
          error:
            err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
          time: new Date().toISOString(),
        }),
      );
      const res = problemResponse(c, 500, 'Internal Server Error', 'An unexpected error occurred');
      for (const [k, v] of Object.entries(knownHeaders)) res.headers.set(k, v);
      if (c.req.path.startsWith('/api/')) res.headers.set('cache-control', 'private, no-store');
      else if (c.req.path.startsWith('/media/') || c.req.path.startsWith('/f/'))
        res.headers.set('cache-control', 'no-store');
      c.res = res;
      return;
    }
    c.set('deps', deps);
    knownHeaders = { [HEADER_PLATFORM]: deps.config.platform, [HEADER_VERSION]: deps.config.version };
    const { tracer, metrics } = deps.telemetry;
    if (!coldStartRecorded) {
      coldStartRecorded = true;
      metrics.coldStart.add(1);
    }
    const started = performance.now();
    // The trace starts in the browser (spec); an invalid header is ignored.
    const remote = contextFromTraceparent(c.req.header('traceparent'));
    const run = () =>
      withSpan(
        tracer,
        c.req.method,
        async (span) => {
          const traceId = currentTraceId() ?? randomTraceId();
          c.set('traceId', traceId);
          await next();
          const route = matchedRoute(c);
          const status = c.res.status;
          span.updateName(`${c.req.method} ${route}`);
          span.setAttributes({
            'http.request.method': c.req.method,
            'http.route': route,
            'http.response.status_code': status,
          });
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          metrics.httpRequestDuration.record((performance.now() - started) / 1000, {
            'http.request.method': c.req.method,
            'http.route': route,
            'http.response.status_code': status,
          });
          const headers: Record<string, string> = {
            [HEADER_TRACE_ID]: traceId,
            [HEADER_PLATFORM]: deps.config.platform,
            [HEADER_VERSION]: deps.config.version,
          };
          if (c.req.path.startsWith('/api/')) headers['cache-control'] = 'private, no-store';
          // A CDN default could otherwise cache the 404 of a file that is about to become public.
          else if ((c.req.path.startsWith('/media/') || c.req.path.startsWith('/f/')) && status !== 200)
            headers['cache-control'] = 'no-store';
          withHeaders(c, headers);
        },
        { kind: SpanKind.SERVER },
      );
    await (remote ? context.with(remote, run) : run());
  };
  app.use('*', observe);

  // HTML for the public pages, JSON problems everywhere else.
  const isPage = (c: Context<HttpEnv>) => c.req.path.startsWith('/f/');
  const pageError = (status: number, html: string) => htmlResponse(status, html, 'no-store');

  app.onError((err, c) => {
    if (isPage(c) && !(err instanceof DomainError) && !(err instanceof HTTPException && err.status < 500)) {
      c.get('deps')?.telemetry.logger.error('unhandled error', {
        error: err,
        method: c.req.method,
        route: matchedRoute(c),
      });
      const deps = c.get('deps');
      return pageError(500, renderError(rumAttributes(deps.config)));
    }
    if (err instanceof DomainError) return problemResponse(c, err.status, err.title, err.detail);
    if (err instanceof HTTPException) {
      const client = err.status < 500;
      return problemResponse(c, err.status, TITLES[err.status] ?? 'Error', client ? err.message : undefined);
    }
    // Internals stay in the log; the client gets a generic body.
    c.get('deps')?.telemetry.logger.error('unhandled error', {
      error: err,
      method: c.req.method,
      route: matchedRoute(c),
    });
    return problemResponse(c, 500, 'Internal Server Error', 'An unexpected error occurred');
  });
  app.notFound((c) =>
    isPage(c)
      ? pageError(404, renderNotFound(rumAttributes(c.get('deps').config)))
      : problemResponse(c, 404, 'Not Found', 'No such route'),
  );

  for (const path of [
    '/api/uploads',
    '/api/uploads/*',
    '/api/files',
    '/api/files/*',
    '/api/stats',
    '/api/debug/*',
  ]) {
    app.use(path, authenticate);
  }

  // D8: checked before validation and on presence, so a non-admin never learns whether the value was valid.
  const requireAdmin: MiddlewareHandler<HttpEnv> = async (c, next) => {
    if (!c.get('principal').isAdmin) throw new ForbiddenError('Admin key required');
    return next();
  };
  app.use('/api/debug/*', requireAdmin);
  app.use('/api/uploads/:id/complete', async (c, next) => {
    if (c.req.header('x-chaos') !== undefined && !c.get('principal').isAdmin)
      throw new ForbiddenError('x-chaos requires an admin key');
    return next();
  });

  const findFile = async (c: Context<HttpEnv>, id: string): Promise<FileRow> => {
    const { db, telemetry } = c.get('deps');
    const [row] = await withSpan(telemetry.tracer, 'db.select_file', () =>
      db
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.userId, c.get('principal').userId), isNull(files.deletedAt)))
        .limit(1),
    );
    // Another user's file is indistinguishable from a missing one.
    if (!row) throw new NotFoundError('File not found');
    trace.getActiveSpan()?.setAttribute('file.id', row.id);
    return row;
  };

  // Health

  app.openapi(apiRoutes.health, (c) => c.json({ status: 'ok' as const }, 200));

  app.openapi(apiRoutes.deepHealth, async (c) => {
    const { db, storage, queue } = c.get('deps');
    const [database, storageCheck, queueCheck] = await Promise.all([
      probe(() => db.execute(sql`select 1`), probeTimeoutMs),
      probe(() => storage.head('healthcheck/probe'), probeTimeoutMs),
      queue.ping
        ? probe(() => (queue.ping as () => Promise<void>)(), probeTimeoutMs)
        : { status: 'unknown' as const },
    ]);
    const checks = { database, storage: storageCheck, queue: queueCheck };
    const down = Object.values(checks).some((check) => check.status === 'down');
    const body: DeepHealth = { status: down ? 'down' : 'ok', checks };
    return down ? c.json(body, 503) : c.json(body, 200);
  });

  // Uploads

  app.openapi(apiRoutes.createUpload, async (c) => {
    const deps = c.get('deps');
    const principal = c.get('principal');
    const { contentType, bytes } = c.req.valid('json');
    if (bytes > MAX_UPLOAD_BYTES)
      throw new PayloadTooLargeError(`Declared size exceeds ${MAX_UPLOAD_BYTES} bytes`);

    const now = deps.clock.now();
    const id = v7();
    const key = originalKey(principal.userId, id);
    await withSpan(deps.telemetry.tracer, 'db.insert_file', () =>
      deps.db.insert(files).values({
        id,
        userId: principal.userId,
        apiKeyId: principal.apiKeyId,
        contentType,
        originalKey: key,
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + FILE_RETENTION_DAYS * DAY_MS),
      }),
    );
    const uploadUrl = await withSpan(deps.telemetry.tracer, 'storage.presign_put', () =>
      deps.storage.presignPut(key, contentType, bytes, UPLOAD_URL_TTL_SECONDS),
    );
    return c.json(
      {
        fileId: id,
        uploadUrl,
        // Content-Length is signed too (D10) but set by the HTTP client from the body.
        uploadHeaders: { 'content-type': contentType },
        expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      },
      201,
    );
  });

  app.openapi(apiRoutes.completeUpload, async (c) => {
    const deps = c.get('deps');
    const { db, storage, queue, clock, telemetry } = deps;
    const chaos = c.req.valid('header')['x-chaos'] ?? 'none';

    const file = await findFile(c, c.req.valid('param').id);
    // The row's id is canonical; the path may carry uppercase hex, and every key derives from the id.
    const id = file.id;
    if (file.status !== 'pending_upload') throw new ConflictError(`File is ${file.status}`);

    const head = await withSpan(telemetry.tracer, 'storage.head', () => storage.head(file.originalKey));
    if (!head) throw new ConflictError('No uploaded object found');
    if (head.size > MAX_UPLOAD_BYTES) {
      await storage.delete([file.originalKey]);
      await db
        .update(files)
        .set({ status: 'failed', lastError: 'upload exceeds the size limit' })
        .where(and(eq(files.id, id), eq(files.status, 'pending_upload')));
      throw new PayloadTooLargeError(`Uploaded object exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    const now = clock.now();
    const [queued] = await withSpan(telemetry.tracer, 'db.mark_queued', () =>
      db
        .update(files)
        .set({ status: 'queued', bytes: head.size, queuedAt: now, lastActivityAt: now })
        .where(and(eq(files.id, id), eq(files.status, 'pending_upload'), isNull(files.deletedAt)))
        .returning(),
    );
    if (!queued) throw new ConflictError('File is no longer pending upload');

    const message: JobMessage = {
      v: JOB_MESSAGE_VERSION,
      type: 'process_image',
      jobId: v4(),
      fileId: id,
      enqueuedAt: now.toISOString(),
      ...injectTraceContext(),
      chaos,
    };
    try {
      await withSpan(
        telemetry.tracer,
        'queue.send',
        async (span) => {
          span.setAttribute('file.id', id);
          await queue.send(message);
        },
        { kind: SpanKind.PRODUCER },
      );
    } catch (err) {
      telemetry.logger.error('enqueue failed', { fileId: id, error: err });
      await db
        .update(files)
        .set({ status: 'pending_upload', queuedAt: null })
        .where(and(eq(files.id, id), eq(files.status, 'queued')));
      throw new ServiceUnavailableError('Could not enqueue the job');
    }
    const [response] = await toFileResponses(deps, [queued]);
    return c.json(response as NonNullable<typeof response>, 200);
  });

  // Files

  app.openapi(apiRoutes.listFiles, async (c) => {
    const deps = c.get('deps');
    const { cursor, limit } = c.req.valid('query');
    if (cursor !== undefined && !UUID.test(cursor)) throw new ValidationError('Invalid cursor');
    const rows = await withSpan(deps.telemetry.tracer, 'db.list_files', () =>
      deps.db
        .select()
        .from(files)
        .where(
          and(
            eq(files.userId, c.get('principal').userId),
            isNull(files.deletedAt),
            cursor ? lt(files.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(files.id))
        .limit((limit ?? DEFAULT_PAGE_LIMIT) + 1),
    );
    const page = rows.slice(0, limit);
    const items = await toFileResponses(deps, page);
    const nextCursor = rows.length > page.length ? (page.at(-1)?.id ?? null) : null;
    return c.json({ items, nextCursor }, 200);
  });

  app.openapi(apiRoutes.getFile, async (c) => {
    const row = await findFile(c, c.req.valid('param').id);
    const [response] = await toFileResponses(c.get('deps'), [row]);
    return c.json(response as NonNullable<typeof response>, 200);
  });

  app.openapi(apiRoutes.updateFile, async (c) => {
    const deps = c.get('deps');
    const { id } = c.req.valid('param');
    const { isPublic } = c.req.valid('json');
    const [row] = await deps.db
      .update(files)
      .set({ isPublic })
      .where(and(eq(files.id, id), eq(files.userId, c.get('principal').userId), isNull(files.deletedAt)))
      .returning();
    if (!row) throw new NotFoundError('File not found');
    // D100: the row is already private. A failed purge answers 503 and the same PATCH again retries it.
    if (!isPublic && deps.purger) {
      await deps.purger.purge(publicPaths(row.id)).catch((error) => {
        deps.telemetry.logger.error('cdn purge failed', { fileId: row.id, error });
        throw new ServiceUnavailableError('The file is private now, but the CDN could not be purged; retry');
      });
    }
    const [response] = await toFileResponses(deps, [row]);
    return c.json(response as NonNullable<typeof response>, 200);
  });

  app.openapi(apiRoutes.deleteFile, async (c) => {
    const { db, clock, purger, telemetry } = c.get('deps');
    const { id } = c.req.valid('param');
    const now = clock.now();
    const deleted = await db
      .update(files)
      .set({ status: 'deleted', deletedAt: now, lastActivityAt: now })
      .where(and(eq(files.id, id), eq(files.userId, c.get('principal').userId), isNull(files.deletedAt)))
      .returning({ id: files.id });
    if (deleted.length === 0) throw new NotFoundError('File not found');
    // D100: best effort here, because a retry of DELETE would answer 404. The delete_file job purges again and
    // is retried by the queue, so a failure here is not final.
    await purger?.purge(publicPaths(id)).catch((error) => {
      telemetry.logger.warn('cdn purge failed, the delete_file job retries it', { fileId: id, error });
    });
    return c.body(null, 204);
  });

  // D20: polls the database, because services do not call each other.
  app.openapi(apiRoutes.fileEvents, async (c) => {
    const { db, clock, telemetry } = c.get('deps');
    const userId = c.get('principal').userId;
    const { id } = c.req.valid('param');
    const initial = await findFile(c, id);
    // A HEAD probe must not start the poll loop.
    if (c.req.method === 'HEAD') {
      return c.body(null, 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      }) as never;
    }
    return streamSSE(c, async (stream) => {
      const deadline = clock.now().getTime() + SSE_MAX_DURATION_MS;
      let current: FileRow | undefined = initial;
      let last = '';
      while (!stream.aborted && !stream.closed) {
        if (current) {
          const event = toStatusEvent(current);
          const data = JSON.stringify(event);
          if (data !== last) {
            last = data;
            await stream.writeSSE({ event: 'status', data });
          }
          if (TERMINAL.has(current.status)) return;
        }
        if (clock.now().getTime() >= deadline) return;
        await clock.sleep(SSE_POLL_INTERVAL_MS);
        if (stream.aborted || stream.closed) return;
        try {
          [current] = await db
            .select()
            .from(files)
            .where(and(eq(files.id, id), eq(files.userId, userId)))
            .limit(1);
        } catch (err) {
          telemetry.logger.warn('sse poll failed', { fileId: id, error: err });
        }
      }
    }) as never;
  });

  app.openapi(apiRoutes.stats, async (c) => {
    const { db, config } = c.get('deps');
    const rows = await db
      .select()
      .from(dailyStats)
      .where(eq(dailyStats.platform, config.platform))
      .orderBy(desc(dailyStats.day))
      .limit(STATS_DAYS);
    return c.json({ items: rows }, 200);
  });

  app.openapi(apiRoutes.debugCpu, async (c) => {
    const { ms } = c.req.valid('query');
    return c.json({ requestedMs: ms, ...(await burnCpu(ms)) }, 200);
  });

  // D18: public, body size limited, attributes validated against closed lists by the schema.
  app.use(
    '/api/rum',
    bodyLimit({
      maxSize: RUM_MAX_BODY_BYTES,
      onError: (c) => problemResponse(c as Context<HttpEnv>, 413, 'Payload Too Large', 'Body too large'),
    }),
  );
  app.openapi(apiRoutes.rum, (c) => {
    const body = c.req.valid('json');
    c.get('deps').telemetry.metrics.webVitals.record(body.value, {
      'web_vital.name': body.name,
      ...(body.rating ? { 'web_vital.rating': body.rating } : {}),
      'bench.platform': body.platform,
      'bench.variant': body.variant,
      'bench.topology': body.topology,
      'client.region': body.region,
    });
    return c.body(null, 204);
  });

  // Auth is configured per adapter (E1); without it only Bearer keys work. D80: sign-up is anonymous, so the body is
  // capped like /api/rum; the largest legitimate body is a name, an email and a password.
  app.use(
    AUTH_ROUTE,
    bodyLimit({
      maxSize: AUTH_MAX_BODY_BYTES,
      onError: (c) => problemResponse(c as Context<HttpEnv>, 413, 'Payload Too Large', 'Body too large'),
    }),
  );
  app.all(AUTH_ROUTE, (c) => {
    const { auth } = c.get('deps');
    if (!auth) throw new NotFoundError('Session authentication is not configured');
    return auth.handler(c.req.raw);
  });

  app.doc31('/api/openapi.json', (c) => ({
    openapi: '3.1.0',
    info: { title: 'hostmark', version: (c as Context<HttpEnv>).get('deps').config.version },
  }));

  // D6: public variants streamed through api so the CDN can cache them; the bucket stays private.
  app.get('/media/:id/:file', async (c) => {
    const { db, storage } = c.get('deps');
    const id = c.req.param('id');
    const file = c.req.param('file');
    const size = Number(MEDIA_FILE.exec(file)?.[1]);
    // `0128.webp` would otherwise be a second immutable URL for the same object.
    if (
      !hasCanonicalId(c as Context<HttpEnv>, id) ||
      file !== `${size}.webp` ||
      !(VARIANT_SIZES as readonly number[]).includes(size)
    ) {
      throw new NotFoundError('Not found');
    }
    const [row] = await db
      .select({ id: files.id, userId: files.userId })
      .from(files)
      .where(
        and(eq(files.id, id), eq(files.status, 'ready'), eq(files.isPublic, true), isNull(files.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Not found');
    const body = await storage.get(variantKey(row.userId, row.id, size));
    if (!body) throw new NotFoundError('Not found');
    return new Response(body as BodyInit, {
      headers: {
        'content-type': 'image/webp',
        'content-length': String(body.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  // D6, D21, D82: public share page, rendered here so the CDN can cache it for a minute.
  app.get('/f/:id', async (c) => {
    const { db, config, telemetry } = c.get('deps');
    const rum = rumAttributes(config);
    const id = c.req.param('id');
    if (!hasCanonicalId(c as Context<HttpEnv>, id)) return pageError(404, renderNotFound(rum));
    const [row] = await withSpan(telemetry.tracer, 'db.select_public_file', () =>
      db
        .select({
          id: files.id,
          width: files.width,
          height: files.height,
          contentType: files.contentType,
          bytes: files.bytes,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(
          and(eq(files.id, id), eq(files.status, 'ready'), eq(files.isPublic, true), isNull(files.deletedAt)),
        )
        .limit(1),
    );
    if (!row) return pageError(404, renderNotFound(rum));
    trace.getActiveSpan()?.setAttribute('file.id', row.id);
    const { origin, cacheable } = pageOrigin(c, config);
    const { file, urls } = pageModel(row, origin);
    return htmlResponse(
      200,
      renderPublicFile(file, urls, rum),
      cacheable ? PUBLIC_PAGE_CACHE : 'private, no-store',
    );
  });

  return app;
}
