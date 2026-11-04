import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { apiRoutes, securitySchemes } from '../src';

describe('routes', () => {
  it('generate a valid OpenAPI document', () => {
    const app = new OpenAPIHono();
    app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', securitySchemes.bearerAuth);
    app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', securitySchemes.cookieAuth);
    for (const route of Object.values(apiRoutes)) {
      // The handler is irrelevant here; only the definitions are exercised.
      app.openapi(route, (() => new Response()) as never);
    }
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '0' } });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      '/api/debug/cpu',
      '/api/debug/purge/{id}',
      '/api/files',
      '/api/files/{id}',
      '/api/files/{id}/events',
      '/api/health',
      '/api/health/deep',
      '/api/rum',
      '/api/stats',
      '/api/uploads',
      '/api/uploads/{id}/complete',
    ]);
    expect(doc.paths?.['/api/files/{id}']).toHaveProperty('patch');
    expect(doc.paths?.['/api/files/{id}']).toHaveProperty('delete');
    expect(doc.paths?.['/api/uploads']?.post?.responses?.['413']).toBeDefined();
    // Huge sizes must reach the handler (413), yet the document keeps promising an integer.
    expect(doc.components?.schemas?.CreateUploadRequest).toMatchObject({
      properties: { bytes: { type: 'integer' } },
    });
  });
});
