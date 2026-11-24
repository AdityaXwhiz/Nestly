import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

process.env.NODE_ENV = 'test';

const { parseEnv } = await import('../src/config/env.js');
const { parseTrustProxy } = await import('../src/app.js');
const { createGracefulShutdown } = await import('../src/shutdown.js');
const { s3Service } = await import('../src/infrastructure/s3/s3Service.js');
const { S3Client } = await import('@aws-sdk/client-s3');

describe('Step 13A: Production Hardening, Dual S3 Client & Graceful Shutdown', () => {
  const strongJwt = crypto.randomBytes(32).toString('hex');
  const strongWebhook = crypto.randomBytes(32).toString('hex');

  const validProdBaseEnv = {
    NODE_ENV: 'production',
    PORT: '3000',
    TRUST_PROXY: '1',
    DATABASE_URL: 'postgresql://nestly:prodpass123@postgres:5432/nestly',
    REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: strongJwt,
    PAYMENT_WEBHOOK_SECRET: strongWebhook,
    PAYMENT_PROVIDER: 'mock',
  };

  describe('1. Production Startup Secret & Hook Checks', () => {
    it('refuses to start in production with weak or default JWT_ACCESS_SECRET', () => {
      const resDefault = parseEnv({
        ...validProdBaseEnv,
        JWT_ACCESS_SECRET: 'replace_with_a_secure_random_string_at_least_32_chars',
      });
      assert.equal(resDefault.success, false);

      const resLowEntropy = parseEnv({
        ...validProdBaseEnv,
        JWT_ACCESS_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      assert.equal(resLowEntropy.success, false);
    });

    it('refuses to start in production with weak PAYMENT_WEBHOOK_SECRET or identical secrets', () => {
      const resWeak = parseEnv({
        ...validProdBaseEnv,
        PAYMENT_WEBHOOK_SECRET: 'development_webhook_secret_key_32_chars',
      });
      assert.equal(resWeak.success, false);

      const resSame = parseEnv({
        ...validProdBaseEnv,
        PAYMENT_WEBHOOK_SECRET: strongJwt,
      });
      assert.equal(resSame.success, false);
    });

    it('refuses to start in production when PAYMENT_PROVIDER is omitted (mock cannot run implicitly)', () => {
      const { PAYMENT_PROVIDER, ...withoutProvider } = validProdBaseEnv;
      const res = parseEnv(withoutProvider);
      assert.equal(res.success, false);
    });

    it('refuses to start in production if ENABLE_TEST_HOOKS=true', () => {
      const res = parseEnv({
        ...validProdBaseEnv,
        ENABLE_TEST_HOOKS: 'true',
      });
      assert.equal(res.success, false);
    });

    it('allows production startup when strong secrets and explicit PAYMENT_PROVIDER=mock are set', () => {
      const res = parseEnv(validProdBaseEnv);
      assert.equal(res.success, true, JSON.stringify(res.error?.issues));
      assert.equal(res.data.PAYMENT_PROVIDER, 'mock');
      assert.equal(res.data.TRUST_PROXY, '1');
    });
  });

  describe('2. TRUST_PROXY Configuration', () => {
    it('parses TRUST_PROXY env values properly for Express', () => {
      assert.equal(parseTrustProxy('false'), false);
      assert.equal(parseTrustProxy('true'), true);
      assert.equal(parseTrustProxy('1'), 1);
      assert.equal(parseTrustProxy('loopback'), 'loopback');
      assert.deepEqual(parseTrustProxy('127.0.0.1, 10.0.0.0/8'), ['127.0.0.1', '10.0.0.0/8']);
    });

    it('honors X-Forwarded-For only when trust proxy is enabled', async () => {
      const testApp = express();
      testApp.set('trust proxy', parseTrustProxy('1'));
      testApp.get('/ip', (req, res) => res.json({ ip: req.ip }));

      const server = http.createServer(testApp);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/ip`, {
          headers: { 'X-Forwarded-For': '203.0.113.42' },
        });
        const body = await res.json();
        assert.equal(body.ip, '203.0.113.42');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  describe('3. Dual S3 Client Presigning vs Internal Endpoint (Change #1)', () => {
    it('presigns upload URLs using the public S3 client endpoint host', async () => {
      const publicClient = new S3Client({
        region: 'us-east-1',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        credentials: { accessKeyId: 'testkey', secretAccessKey: 'testsecret' },
      });

      const signedUrl = await s3Service.createPresignedUploadUrl({
        key: 'uploads/pending/prop-1/img-1.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        client: publicClient,
        bucket: 'nestly-media',
      });

      const parsed = new URL(signedUrl);
      assert.equal(parsed.origin, 'http://localhost:9000');
      assert.ok(parsed.pathname.includes('nestly-media/uploads/pending/prop-1/img-1.jpg'));
    });
  });

  describe('4. Graceful Shutdown Draining (Change #3)', () => {
    it('stops accepting new connections, drains in-flight requests, closes pg pool & redis, and exits 0', async () => {
      const testApp = express();
      testApp.locals.isShuttingDown = false;

      let requestStarted;
      const startedPromise = new Promise((r) => {
        requestStarted = r;
      });

      testApp.get('/slow', async (_req, res) => {
        requestStarted();
        await new Promise((r) => setTimeout(r, 150));
        res.status(200).json({ ok: true });
      });

      const server = http.createServer(testApp);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();

      let poolEnded = false;
      let redisQuit = false;
      let exitCode = null;
      let exitDone;
      const exitedPromise = new Promise((r) => {
        exitDone = r;
      });

      const mockPool = {
        end: async () => {
          poolEnded = true;
        },
      };
      const mockRedis = {
        status: 'ready',
        quit: async () => {
          redisQuit = true;
        },
      };
      const noopLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      const shutdown = createGracefulShutdown({
        server,
        app: testApp,
        pool: mockPool,
        redis: mockRedis,
        logger: noopLogger,
        timeoutMs: 20000,
        onExit: (code) => {
          exitCode = code;
          exitDone();
        },
      });

      // Launch in-flight request
      const inFlightFetch = fetch(`http://127.0.0.1:${port}/slow`);
      await startedPromise;

      // Send SIGTERM while /slow is still in flight
      shutdown('SIGTERM');
      assert.equal(testApp.locals.isShuttingDown, true);

      // In-flight request MUST succeed with 200 before process exits
      const res = await inFlightFetch;
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);

      await exitedPromise;
      assert.equal(poolEnded, true);
      assert.equal(redisQuit, true);
      assert.equal(exitCode, 0);
    });
  });
});
