import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

process.env.NODE_ENV = 'test';

const { parseEnv } = await import('../src/config/env.js');
const { buildPgPoolConfig } = await import('../src/infrastructure/postgres.js');
const { buildS3ClientConfig } = await import('../src/infrastructure/s3/client.js');
const { buildSqsClientConfig } = await import('../src/infrastructure/sqs/client.js');
const { createOpenSearchClient } = await import('../src/infrastructure/opensearch/client.js');
const { ensureAliasesExist } = await import('../src/infrastructure/opensearch/setupIndices.js');
const { runInit } = await import('../src/infrastructure/init.js');
const { parseTrustProxy } = await import('../src/app.js');

describe('Step 13D: AWS Readiness Config, SSL CA Bundle, TRUST_PROXY & INIT_TARGET=aws', () => {
  const strongJwt = crypto.randomBytes(32).toString('hex');
  const strongWebhook = crypto.randomBytes(32).toString('hex');

  const awsProdEnv = {
    NODE_ENV: 'production',
    PORT: '3000',
    TRUST_PROXY: '2',
    DATABASE_URL: 'postgresql://nestly:StrongProdPass!99@nestly-pg.cluster-xyz.us-east-1.rds.amazonaws.com:5432/nestly',
    DB_SSL: 'true',
    DB_SSL_CA_PATH: '/etc/ssl/certs/aws-rds-global-bundle.pem',
    REDIS_URL: 'rediss://:RedisAuthTokenStrong!@master.nestly-redis.use1.cache.amazonaws.com:6379',
    JWT_ACCESS_SECRET: strongJwt,
    PAYMENT_WEBHOOK_SECRET: strongWebhook,
    PAYMENT_PROVIDER: 'mock',
    AWS_REGION: 'us-east-1',
    SQS_QUEUE_URL_NOTIFICATIONS: 'https://sqs.us-east-1.amazonaws.com/123456789012/nestly-dev-notifications',
    SQS_QUEUE_URL_PROVIDER_ACTIONS: 'https://sqs.us-east-1.amazonaws.com/123456789012/nestly-dev-provider-actions',
    SQS_QUEUE_URL_ANALYTICS: 'https://sqs.us-east-1.amazonaws.com/123456789012/nestly-dev-analytics',
    SQS_QUEUE_URL_SEARCH_INDEX: 'https://sqs.us-east-1.amazonaws.com/123456789012/nestly-dev-search-index',
    S3_BUCKET: 'nestly-dev-media-123456789012',
    S3_FORCE_PATH_STYLE: 'false',
    MEDIA_PUBLIC_BASE_URL: 'https://d111111abcdef8.cloudfront.net',
    INIT_TARGET: 'aws',
  };

  describe('1. AWS Environment & SDK Config (IAM Roles, No Endpoints, rediss://)', () => {
    it('parses AWS production config without custom endpoints, static AWS keys, or OpenSearch', () => {
      const res = parseEnv(awsProdEnv);
      assert.equal(res.success, true, JSON.stringify(res.error?.issues));
      assert.equal(res.data.DB_SSL, true);
      assert.equal(res.data.DB_SSL_CA_PATH, '/etc/ssl/certs/aws-rds-global-bundle.pem');
      assert.equal(res.data.S3_ENDPOINT, undefined);
      assert.equal(res.data.S3_PUBLIC_ENDPOINT, undefined);
      assert.equal(res.data.SQS_ENDPOINT, undefined);
      assert.equal(res.data.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(res.data.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(res.data.OPENSEARCH_ENDPOINT, null);
      assert.equal(res.data.INIT_TARGET, 'aws');
      assert.equal(res.data.TRUST_PROXY, '2');
    });

    it('defaults DB_SSL to strict boolean false and S3_FORCE_PATH_STYLE to boolean true when omitted', () => {
      const { DB_SSL, S3_FORCE_PATH_STYLE, ...minimalEnv } = awsProdEnv;
      const res = parseEnv(minimalEnv);
      assert.equal(res.success, true, JSON.stringify(res.error?.issues));
      assert.strictEqual(res.data.DB_SSL, false);
      assert.strictEqual(res.data.S3_FORCE_PATH_STYLE, true);
      const poolCfg = buildPgPoolConfig(res.data);
      assert.equal('ssl' in poolCfg, false);
    });

    it('normalizes empty optional endpoint strings cleanly as undefined / disabled', () => {
      const res = parseEnv({
        ...awsProdEnv,
        S3_ENDPOINT: '',
        SQS_ENDPOINT: '',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
        OPENSEARCH_ENDPOINT: '',
      });
      assert.equal(res.success, true, JSON.stringify(res.error?.issues));
      assert.equal(res.data.S3_ENDPOINT, undefined);
      assert.equal(res.data.SQS_ENDPOINT, undefined);
      assert.equal(res.data.OPENSEARCH_ENDPOINT, null);
    });

    it('omits endpoint and static credentials from S3Client and SQSClient configs in AWS mode', () => {
      const parsed = parseEnv(awsProdEnv).data;
      const s3Cfg = buildS3ClientConfig(parsed);
      const sqsCfg = buildSqsClientConfig(parsed);

      assert.equal(s3Cfg.region, 'us-east-1');
      assert.equal(s3Cfg.forcePathStyle, false);
      assert.equal('endpoint' in s3Cfg, false);
      assert.equal('credentials' in s3Cfg, false);

      assert.equal(sqsCfg.region, 'us-east-1');
      assert.equal('endpoint' in sqsCfg, false);
      assert.equal('credentials' in sqsCfg, false);
    });

    it('returns null OpenSearch client when OPENSEARCH_ENDPOINT is disabled/null', async () => {
      const parsed = parseEnv(awsProdEnv).data;
      const client = createOpenSearchClient(parsed.OPENSEARCH_ENDPOINT, parsed.NODE_ENV);
      assert.equal(client, null);

      const aliasRes = await ensureAliasesExist({ client });
      assert.deepEqual(aliasRes, { skipped: true, reason: 'OPENSEARCH_DISABLED' });
    });
  });

  describe('2. RDS Postgres TLS & CA Bundle (Change #2)', () => {
    it('enforces rejectUnauthorized: true and reads DB_SSL_CA_PATH when DB_SSL=true', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestly-ca-'));
      const pemPath = path.join(tmpDir, 'rds-test-ca.pem');
      const fakePem = '-----BEGIN CERTIFICATE-----\nTEST_CA_DATA\n-----END CERTIFICATE-----\n';
      fs.writeFileSync(pemPath, fakePem, 'utf8');

      try {
        const cfg = buildPgPoolConfig({
          DATABASE_URL: awsProdEnv.DATABASE_URL,
          DB_POOL_MAX: 10,
          DB_SSL: true,
          DB_SSL_CA_PATH: pemPath,
        });
        assert.equal(cfg.ssl.rejectUnauthorized, true);
        assert.equal(cfg.ssl.ca, fakePem);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('keeps rejectUnauthorized: true even when DB_SSL_CA_PATH is omitted', () => {
      const cfg = buildPgPoolConfig({
        DATABASE_URL: awsProdEnv.DATABASE_URL,
        DB_POOL_MAX: 10,
        DB_SSL: true,
      });
      assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
    });
  });

  describe('3. INIT_TARGET=aws Mode (Change #3)', () => {
    it('runs migrations ONLY (no setupQueues, no setupStorage, no OpenSearch) when OpenSearch disabled', async () => {
      const calls = [];
      await runInit({
        target: 'aws',
        openSearchEnabled: false,
        osClient: null,
        migrationsFn: async () => calls.push('migrations'),
        setupQueuesFn: async () => calls.push('queues'),
        setupStorageFn: async () => calls.push('storage'),
        ensureAliasesFn: async () => calls.push('aliases'),
      });
      assert.deepEqual(calls, ['migrations']);
    });

    it('runs migrations + ensureAliasesExist when INIT_TARGET=aws and OpenSearch enabled (never create queues/buckets)', async () => {
      const calls = [];
      await runInit({
        target: 'aws',
        openSearchEnabled: true,
        osClient: { close: async () => calls.push('close_os') },
        migrationsFn: async () => calls.push('migrations'),
        setupQueuesFn: async () => calls.push('queues'),
        setupStorageFn: async () => calls.push('storage'),
        ensureAliasesFn: async () => calls.push('aliases'),
      });
      assert.deepEqual(calls, ['migrations', 'aliases', 'close_os']);
    });
  });

  describe('4. TRUST_PROXY=2 for CloudFront -> ALB -> Express (Change #8)', () => {
    it('resolves original viewer IP through 2 proxy hops (CloudFront + ALB)', async () => {
      assert.equal(parseTrustProxy('2'), 2);

      const testApp = express();
      testApp.set('trust proxy', parseTrustProxy('2'));
      testApp.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));

      const server = http.createServer(testApp);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();

      try {
        // Leftmost spoofed IP ignored; client (203.0.113.50) behind CloudFront (198.51.100.10) -> ALB (127.0.0.1)
        const res = await fetch(`http://127.0.0.1:${port}/ip`, {
          headers: {
            'X-Forwarded-For': '10.9.9.9, 203.0.113.50, 198.51.100.10',
          },
        });
        const body = await res.json();
        assert.equal(body.ip, '203.0.113.50');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
