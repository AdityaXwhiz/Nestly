import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');

describe('CORS Allow-List Middleware', () => {
  const allowedOrigin = 'http://localhost:5173';
  const disallowedOrigin = 'http://evil.com';

  describe('Preflight OPTIONS requests', () => {
    it('allows preflight OPTIONS from allowed origin with configured headers', async () => {
      const res = await request(app)
        .options('/api/v1/search/properties')
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'Authorization, Content-Type, Idempotency-Key');

      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], allowedOrigin);

      // Verify allowed headers
      const allowHeaders = res.headers['access-control-allow-headers'];
      assert.ok(allowHeaders, 'Expected access-control-allow-headers header');
      assert.ok(allowHeaders.includes('Authorization'));
      assert.ok(allowHeaders.includes('Content-Type'));
      assert.ok(allowHeaders.includes('Idempotency-Key'));

      // Verify exposed headers
      const exposeHeaders = res.headers['access-control-expose-headers'];
      assert.ok(exposeHeaders, 'Expected access-control-expose-headers header');
      assert.ok(exposeHeaders.includes('X-Request-Id'));
      assert.ok(exposeHeaders.includes('Retry-After'));

      // Verify no credentials header per Change #7
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
    });

    it('rejects preflight OPTIONS from disallowed origin by omitting allow-origin', async () => {
      const res = await request(app)
        .options('/api/v1/search/properties')
        .set('Origin', disallowedOrigin)
        .set('Access-Control-Request-Method', 'GET');

      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  });

  describe('Actual requests (GET)', () => {
    it('sets Access-Control-Allow-Origin for allowed origin', async () => {
      const res = await request(app)
        .get('/healthz')
        .set('Origin', allowedOrigin);

      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], allowedOrigin);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
    });

    it('omits Access-Control-Allow-Origin for disallowed origin', async () => {
      const res = await request(app)
        .get('/healthz')
        .set('Origin', disallowedOrigin);

      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });

    it('allows requests with no Origin header (direct / server-to-server / curl)', async () => {
      const res = await request(app).get('/healthz');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  });
});
