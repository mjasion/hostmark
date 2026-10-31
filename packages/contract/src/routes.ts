import { createRoute, z } from '@hono/zod-openapi';
import { PROBLEM_CONTENT_TYPE } from './constants';
import {
  CompleteUploadHeaders,
  CreateUploadRequest,
  CreateUploadResponse,
  DebugCpuQuery,
  DebugCpuResponse,
  DeepHealth,
  FileIdParam,
  FileResponse,
  Health,
  ListFilesQuery,
  ListFilesResponse,
  Problem,
  RumRequest,
  StatsResponse,
  UpdateFileRequest,
} from './schemas';

// Paths include the `/api` prefix (D5). Core registers these on an app without a base path.

const problem = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: Problem } },
});

const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];

/** Components the app must register on its OpenAPI registry for `security` to resolve. */
export const securitySchemes = {
  bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key' },
  cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
} as const;

const authErrors = {
  401: problem('Missing or invalid credentials'),
} as const;

export const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['health'],
  summary: 'Liveness, no dependencies touched',
  responses: { 200: json('Alive', Health) },
});

export const deepHealthRoute = createRoute({
  method: 'get',
  path: '/api/health/deep',
  tags: ['health'],
  summary: 'Pings database, storage and queue',
  responses: {
    200: json('All dependencies reachable', DeepHealth),
    503: json('A dependency is down', DeepHealth),
  },
});

export const createUploadRoute = createRoute({
  method: 'post',
  path: '/api/uploads',
  tags: ['uploads'],
  summary: 'Create a file row and a presigned PUT URL',
  security,
  request: { body: { required: true, content: { 'application/json': { schema: CreateUploadRequest } } } },
  responses: {
    201: json('Upload created', CreateUploadResponse),
    400: problem('Validation error or unsupported content type'),
    ...authErrors,
    413: problem('Declared size above the limit'),
  },
});

export const completeUploadRoute = createRoute({
  method: 'post',
  path: '/api/uploads/{id}/complete',
  tags: ['uploads'],
  summary: 'Verify the object and enqueue processing',
  security,
  request: { params: FileIdParam, headers: CompleteUploadHeaders },
  responses: {
    200: json('File queued', FileResponse),
    400: problem('Validation error'),
    ...authErrors,
    403: problem('x-chaos sent by a non-admin'),
    404: problem('File not found'),
    409: problem('Wrong status or no object in storage'),
    413: problem('Object above the limit; it was deleted'),
    503: problem('Enqueue failed; status reverted'),
  },
});

export const listFilesRoute = createRoute({
  method: 'get',
  path: '/api/files',
  tags: ['files'],
  summary: 'List the caller’s files, newest first',
  security,
  request: { query: ListFilesQuery },
  responses: {
    200: json('A page of files', ListFilesResponse),
    400: problem('Validation error'),
    ...authErrors,
  },
});

export const getFileRoute = createRoute({
  method: 'get',
  path: '/api/files/{id}',
  tags: ['files'],
  summary: 'Metadata, status and presigned GET URLs for variants',
  security,
  request: { params: FileIdParam },
  responses: {
    200: json('The file', FileResponse),
    400: problem('Validation error'),
    ...authErrors,
    404: problem('File not found'),
  },
});

export const updateFileRoute = createRoute({
  method: 'patch',
  path: '/api/files/{id}',
  tags: ['files'],
  summary: 'Publish or unpublish a file',
  security,
  request: {
    params: FileIdParam,
    body: { required: true, content: { 'application/json': { schema: UpdateFileRequest } } },
  },
  responses: {
    200: json('The updated file', FileResponse),
    400: problem('Validation error'),
    ...authErrors,
    404: problem('File not found'),
  },
});

export const deleteFileRoute = createRoute({
  method: 'delete',
  path: '/api/files/{id}',
  tags: ['files'],
  summary: 'Soft delete; the scheduler purges objects later',
  security,
  request: { params: FileIdParam },
  responses: {
    204: { description: 'Deleted' },
    400: problem('Validation error'),
    ...authErrors,
    404: problem('File not found'),
  },
});

export const fileEventsRoute = createRoute({
  method: 'get',
  path: '/api/files/{id}/events',
  tags: ['files'],
  summary: 'Server-Sent Events with `status` events (payload: FileStatusEvent)',
  security,
  request: { params: FileIdParam },
  responses: {
    200: {
      description: 'Event stream; closes on a terminal status or after 60 s',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    400: problem('Validation error'),
    ...authErrors,
    404: problem('File not found'),
  },
});

export const statsRoute = createRoute({
  method: 'get',
  path: '/api/stats',
  tags: ['stats'],
  summary: 'Last 30 daily aggregates of the current platform',
  security,
  responses: { 200: json('Daily statistics', StatsResponse), ...authErrors },
});

export const debugCpuRoute = createRoute({
  method: 'post',
  path: '/api/debug/cpu',
  tags: ['debug'],
  summary: 'Burn CPU for `ms` milliseconds (admin key only)',
  security,
  request: { query: DebugCpuQuery },
  responses: {
    200: json('Done', DebugCpuResponse),
    400: problem('ms outside 1..30000'),
    ...authErrors,
    403: problem('Not an admin'),
  },
});

export const rumRoute = createRoute({
  method: 'post',
  path: '/api/rum',
  tags: ['telemetry'],
  summary: 'Accept one Web Vitals measurement',
  request: { body: { required: true, content: { 'application/json': { schema: RumRequest } } } },
  responses: {
    204: { description: 'Accepted' },
    400: problem('Validation error'),
    413: problem('Body too large'),
  },
});

/** Every JSON API route, for iteration (OpenAPI generation, client tests). */
export const apiRoutes = {
  health: healthRoute,
  deepHealth: deepHealthRoute,
  createUpload: createUploadRoute,
  completeUpload: completeUploadRoute,
  listFiles: listFilesRoute,
  getFile: getFileRoute,
  updateFile: updateFileRoute,
  deleteFile: deleteFileRoute,
  fileEvents: fileEventsRoute,
  stats: statsRoute,
  debugCpu: debugCpuRoute,
  rum: rumRoute,
} as const;
