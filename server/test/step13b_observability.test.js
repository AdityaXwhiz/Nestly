import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PurgeQueueCommand } from '@aws-sdk/client-sqs';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { sqsClient, QUEUE_DEFINITIONS } = await import('../src/infrastructure/sqs/client.js');
const { setupQueues } = await import('../src/infrastructure/sqs/setupQueues.js');
const { usersRepository } = await import('../src/modules/users/repository.js');
const { propertiesRepository } = await import('../src/modules/properties/repository.js');
const { paymentProvider } = await import('../src/infrastructure/payment/index.js');
const { FakePaymentProvider } = await import('../src/infrastructure/payment/fakeProvider.js');
const { env } = await import('../src/config/env.js');
const { registry } = await import('../src/infrastructure/metrics/index.js');
const { startMetricsServer } = await import('../src/infrastructure/metrics/server.js');
const { collectSchedulerGauges } = await import('../src/infrastructure/metrics/collector.js');
const {
  logger,
  addLogSink,
  removeLogSink,
  getRequestId,
  getOriginRequestId,
} = await import('../src/middleware/requestLogger.js');
const { publishOutbox, SqsPublisher } = await import('../src/modules/outbox/publisher.js');
const { createConsumer } = await import('../src/workers/consumer.js');

describe('Step 13B Observability, Metrics & Request-ID Propagation Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdOrderIds = [];
  const createdPaymentIds = [];
  let metricsServer = null;
  let metricsBaseUrl = '';

  const fakeProvider = new FakePaymentProvider();
  const uniqueEmail = (prefix = 'obs') => `${prefix}_${crypto.randomUUID().slice(0, 8)}@example.com`;

  async function createAuthenticatedUser(role = 'CUSTOMER') {
    const email = uniqueEmail(role.toLowerCase());
    const password = 'Password123!';
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
      [email, hash, role],
    );
    const user = rows[0];
    createdUserIds.push(user.id);

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    assert.equal(loginRes.status, 200);
    return { user, token: loginRes.body.accessToken };
  }

  before(async () => {
    paymentProvider.setProvider(fakeProvider);
    await setupQueues();
    // Drain test queues before starting propagation test
    for (const def of Object.values(QUEUE_DEFINITIONS)) {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.url })).catch(() => {});
    }

    metricsServer = startMetricsServer({ port: 0, host: '127.0.0.1', label: 'test' });
    await new Promise((resolve) => {
      if (metricsServer.listening) return resolve();
      metricsServer.once('listening', resolve);
    });
    const addr = metricsServer.address();
    metricsBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (metricsServer) {
      await new Promise((resolve) => metricsServer.close(resolve));
    }

    for (const id of createdPaymentIds) {
      await pool.query('DELETE FROM payments WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of createdOrderIds) {
      await pool.query('DELETE FROM reservations WHERE order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM order_items WHERE order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM saga_instances WHERE order_id = $1', [id]).catch(() => {});
      await pool.query('DELETE FROM orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of createdPropertyIds) {
      await propertiesRepository.deleteById(id).catch(() => {});
    }
    for (const id of createdUserIds) {
      await usersRepository.deleteById(id).catch(() => {});
    }
    for (const def of Object.values(QUEUE_DEFINITIONS)) {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.url })).catch(() => {});
    }

    await pool.end();
    redis.disconnect();
  });

  it('serves Prometheus metrics ONLY on separate metrics port and keeps /metrics 404 on public app (Changes #1 & #10)', async () => {
    // Public Express app must NOT expose /metrics
    const pubRes = await request(app).get('/metrics');
    assert.equal(pubRes.status, 404);

    // Health check should work without creating /healthz label in http metrics
    const healthRes = await request(app).get('/healthz');
    assert.equal(healthRes.status, 200);

    // Dedicated internal metrics server returns expected prom-client output
    const res = await fetch(`${metricsBaseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /nestly_http_requests_total/);
    assert.match(body, /nestly_nodejs_eventloop_lag_seconds/);
    assert.match(body, /nestly_db_pool_connections\{state="total"\}/);
    assert.match(body, /nestly_orders_total\{status="created"\}/);
    assert.match(body, /nestly_payments_total\{status="created"\}/);
    assert.match(body, /nestly_reservations_total\{outcome="held"\}/);

    // /metrics and /healthz must be excluded from HTTP metrics (Change #10)
    assert.doesNotMatch(body, /route="\/metrics"/);
    assert.doesNotMatch(body, /route="\/healthz"/);
  });

  it('collapses unmatched routes to route="UNMATCHED" (bounded label cardinality)', async () => {
    const r1 = await request(app).get(`/no-such-route-${crypto.randomUUID()}`);
    const r2 = await request(app).get(`/another-missing-${crypto.randomUUID()}`);
    assert.equal(r1.status, 404);
    assert.equal(r2.status, 404);

    const text = await registry.metrics();
    assert.match(text, /nestly_http_requests_total\{method="GET",route="UNMATCHED",status_class="4xx"\}/);
    assert.doesNotMatch(text, /no-such-route-/);
    assert.doesNotMatch(text, /another-missing-/);
  });

  it('sanitizes X-Request-Id ([A-Za-z0-9._-]{8,64}) and regenerates invalid IDs (Change #7)', async () => {
    const validId = 'Req_Trace-2026.01';
    const validLogs = [];
    const invalidLogs = [];

    const sinkValid = (entry) => validLogs.push(entry);
    addLogSink(sinkValid);
    try {
      const resValid = await request(app).get('/api/v1/properties').set('X-Request-Id', validId);
      assert.equal(resValid.status, 200);
      assert.equal(resValid.headers['x-request-id'], validId);
    } finally {
      removeLogSink(sinkValid);
    }
    assert.ok(validLogs.some((e) => e.reqId === validId), 'Expected sanitized reqId in Pino log');

    const sinkInvalid = (entry) => invalidLogs.push(entry);
    addLogSink(sinkInvalid);
    try {
      for (const bad of ['short1', 'bad$id!with*chars', 'a'.repeat(65)]) {
        const resBad = await request(app).get('/api/v1/properties').set('X-Request-Id', bad);
        assert.equal(resBad.status, 200);
        assert.notEqual(resBad.headers['x-request-id'], bad);
        assert.match(resBad.headers['x-request-id'], /^[A-Za-z0-9._-]{8,64}$/);
      }
    } finally {
      removeLogSink(sinkInvalid);
    }
    assert.ok(invalidLogs.every((e) => e.reqId !== 'short1' && e.reqId !== 'bad$id!with*chars'));
  });

  it('collector probes postgres and sets nestly_dependency_up', async () => {
    await collectSchedulerGauges();
    const text = await registry.metrics();
    assert.match(text, /nestly_dependency_up\{dependency="postgres"\} 1/);
  });

  it('propagates X-Request-Id & origin_request_id across Checkout -> Payment -> Webhook -> Outbox -> SQS -> Consumer and updates business metrics (Changes #8 & #11)', async () => {
    const host = await createAuthenticatedUser('HOST');
    const customer = await createAuthenticatedUser('CUSTOMER');

    // Host creates & activates a property
    const propRes = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${host.token}`)
      .send({
        title: 'Observability Test Property',
        description: 'Trace propagation property',
        location: 'Jaipur',
        capacity: 6,
        pricing_minor: 50000,
        currency: 'INR',
        status: 'ACTIVE',
      });
    assert.equal(propRes.status, 201);
    const propertyId = propRes.body.property.id;
    createdPropertyIds.push(propertyId);

    // 1. Create order + hold
    const checkoutReqId = `chk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const startIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const endIso = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('X-Request-Id', checkoutReqId)
      .send({
        property_id: propertyId,
        during: { start: startIso, end: endIso },
        guest_count: 2,
        services: [],
      });
    assert.equal(orderRes.status, 201);
    const orderId = orderRes.body.id || orderRes.body.order?.id;
    createdOrderIds.push(orderId);

    const holdRes = await request(app)
      .post(`/api/v1/orders/${orderId}/hold`)
      .set('Authorization', `Bearer ${customer.token}`)
      .set('X-Request-Id', checkoutReqId)
      .set('Idempotency-Key', `obs-hold-${orderId}`);
    assert.equal(holdRes.status, 200);

    // 2. Payment request carries originRequestId
    const payReqId = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const payRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('X-Request-Id', payReqId)
      .set('Idempotency-Key', `obs-pay-${orderId}`)
      .send({ order_id: orderId });
    assert.equal(payRes.status, 202);
    const paymentId = payRes.body.id || payRes.body.payment?.id;
    createdPaymentIds.push(paymentId);
    const { rows: payRows } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    assert.equal(payRows.length, 1);
    const payment = payRows[0];
    assert.equal(payment.origin_request_id, payReqId);

    // 3. Webhook completes payment & writes outbox events under webhookReqId + originRequestId
    const webhookReqId = `whk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const webhookPayload = {
      event_id: `evt_obs_${crypto.randomUUID()}`,
      type: 'payment.succeeded',
      data: {
        reference: payment.provider_reference,
        status: 'SUCCESS',
        amount_minor: payment.amount_minor,
        currency: payment.currency,
      },
    };
    const rawBody = JSON.stringify(webhookPayload);
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const webhookLogs = [];
    const sinkWebhook = (entry) => webhookLogs.push(entry);
    addLogSink(sinkWebhook);
    try {
      const whRes = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Request-Id', webhookReqId)
        .set('x-timestamp', String(timestamp))
        .set('x-signature', `t=${timestamp},v1=${sig}`)
        .set('Content-Type', 'application/json')
        .send(rawBody);
      assert.equal(whRes.status, 200);
    } finally {
      removeLogSink(sinkWebhook);
    }

    assert.ok(
      webhookLogs.some(
        (e) => e.reqId === webhookReqId && e.origin_request_id === payReqId,
      ),
      'Webhook logs must carry both reqId and origin_request_id',
    );

    // Check outbox persisted webhookReqId and origin_request_id
    const { rows: outboxRows } = await pool.query(
      `SELECT id, event_type, request_id, payload FROM outbox
       WHERE aggregate_id = $1 AND event_type = 'order.confirmed'
       ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0].request_id, webhookReqId);
    assert.equal(outboxRows[0].payload.origin_request_id, payReqId);

    // Clear pre-existing unpublished outbox rows unrelated to this order so publish is deterministic
    const targetOutboxId = outboxRows[0].id;

    // 4. Publish outbox to real ElasticMQ and consume inside real createConsumer
    const publisher = new SqsPublisher();
    await publishOutbox({ batchSize: 100, publisher });

    let capturedReqId = null;
    let capturedOriginReqId = null;
    const consumerLogs = [];
    const sinkConsumer = (entry) => consumerLogs.push(entry);
    addLogSink(sinkConsumer);

    const consumer = createConsumer({
      name: 'notifications',
      queueUrl: QUEUE_DEFINITIONS.notifications.url,
      waitTimeSeconds: 1,
      useProcessedEvents: false,
      handler: async (envelope) => {
        if (envelope.eventId === targetOutboxId) {
          capturedReqId = getRequestId();
          capturedOriginReqId = getOriginRequestId();
          logger.info({ eventId: envelope.eventId }, 'Test consumer processed order.confirmed');
        }
      },
    });

    consumer.start();
    try {
      const deadline = Date.now() + 10000;
      while (!capturedReqId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await consumer.stop();
      removeLogSink(sinkConsumer);
    }

    assert.equal(capturedReqId, webhookReqId);
    assert.equal(capturedOriginReqId, payReqId);
    assert.ok(
      consumerLogs.some(
        (e) =>
          e.reqId === webhookReqId &&
          e.origin_request_id === payReqId &&
          e.eventId === targetOutboxId,
      ),
      'Consumer log sink must carry reqId and origin_request_id',
    );

    // 5. Verify business + worker metrics incremented cleanly without high-cardinality IDs
    const metricsRes = await fetch(`${metricsBaseUrl}/metrics`);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /nestly_orders_total\{status="created"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_orders_total\{status="held"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_orders_total\{status="confirmed"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_payments_total\{status="succeeded"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_webhook_events_total\{outcome="processed"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_worker_messages_received_total\{queue="notifications"\}\s+[1-9]/);
    assert.match(metricsText, /nestly_worker_message_age_seconds_count\{queue="notifications"\}\s+[1-9]/);

    // Zero high-cardinality values leaked in metrics output
    assert.ok(!metricsText.includes(orderId), 'Order ID must never appear in metrics labels');
    assert.ok(!metricsText.includes(customer.user.email), 'Email must never appear in metrics labels');
  });
});
